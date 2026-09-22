// Limit orders on MomoSwap bonding-curve tokens — the part the aggregator does not build.
//
// Before graduation a holding is `UserPosition.shares` on the launchpad, not an SPL balance, so
// these two shapes are their own thing. Cookiebox's Trade page builds them itself, and so do we —
// from the same primitives, checked against the accounts in hand rather than trusted. (Since
// 2026-09-22 `POST /limit-orders/place-tx` also builds them, via `kind: "curve-buy"|"curve-sell"`
// and a `curvePool`; we keep building locally because the pre-sign verifier below already covers
// these shapes, and a local build is one less party between the user's intent and their signature.)
//
//   BUY   COOK → shares.  An ordinary escrow order of kind `ORDER_KIND_CURVE_BUY` whose payout
//         account is our `UserPosition` PDA on the pinned pool. The keeper buys the shares owed
//         with `buy_for(beneficiary = us)` and the program settles on the shares DELTA. Cancel and
//         expiry work exactly as for any other order (the COOK is in the reserve). Because the
//         keeper buys INTO our wallet, the launchpad wants our one-time `enable_buy_for` opt-in;
//         it rides along on the first order when missing.
//   SELL  shares → COOK.  Nothing can be escrowed, so the order IS a launchpad `SaleAuthorization`
//         we sign: the keeper (`sell_authorized`) may sell up to `shares` at or above our floor,
//         paying our pinned wCOOK account, until the expiry. The shares stay spendable — selling
//         them elsewhere silently makes the order unfillable. Cancelling is `revoke_position_sale`
//         (see `cancelLimitOrder`).
//
// Both paths reuse the plain flow's price maths, market check and signing seam, and the buy is run
// through the very verifier the aggregator builds are — our own transaction gets no free pass.

import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchorPkg, { type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import limitOrderIdl from "../idl/limit_order.json" with { type: "json" };
import { COOK_MINT, DEFAULT_SLIPPAGE_BPS, PROGRAM_IDS, explorerTxUrl } from "./config";
import { quoteAgg } from "./cookiebox";
import { CookieMcpError } from "./errors";
import { rawToUi, uiToRaw } from "./format";
import { fetchPoolByMint, fetchPosition, type LaunchpadPool } from "./launchpad/api";
import { poolPhase } from "./launchpad";
import { userPositionPda } from "./launchpad/positions";
import {
  DEFAULT_EXPIRY_SECONDS,
  ENABLE_BUY_FOR_DISCRIMINATOR,
  LIMIT_ORDER_PROGRAM_ID,
  ORDER_KIND_CURVE_BUY,
  type LimitOrderKind,
  type PlaceLimitOrderResult,
  assertPlaceTxTrustworthy,
  buyOptinPda,
  expiryFromSeconds,
  fetchLimitOrderFees,
  fillsImmediately,
  makerNetOut,
  normalizePrice,
  orderPda,
  pctFromMarket,
  placeLimitOrder,
  priceFromAmounts,
  reservePda,
  simulateSignSendConfirm,
  takingAmountForPrice,
} from "./limitOrders";
import { getConnection } from "./rpc";
import { resolveMeta } from "./trade";
import { requireSigner } from "./wallet";

// --- Constants ---------------------------------------------------------------------------------------

/**
 * The Cookiebox keeper. Compiled into the limit-order program as `STOP_KEEPER`
 * (`programs/limit-order/src/constants.rs`) and the delegate every curve sell on cookiebox.app is
 * written for. A sale authorization names its delegate, so this is who may fill ours — not a
 * wallet that can take anything: `sell_authorized` pays the payout account pinned by our signature.
 */
export const LIMIT_ORDER_KEEPER = new PublicKey("9shiCAJ6ZtpKkoNA5WtK81vZFZa9LSq1JX9SBxSWw8to");
/** The launchpad's `MAX_SALE_AUTH_DURATION_SECS`: an authorization may not outlive 30 days. */
export const MAX_SALE_AUTH_SECONDS = 30 * 24 * 60 * 60;
/** `sha256("global:approve_position_sale")[..8]` — pinned by a test. */
export const APPROVE_POSITION_SALE_DISCRIMINATOR = Uint8Array.from([
  219, 150, 157, 19, 219, 160, 143, 54,
]);
/** Wrap shortfall + opt-in + placement, or ATA create + approve: both well under this. */
const CURVE_PLACE_COMPUTE_UNITS = 200_000;

const ixCoder = new anchorPkg.BorshInstructionCoder(limitOrderIdl as Idl);

// --- PDAs (golden-tested against cookiebox's derivations) ------------------------------------------

export function saleAuthPda(
  pool: PublicKey,
  owner: PublicKey,
  delegate: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sale_auth"), pool.toBuffer(), owner.toBuffer(), delegate.toBuffer()],
    programId,
  )[0];
}

export function poolAuthorityPda(pool: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), pool.toBuffer()],
    programId,
  )[0];
}

// --- Instruction builders (pure — tested) -------------------------------------------------------------

function u64Le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function i64Le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
}

/** `approve_position_sale(delegate, shares, min_payment_out, expiry_ts)` — placing a curve SELL. */
export function buildApprovePositionSaleIx(args: {
  programId: PublicKey;
  owner: PublicKey;
  pool: PublicKey;
  paymentMint: PublicKey;
  delegate: PublicKey;
  shares: bigint;
  /** The floor for the WHOLE `shares`; partial fills are pro-rated (rounded up) by the program. */
  minPaymentOut: bigint;
  expiryTs: number;
  /** Where the proceeds land, pinned by our signature. The program refuses any pool-owned vault. */
  payoutAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.pool, isSigner: false, isWritable: false },
      { pubkey: poolAuthorityPda(args.pool, args.programId), isSigner: false, isWritable: false },
      {
        pubkey: saleAuthPda(args.pool, args.owner, args.delegate, args.programId),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: args.payoutAccount, isSigner: false, isWritable: false },
      { pubkey: args.paymentMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(APPROVE_POSITION_SALE_DISCRIMINATOR),
      args.delegate.toBuffer(),
      u64Le(args.shares),
      u64Le(args.minPaymentOut),
      i64Le(BigInt(args.expiryTs)),
    ]),
  });
}

/** `enable_buy_for()` — free, revocable consent to be bought for. `init`, so only when missing. */
export function buildEnableBuyForIx(args: {
  programId: PublicKey;
  owner: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: buyOptinPda(args.owner, args.programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ENABLE_BUY_FOR_DISCRIMINATOR),
  });
}

/**
 * `initialize_order` of kind `ORDER_KIND_CURVE_BUY`: the same accounts as a plain placement, the
 * payout pinned to our `UserPosition` on `curvePool`, and `curvePool` as the trailing optional.
 */
export function buildCurveBuyPlaceIx(args: {
  maker: PublicKey;
  base: PublicKey;
  curvePool: PublicKey;
  launchpadProgramId: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  makingAmount: bigint;
  takingAmount: bigint;
  expiredAt: number | null;
  refundNative: boolean;
}): TransactionInstruction {
  const order = orderPda(args.base);
  const data = ixCoder.encode("initialize_order", {
    making_amount: new BN(args.makingAmount.toString()),
    taking_amount: new BN(args.takingAmount.toString()),
    expired_at: args.expiredAt == null ? null : new BN(args.expiredAt),
    kind: ORDER_KIND_CURVE_BUY,
    refund_native: args.refundNative,
    trigger_taking_amount: new BN(0),
  });
  const k = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  return new TransactionInstruction({
    programId: LIMIT_ORDER_PROGRAM_ID,
    keys: [
      k(args.base, true, true),
      k(args.maker, true, true),
      k(order, true),
      k(reservePda(order), true),
      k(getAssociatedTokenAddressSync(args.inputMint, args.maker, true), true),
      k(userPositionPda(args.curvePool, args.maker, args.launchpadProgramId)),
      k(args.inputMint),
      k(args.outputMint),
      k(TOKEN_PROGRAM_ID),
      k(TOKEN_PROGRAM_ID),
      k(SystemProgram.programId),
      k(args.curvePool),
    ],
    data,
  });
}

// --- Pure decisions (tested) ------------------------------------------------------------------------------

export type CurveSide = "buy" | "sell";

/**
 * Which side of a curve a COOK ⇄ token pair is, given the pool's mints. null when the pair does
 * not touch the curve token directly (a via-COOK or token⇄token order is not a curve order).
 */
export function curveSideFor(
  inputMint: string,
  outputMint: string,
  pool: Pick<LaunchpadPool, "tokenMint" | "paymentMint">,
): CurveSide | null {
  if (inputMint === pool.paymentMint && outputMint === pool.tokenMint) return "buy";
  if (inputMint === pool.tokenMint && outputMint === pool.paymentMint) return "sell";
  return null;
}

/**
 * When a curve sell authorization really stops being fillable.
 *
 * Three constants meet here and only one binds. `approve_position_sale` caps the expiry at 30 days
 * (`MAX_SALE_AUTH_SECONDS`) and **never reads the pool**; `sell_authorized` refuses once
 * `now > pool.end_ts`; and a launch runs at most **7 days** (`MAX_DURATION_SECS`). So the 30-day cap
 * can never bind, and an expiry past the sale's end mints an authorization that looks alive in
 * `get_limit_orders` — future expiry, shares in hand — and can never fill, with its rent locked
 * until the maker revokes it. The default of one week is already past the end of most live sales.
 *
 * Hence `saleEndTs` clamps the result. It also removes a boundary: asking for exactly 30 days is
 * validated against THIS clock and enforced against the validator's, and fails on the drift with
 * `InvalidSaleAuthDuration`.
 */
export function saleExpiryFromSeconds(
  expiresInSeconds: number | undefined,
  now = Math.floor(Date.now() / 1000),
  saleEndTs?: number,
): number {
  const s = expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  if (!Number.isInteger(s) || s <= 0) {
    throw new CookieMcpError(
      "a curve sell cannot be good-til-cancelled",
      `the launchpad caps a sale authorization at 30 days; pass expiresInSeconds between 1 and ${MAX_SALE_AUTH_SECONDS}`,
    );
  }
  if (s > MAX_SALE_AUTH_SECONDS) {
    throw new CookieMcpError(
      "expiresInSeconds is more than 30 days",
      `the launchpad caps a sale authorization at ${MAX_SALE_AUTH_SECONDS} seconds`,
    );
  }
  const asked = now + s;
  return saleEndTs && saleEndTs > 0 ? Math.min(asked, saleEndTs) : asked;
}

/**
 * The pool limits a keeper fill must clear, or the order can never fill. `minBuy` bounds the
 * payment of ONE buy; `maxBuyPerWallet` bounds what one wallet may put in over the launch.
 */
export function assertCurveBuyWithinPoolLimits(
  pool: Pick<LaunchpadPool, "minBuy" | "maxBuyPerWallet" | "symbol">,
  makingAmount: bigint,
  alreadyPaidIn: bigint,
): void {
  const minBuy = BigInt(pool.minBuy || "0");
  if (minBuy > 0n && makingAmount < minBuy) {
    throw new CookieMcpError(
      `the order is below the pool's minimum buy of ${rawToUi(minBuy, 9)} COOK, so the keeper could never fill it`,
      "raise the amount",
    );
  }
  const maxBuy = BigInt(pool.maxBuyPerWallet || "0");
  if (maxBuy > 0n && alreadyPaidIn + makingAmount > maxBuy) {
    throw new CookieMcpError(
      `the order would take this wallet past the pool's ${rawToUi(maxBuy, 9)} COOK per-wallet cap on ${pool.symbol} (${rawToUi(alreadyPaidIn, 9)} already paid in), so a fill would revert`,
      "lower the amount",
    );
  }
}

// --- Detection --------------------------------------------------------------------------------------------

export interface CurvePair {
  side: CurveSide;
  pool: LaunchpadPool;
  programId: PublicKey;
}

/**
 * Is this a direct COOK ⇄ live-curve pair? Exactly one leg must be COOK; the other is looked up
 * on the launchpad. A graduated (or otherwise not live) pool returns null so the ordinary router
 * path handles it — a graduated token has a real market, an ended one has nothing to fill from.
 */
export async function detectCurvePair(
  inputMint: string,
  outputMint: string,
): Promise<CurvePair | null> {
  const cookIn = inputMint === COOK_MINT;
  const cookOut = outputMint === COOK_MINT;
  if (cookIn === cookOut) return null;
  const other = cookIn ? outputMint : inputMint;
  let pool: LaunchpadPool;
  try {
    pool = (await fetchPoolByMint(other)).pool;
  } catch {
    return null; // not a launchpad token
  }
  if (poolPhase(pool, Math.floor(Date.now() / 1000)) !== "live") return null;
  const side = curveSideFor(inputMint, outputMint, pool);
  if (!side) return null;
  return { side, pool, programId: new PublicKey(PROGRAM_IDS.momoswapLaunchpad) };
}

// --- Entry point --------------------------------------------------------------------------------------------

export interface PlaceOrderArgs {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  price: string | number;
  kind?: LimitOrderKind;
  expiresInSeconds?: number;
  floorPrice?: string | number;
  wrapSol?: boolean;
  unwrapSol?: boolean;
  skipMarketCheck?: boolean;
}

/** `place_limit_order`: a curve pair takes the curve path, everything else the aggregator's. */
export async function placeOrder(args: PlaceOrderArgs): Promise<PlaceLimitOrderResult> {
  const curve = await detectCurvePair(args.inputMint, args.outputMint);
  if (!curve) return placeLimitOrder(args);
  if ((args.kind ?? "limit") !== "limit" || args.floorPrice !== undefined) {
    throw new CookieMcpError(
      "a bonding-curve pair only takes plain limit orders",
      "stop orders are not offered on a curve; omit kind / floorPrice",
    );
  }
  return curve.side === "buy" ? placeCurveBuy(args, curve) : placeCurveSell(args, curve);
}

async function verifyPoolOwnedByLaunchpad(pool: PublicKey, programId: PublicKey): Promise<void> {
  const info = await getConnection().getAccountInfo(pool, "confirmed");
  if (!info)
    throw new CookieMcpError(
      "the launchpad pool account does not exist on chain",
      "check the mint",
    );
  if (!info.owner.equals(programId)) {
    throw new CookieMcpError(
      `the pool is owned by ${info.owner.toBase58()}, not the MomoSwap launchpad`,
      "refusing to pin an account of an unknown program as the curve pool",
    );
  }
}

async function marketCheck(
  inputMint: string,
  outputMint: string,
  makingAmount: bigint,
  priced: bigint,
  inDec: number,
  outDec: number,
  outSym: string | null,
  owner: PublicKey,
): Promise<PlaceLimitOrderResult["market"]> {
  const route = await quoteAgg(
    inputMint,
    outputMint,
    makingAmount.toString(),
    DEFAULT_SLIPPAGE_BPS,
    owner.toBase58(),
  );
  if (!route) {
    throw new CookieMcpError(
      "the aggregator cannot quote this curve right now, so the keeper could not fill this order",
      "retry shortly, or pass skipMarketCheck: true to place it anyway",
    );
  }
  const marketOut = BigInt(route.grossOutAmount ?? route.totalOutAmount);
  const rate = priceFromAmounts(makingAmount, marketOut, inDec, outDec);
  const limitRate = priceFromAmounts(makingAmount, priced, inDec, outDec);
  if (fillsImmediately("limit", priced, marketOut)) {
    throw new CookieMcpError(
      `the curve already pays ${rawToUi(marketOut, outDec)} ${outSym ?? "output"} for this amount — at or above this limit, so it would fill immediately at a worse rate than a swap`,
      "a limit must sit ABOVE the current rate; use launchpad_buy / launchpad_sell to trade now, or move the price. Pass skipMarketCheck: true to place it anyway",
    );
  }
  return {
    rate: rate ?? NaN,
    pctFromMarket: rate != null && limitRate != null ? pctFromMarket(limitRate, rate) : null,
  };
}

function parseAmount(amount: string | number, dec: number, what: string): bigint {
  let raw: bigint;
  try {
    raw = uiToRaw(amount, dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${amount}"`,
      `amount is a UI amount of ${what} (max ${dec} decimals)`,
    );
  }
  if (raw <= 0n)
    throw new CookieMcpError("amount must be greater than 0", "pass a positive amount");
  return raw;
}

// --- BUY: COOK → curve shares, escrowed ------------------------------------------------------------------

async function placeCurveBuy(
  args: PlaceOrderArgs,
  curve: CurvePair,
): Promise<PlaceLimitOrderResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const pool = new PublicKey(curve.pool.pubkey);
  const inputMint = new PublicKey(args.inputMint);
  const outputMint = new PublicKey(args.outputMint);

  const { input, output } = await resolveMeta(args.inputMint, args.outputMint);
  const makingAmount = parseAmount(args.amount, input.dec, "COOK");
  const price = normalizePrice(args.price);
  const priced = takingAmountForPrice(makingAmount, price, input.dec, output.dec);
  if (!priced)
    throw new CookieMcpError(
      "price rounds to zero shares for this amount",
      "raise the price or the amount",
    );
  const expiredAt = expiryFromSeconds(args.expiresInSeconds);
  if (args.wrapSol === false) {
    // Allowed: pay from wCOOK already held. The refund then goes back to the wCOOK account.
  }
  const refundNative = args.wrapSol !== false;

  const [position, fees] = await Promise.all([
    fetchPosition(curve.pool.pubkey, owner.toBase58()).catch(() => null),
    fetchLimitOrderFees(),
    verifyPoolOwnedByLaunchpad(pool, curve.programId),
  ]);
  assertCurveBuyWithinPoolLimits(curve.pool, makingAmount, BigInt(position?.totalPaymentIn ?? "0"));

  const market = args.skipMarketCheck
    ? null
    : await marketCheck(
        args.inputMint,
        args.outputMint,
        makingAmount,
        priced,
        input.dec,
        output.dec,
        output.sym,
        owner,
      );

  // Wrap only the shortfall, so wCOOK already held is spent first and nothing is re-wrapped.
  const wcookAta = getAssociatedTokenAddressSync(inputMint, owner, true);
  const held = await conn
    .getTokenAccountBalance(wcookAta, "confirmed")
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  const shortfall = makingAmount > held ? makingAmount - held : 0n;
  const wrapIxs: TransactionInstruction[] = [];
  if (shortfall > 0n) {
    if (args.wrapSol === false) {
      throw new CookieMcpError(
        `wrapSol: false but only ${rawToUi(held, 9)} wCOOK is held against a ${rawToUi(makingAmount, 9)} COOK order`,
        "omit wrapSol to wrap the shortfall in the same transaction",
      );
    }
    wrapIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(owner, wcookAta, owner, inputMint),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wcookAta, lamports: shortfall }),
      createSyncNativeInstruction(wcookAta),
    );
  }
  // `enable_buy_for` is `init`, not `init_if_needed`: include it only when the PDA is missing.
  const needsOptin =
    (await conn.getAccountInfo(buyOptinPda(owner, curve.programId), "confirmed")) == null;

  const base = Keypair.generate();
  const order = orderPda(base.publicKey);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CURVE_PLACE_COMPUTE_UNITS }),
    ...wrapIxs,
    ...(needsOptin ? [buildEnableBuyForIx({ programId: curve.programId, owner })] : []),
    buildCurveBuyPlaceIx({
      maker: owner,
      base: base.publicKey,
      curvePool: pool,
      launchpadProgramId: curve.programId,
      inputMint,
      outputMint,
      makingAmount,
      takingAmount: priced,
      expiredAt,
      refundNative,
    }),
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(),
  );
  tx.sign([base]); // the throwaway order seed, never needed again

  // Our own build goes through the same verifier as an aggregator build — no self-trust.
  assertPlaceTxTrustworthy(tx, {
    owner,
    inputMint,
    outputMint,
    makingAmount,
    takingAmount: priced,
    triggerTakingAmount: 0n,
    kind: "curve-buy",
    curve: { pool, programId: curve.programId },
    expiredAt,
    refundNative,
    payoutNative: false,
    order,
  });

  const { signature } = await simulateSignSendConfirm(
    tx,
    signer,
    { blockhash, lastValidBlockHeight },
    "curve limit-order placement",
    {
      kind: "curve-buy",
      pool: pool.toBase58(),
      amount: String(args.amount),
      order: order.toBase58(),
    },
  );
  const feeBps = fees?.makerFeeBps ?? 0;
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: order.toBase58(),
    kind: "curve-buy",
    curvePool: pool.toBase58(),
    escrowed: true,
    input: { mint: args.inputMint, symbol: input.sym, amount: rawToUi(makingAmount, input.dec) },
    output: {
      mint: args.outputMint,
      symbol: output.sym ?? curve.pool.symbol,
      atPrice: rawToUi(priced, output.dec),
      netAfterFee: rawToUi(makerNetOut(priced, feeBps), output.dec),
    },
    price,
    makerFeeBps: feeBps,
    market,
    expiresAt: expiredAt == null ? null : new Date(expiredAt * 1000).toISOString(),
    payoutNative: false,
    refundNative,
    wrappedCook: rawToUi(shortfall, 9),
    note:
      `the COOK is escrowed; once the curve sells ${curve.pool.symbol} at this price the keeper buys the shares into your launchpad position (minus the maker fee, taken in shares) — they show in get_launchpad_positions, not as SPL tokens` +
      (needsOptin ? ". This placement also enabled buy-for on your wallet (free, one-time)" : "") +
      ". Cancel any time with cancel_limit_order; an expired order must also be cancelled to get the COOK back.",
  };
}

// --- SELL: curve shares → COOK, a sale authorization -------------------------------------------------------

async function placeCurveSell(
  args: PlaceOrderArgs,
  curve: CurvePair,
): Promise<PlaceLimitOrderResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const pool = new PublicKey(curve.pool.pubkey);
  const paymentMint = new PublicKey(curve.pool.paymentMint);

  const { input, output } = await resolveMeta(args.inputMint, args.outputMint);
  const shares = parseAmount(args.amount, input.dec, `${curve.pool.symbol} shares`);
  const price = normalizePrice(args.price);
  const minPaymentOut = takingAmountForPrice(shares, price, input.dec, output.dec);
  if (!minPaymentOut)
    throw new CookieMcpError(
      "price rounds to zero COOK for this amount",
      "raise the price or the amount",
    );
  const expiryTs = saleExpiryFromSeconds(
    args.expiresInSeconds,
    Math.floor(Date.now() / 1000),
    curve.pool.endTs,
  );
  if (args.unwrapSol === true) {
    throw new CookieMcpError(
      "a curve sell pays wCOOK to your token account; the launchpad cannot unwrap inside the fill",
      "omit unwrapSol — use trade to unwrap later if you want native COOK",
    );
  }

  const [position] = await Promise.all([
    fetchPosition(curve.pool.pubkey, owner.toBase58()).catch(() => null),
    verifyPoolOwnedByLaunchpad(pool, curve.programId),
  ]);
  const heldShares = BigInt(position?.shares ?? "0");
  if (heldShares <= 0n) {
    throw new CookieMcpError(
      `you have no ${curve.pool.symbol} curve position`,
      "a curve sell can only cover shares bought on the bonding curve (launchpad_buy or a filled curve buy order)",
    );
  }
  if (shares > heldShares) {
    throw new CookieMcpError(
      `you hold ${rawToUi(heldShares, input.dec)} ${curve.pool.symbol} shares, less than the ${rawToUi(shares, input.dec)} requested`,
      "lower the amount",
    );
  }
  const authAddr = saleAuthPda(pool, owner, LIMIT_ORDER_KEEPER, curve.programId);
  if ((await conn.getAccountInfo(authAddr, "confirmed")) != null) {
    throw new CookieMcpError(
      `you already have a curve sell on ${curve.pool.symbol} (${authAddr.toBase58()}) — one per pool`,
      "cancel it with cancel_limit_order first, then place the new one",
    );
  }

  const market = args.skipMarketCheck
    ? null
    : await marketCheck(
        args.inputMint,
        args.outputMint,
        shares,
        minPaymentOut,
        input.dec,
        output.dec,
        output.sym,
        owner,
      );

  // The payout is pinned to OUR wCOOK account; the launchpad refuses a pool vault and the keeper
  // cannot redirect it. `approve_position_sale` requires it to exist, hence the idempotent create.
  const payout = getAssociatedTokenAddressSync(paymentMint, owner, true, TOKEN_PROGRAM_ID);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CURVE_PLACE_COMPUTE_UNITS }),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      payout,
      owner,
      paymentMint,
      TOKEN_PROGRAM_ID,
    ),
    buildApprovePositionSaleIx({
      programId: curve.programId,
      owner,
      pool,
      paymentMint,
      delegate: LIMIT_ORDER_KEEPER,
      shares,
      minPaymentOut,
      expiryTs,
      payoutAccount: payout,
    }),
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(),
  );
  const { signature } = await simulateSignSendConfirm(
    tx,
    signer,
    { blockhash, lastValidBlockHeight },
    "curve sell authorization",
    {
      kind: "curve-sell",
      pool: pool.toBase58(),
      shares: String(args.amount),
      saleAuth: authAddr.toBase58(),
    },
  );
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: authAddr.toBase58(),
    kind: "curve-sell",
    curvePool: pool.toBase58(),
    escrowed: false,
    input: {
      mint: args.inputMint,
      symbol: input.sym ?? curve.pool.symbol,
      amount: rawToUi(shares, input.dec),
    },
    output: {
      mint: args.outputMint,
      symbol: output.sym,
      atPrice: rawToUi(minPaymentOut, output.dec),
      // No maker fee: the launchpad pays the pinned account directly, our program is not in the path.
      netAfterFee: rawToUi(minPaymentOut, output.dec),
    },
    price,
    makerFeeBps: 0,
    market,
    /** What was signed: the ask, or the sale's end when that comes first. */
    expiresAt: new Date(expiryTs * 1000).toISOString(),
    saleEndsAt: curve.pool.endTs ? new Date(curve.pool.endTs * 1000).toISOString() : null,
    payoutNative: false,
    refundNative: false,
    wrappedCook: "0",
    note: "nothing is escrowed: this authorizes the Cookiebox keeper to sell up to these shares at or above your price until the expiry, paying wCOOK to your token account (partial fills possible, pro-rated floor). The shares stay spendable — selling them with launchpad_sell makes the order unfillable. The order also ends with the SALE: no fill is possible once the launch closes, whatever expiry was asked for, so expiresAt is never past saleEndsAt. Revoke any time with cancel_limit_order.",
  };
}
