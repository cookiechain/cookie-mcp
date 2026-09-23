// Limit orders on Cookie Chain — the Cookiebox escrow program (`L1M1tk…`) filled by a keeper that
// routes through the same aggregator /trade uses, so any pair with a route can rest as an order.
//
// Shape: the Cookiebox aggregator (agg.cookiebox.app) BUILDS the unsigned place/cancel transactions
// with the exact instruction builders its own Trade page uses (`/limit-orders/place-tx`,
// `/limit-orders/cancel-tx`) and pre-signs only the throwaway `base` keypair that seeds the order
// PDA. We do NOT trust that build: before signing, every instruction is decoded against the
// program IDL and checked — fee payer, maker, amounts, kind, pinned token accounts, and that no
// instruction touches a program or an account we did not expect. Then simulate on our RPC, sign,
// send, confirm. Non-custodial; the escrow is the program's, the key never leaves this process.
//
// Fees (Jupiter's model): the maker is paid `takingAmount − makerFee` on each fill (10 bps at launch,
// admin-tunable on the on-chain `Fee` singleton, so it is read live and never hardcoded). The taker
// fee is paid by the filler on top of the maker's price and is 0 while the only filler is the
// Cookiebox keeper.
import anchorPkg, { type Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type MessageV0,
} from "@solana/web3.js";

import limitOrderIdl from "../idl/limit_order.json" with { type: "json" };
import {
  COOKIEBOX_AGG_API_URL,
  COOK_MINT,
  DEFAULT_SLIPPAGE_BPS,
  PROGRAM_IDS,
  explorerTxUrl,
} from "./config";
import { buildSettleCurveSellIx, isCurveSellVaultPayout } from "./curveSellVault";
import { unconfirmedError } from "./confirm";
import { nativeFlagsBody, quoteAgg } from "./cookiebox";
import { resolveWallet } from "./domains";
import { CookieMcpError } from "./errors";
import { rawToUi, uiToRaw } from "./format";
import { fetchJson } from "./http";
import { noRouteError } from "./launchpad";
import { userPositionPda } from "./launchpad/positions";
import { getConnection } from "./rpc";
import { resolveMeta, type TokenMeta } from "./trade";
import {
  assertHousekeepingIxs,
  decodeMessageIxs,
  housekeepingPrograms,
  otherSignersPresigned,
  refuser,
  same,
  type DecodedIx,
} from "./txVerify";
import { ownPublicKey, requireSigner } from "./wallet";
import type { TxSigner } from "./signer";

export const LIMIT_ORDER_PROGRAM_ID = new PublicKey(PROGRAM_IDS.limitOrder);

export { decodeMessageIxs, type DecodedIx };

// The IDL ships its own `address`. A stale copy after a redeploy would make every PDA check here
// pass against the wrong program — fail at import (the boot smoke catches it) instead.
const idlAddress = (limitOrderIdl as { address?: string }).address;
if (idlAddress !== PROGRAM_IDS.limitOrder) {
  throw new Error(
    `src/idl/limit_order.json is for ${idlAddress}, but PROGRAM_IDS.limitOrder is ` +
      `${PROGRAM_IDS.limitOrder} — re-copy the IDL from the program repo`,
  );
}

const ixCoder = new anchorPkg.BorshInstructionCoder(limitOrderIdl as Idl);

/** On-chain `Order.kind`. */
export const ORDER_KIND_LIMIT = 0;
export const ORDER_KIND_STOP = 1;
export const ORDER_KIND_CURVE_BUY = 2;
/** The kinds this server can PLACE: escrow orders the aggregator's `place-tx` builds. */
export type LimitOrderKind = "limit" | "stop";
/**
 * Every kind the listing can return. `curve-buy` is an escrow order whose fill lands as MomoSwap
 * curve shares (cancellable like any other); `curve-sell` is not an `Order` at all but a launchpad
 * sale authorization the maker signed — nothing is escrowed; revoking it also closes its vault.
 */
export type ListedOrderKind = LimitOrderKind | "curve-buy" | "curve-sell";

/** Orders default to a week, as on the Trade page and on Jupiter. `0` = good-til-cancelled. */
export const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 3600;
/** The API's own cap — a typo'd expiry can't pin funds for decades. */
export const MAX_EXPIRY_SECONDS = 365 * 24 * 3600;

/** The place/cancel builds simulate server-side; give them the same headroom as /swap-tx. */
const BUILD_TX_TIMEOUT_MS = 60_000;

// --- PDAs (golden-tested) -----------------------------------------------------------------------

export function orderPda(base: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), base.toBuffer()],
    LIMIT_ORDER_PROGRAM_ID,
  )[0];
}

export function reservePda(order: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reserve"), order.toBuffer()],
    LIMIT_ORDER_PROGRAM_ID,
  )[0];
}

// --- Exact price math (ported from cookiebox `pricing.ts`; all bigint, no floats) -------------------

const BPS = 10_000n;

/** A decimal string as an exact integer plus its scale: "1.25" → { value: 125n, scale: 2 }. */
export function parseDecimalToScaled(s: string): { value: bigint; scale: number } | null {
  const trimmed = s.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "", frac = ""] = trimmed.split(".");
  const digits = `${whole}${frac}`;
  if (digits === "") return null;
  return { value: BigInt(digits), scale: frac.length };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * The `taking_amount` an order carries for a limit price (output per input, human units). Rounds
 * UP so the maker never asks for less than the price they set — identical to what the API and the
 * Trade page compute, which is what lets us verify the built transaction against it.
 */
export function takingAmountForPrice(
  makingRaw: bigint,
  price: string,
  inputDecimals: number,
  outputDecimals: number,
): bigint | null {
  const parsed = parseDecimalToScaled(price);
  if (!parsed || parsed.value === 0n || makingRaw <= 0n) return null;
  const numerator = makingRaw * parsed.value * pow10(outputDecimals);
  const denominator = pow10(inputDecimals) * pow10(parsed.scale);
  return (numerator + denominator - 1n) / denominator;
}

/** Display-only inverse: output per input as a float. Never feed it back into an order. */
export function priceFromAmounts(
  makingRaw: bigint,
  takingRaw: bigint,
  inputDecimals: number,
  outputDecimals: number,
): number | null {
  if (makingRaw <= 0n) return null;
  const humanIn = Number(makingRaw) / Number(pow10(inputDecimals));
  const humanOut = Number(takingRaw) / Number(pow10(outputDecimals));
  if (!Number.isFinite(humanIn) || humanIn === 0) return null;
  return humanOut / humanIn;
}

/** How far a price sits from the market rate, in percent (positive = above market). */
export function pctFromMarket(price: number, market: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(market) || market <= 0) return null;
  return ((price - market) / market) * 100;
}

/** What the maker's wallet receives for `takingAmount`: the fee is rounded down, like the program. */
export function makerNetOut(takingAmount: bigint, makerFeeBps: number): bigint {
  return takingAmount - (takingAmount * BigInt(makerFeeBps)) / BPS;
}

/**
 * A price for the API must be a decimal STRING — a JSON number has already been through IEEE754.
 * Agents mostly pass numbers anyway, so accept one when it prints as a plain decimal (`0.75`), and
 * refuse the exponent forms JS uses for very small or very large values rather than guess.
 */
export function normalizePrice(input: string | number): string {
  const s = typeof input === "number" ? String(input) : input.trim();
  if (typeof input === "number" && (!Number.isFinite(input) || /e/i.test(s))) {
    throw new CookieMcpError(
      `price ${String(input)} cannot be represented exactly as a number`,
      'pass the price as a decimal string, e.g. "0.000012"',
    );
  }
  const parsed = parseDecimalToScaled(s);
  if (!parsed || parsed.value === 0n) {
    throw new CookieMcpError(
      `invalid price "${String(input)}"`,
      'price is output per input in human units, as a positive decimal string, e.g. "0.75"',
    );
  }
  return s;
}

/** Unix expiry from a relative lifetime. `0` = never; default one week. */
export function expiryFromSeconds(
  expiresInSeconds: number | undefined,
  now = Math.floor(Date.now() / 1000),
): number | null {
  const s = expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  if (!Number.isInteger(s) || s < 0) {
    throw new CookieMcpError(
      "expiresInSeconds must be a non-negative integer",
      "0 = never expires",
    );
  }
  if (s === 0) return null;
  if (s > MAX_EXPIRY_SECONDS) {
    throw new CookieMcpError(
      "expiresInSeconds is more than a year",
      `the maximum is ${MAX_EXPIRY_SECONDS} (one year); pass 0 for no expiry`,
    );
  }
  return now + s;
}

/**
 * Would this order be actionable the moment it lands? A take-profit whose limit is at or below
 * what the router pays right now fills immediately (a swap, at a worse price than `trade`); a stop
 * whose trigger is at or above the current rate is already triggered and sells at market at once.
 * Both are almost always a mis-typed price or a swapped pair, so `place_limit_order` refuses them
 * unless told otherwise. Pure — tested.
 */
export function fillsImmediately(kind: LimitOrderKind, priced: bigint, marketOut: bigint): boolean {
  return kind === "stop" ? marketOut <= priced : marketOut >= priced;
}

// --- Verifying the aggregator's build before we sign --------------------------------------------

/** Programs a place/cancel transaction may invoke. Anything else is refused before signing. */
export const ALLOWED_PROGRAMS: ReadonlySet<string> = housekeepingPrograms(LIMIT_ORDER_PROGRAM_ID);

const refuse = refuser("limit-order");

export interface ExpectedPlace {
  owner: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  makingAmount: bigint;
  /** The on-chain `taking_amount`: the limit for a TP, the hidden floor for a stop. */
  takingAmount: bigint;
  /** 0 for a plain limit. */
  triggerTakingAmount: bigint;
  kind: LimitOrderKind | "curve-buy";
  /**
   * `curve-buy` only: the MomoSwap pool pinned as the trailing `curve_pool` account, and the
   * launchpad program that owns it. The payout account must then be OUR `UserPosition` PDA on it.
   */
  curve?: { pool: PublicKey; programId: PublicKey };
  expiredAt: number | null;
  /** Native COOK input paid by wrapping (`wrapSol`): the refund is pinned to our wallet. */
  refundNative: boolean;
  /** Native COOK output to be unwrapped (`unwrapSol`): our wallet, not an ATA, is the payout. */
  payoutNative: boolean;
  /** The order address the API reported. */
  order: PublicKey;
}

/**
 * The placement transaction the aggregator built, checked against what we asked for. Throws a
 * `CookieMcpError` (nothing signed) on any mismatch. Returns the decoded `initialize_order` args.
 */
export function assertPlaceTxTrustworthy(tx: VersionedTransaction, exp: ExpectedPlace): void {
  const ixs = decodeMessageIxs(tx, "limit-order");
  const msg = tx.message as MessageV0;
  if (!same(msg.staticAccountKeys[0]!, exp.owner)) throw refuse("fee payer is not our wallet");

  const programIxs = ixs.filter((ix) => same(ix.programId, LIMIT_ORDER_PROGRAM_ID));
  if (programIxs.length !== 1) throw refuse(`${programIxs.length} limit-order instructions`);
  const ix = programIxs[0]!;
  const decoded = ixCoder.decode(ix.data);
  if (!decoded || decoded.name !== "initialize_order") {
    throw refuse(`program instruction ${decoded?.name ?? "unknown"}`);
  }
  // The raw coder keeps the IDL's snake_case names (anchor's Program camel-cases them).
  const a = decoded.data as {
    making_amount: { toString(): string };
    taking_amount: { toString(): string };
    expired_at: { toNumber(): number } | null;
    kind: number;
    refund_native: boolean;
    trigger_taking_amount: { toString(): string };
  };
  if (BigInt(a.making_amount.toString()) !== exp.makingAmount) throw refuse("making amount");
  if (BigInt(a.taking_amount.toString()) !== exp.takingAmount) throw refuse("taking amount");
  if (BigInt(a.trigger_taking_amount.toString()) !== exp.triggerTakingAmount) {
    throw refuse("stop trigger");
  }
  const kind =
    exp.kind === "stop"
      ? ORDER_KIND_STOP
      : exp.kind === "curve-buy"
        ? ORDER_KIND_CURVE_BUY
        : ORDER_KIND_LIMIT;
  if (a.kind !== kind) throw refuse("order kind");
  if ((exp.kind === "curve-buy") !== Boolean(exp.curve)) throw refuse("curve pool expectation");
  const expiredAt = a.expired_at == null ? null : a.expired_at.toNumber();
  if (expiredAt !== exp.expiredAt) throw refuse("expiry");

  // initialize_order accounts, in IDL order.
  const [base, maker, order, reserve, makerInput, makerOutput, inputMint, outputMint] = ix.keys;
  if (
    !base ||
    !maker ||
    !order ||
    !reserve ||
    !makerInput ||
    !makerOutput ||
    !inputMint ||
    !outputMint
  ) {
    throw refuse("account list too short");
  }
  if (!same(maker, exp.owner)) throw refuse("maker is not our wallet");
  if (!same(inputMint, exp.inputMint) || !same(outputMint, exp.outputMint)) throw refuse("mints");
  const expectedOrder = orderPda(base);
  if (!same(order, expectedOrder) || !same(order, exp.order)) throw refuse("order address");
  if (!same(reserve, reservePda(order))) throw refuse("reserve address");
  // The input leaves OUR token account for the reserve, so `makerInput` is always our ATA for the
  // input mint; with `refund_native` (native input only) the program then pins our wallet as the
  // refund destination instead. `makerOutput` is pinned as given: our ATA for the output mint, or
  // our wallet itself for a native COOK payout.
  const inAta = getAssociatedTokenAddressSync(exp.inputMint, exp.owner, true);
  const outAta = getAssociatedTokenAddressSync(exp.outputMint, exp.owner, true);
  if (!same(makerInput, inAta)) throw refuse("input account is not our token account");
  if (exp.curve) {
    // A curve token has no ATA to pay into: the fill is counted on OUR position for the pinned pool.
    if (!same(makerOutput, userPositionPda(exp.curve.pool, exp.owner, exp.curve.programId))) {
      throw refuse("payout account is not our position on the curve pool");
    }
    const curvePool = ix.keys[11];
    if (!curvePool || !same(curvePool, exp.curve.pool)) throw refuse("curve pool account");
  } else if (!same(makerOutput, exp.payoutNative ? exp.owner : outAta)) {
    throw refuse("payout account");
  }
  if (a.refund_native !== exp.refundNative) throw refuse("refund flag");

  const presigned = otherSignersPresigned(tx, exp.owner, refuse);
  if (presigned.length !== 1 || !same(presigned[0]!, base)) throw refuse("unexpected extra signer");
  assertHousekeepingIxs(ixs, exp.owner, [], {
    allowedPrograms: ALLOWED_PROGRAMS,
    refuse,
    extraAllowed: exp.curve ? [buyOptinIxMatcher(exp.owner, exp.curve.programId)] : [],
  });
}

/** `sha256("global:enable_buy_for")[..8]` — pinned by a test. */
export const ENABLE_BUY_FOR_DISCRIMINATOR = Uint8Array.from([
  163, 207, 188, 100, 160, 95, 206, 193,
]);

/** `["buy_optin", owner]` on the launchpad — the maker's consent to be bought for by the keeper. */
export function buyOptinPda(owner: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buy_optin"), owner.toBuffer()],
    programId,
  )[0];
}

/**
 * The ONE launchpad instruction a curve-buy placement may carry: `enable_buy_for` for our own
 * wallet — [owner (signer), our buy_optin PDA, system program], data = the bare discriminator.
 */
function buyOptinIxMatcher(owner: PublicKey, programId: PublicKey): (ix: DecodedIx) => boolean {
  const optin = buyOptinPda(owner, programId);
  return (ix) =>
    same(ix.programId, programId) &&
    ix.keys.length === 3 &&
    same(ix.keys[0]!, owner) &&
    same(ix.keys[1]!, optin) &&
    same(ix.keys[2]!, SystemProgram.programId) &&
    ix.data.length === 8 &&
    ix.data.every((b, i) => b === ENABLE_BUY_FOR_DISCRIMINATOR[i]);
}

/** The cancel transaction, checked the same way: our order, refund to us, nothing else. */
export function assertCancelTxTrustworthy(
  tx: VersionedTransaction,
  exp: { owner: PublicKey; order: PublicKey },
): void {
  const ixs = decodeMessageIxs(tx, "limit-order");
  const msg = tx.message as MessageV0;
  if (!same(msg.staticAccountKeys[0]!, exp.owner)) throw refuse("fee payer is not our wallet");

  const programIxs = ixs.filter((ix) => same(ix.programId, LIMIT_ORDER_PROGRAM_ID));
  if (programIxs.length !== 1) throw refuse(`${programIxs.length} limit-order instructions`);
  const ix = programIxs[0]!;
  const decoded = ixCoder.decode(ix.data);
  if (!decoded || decoded.name !== "cancel_order") {
    throw refuse(`program instruction ${decoded?.name ?? "unknown"}`);
  }
  // cancel_order accounts: [order, maker, reserve, makerInputAccount, inputMint, tokenProgram].
  const [order, maker, reserve] = ix.keys;
  if (!order || !maker || !reserve) throw refuse("account list too short");
  if (!same(order, exp.order)) throw refuse("order address");
  if (!same(maker, exp.owner)) throw refuse("maker is not our wallet");
  if (!same(reserve, reservePda(order))) throw refuse("reserve address");

  // A partial unwrap co-signs with a throwaway native account the API pre-signed for us.
  const temps = otherSignersPresigned(tx, exp.owner, refuse);
  assertHousekeepingIxs(ixs, exp.owner, temps, { allowedPrograms: ALLOWED_PROGRAMS, refuse });
}

// --- Aggregator API types -----------------------------------------------------------------------

export interface LimitOrderFees {
  makerFeeBps: number;
  makerStableFeeBps: number;
  takerFeeBps: number;
  takerStableFeeBps: number;
  /**
   * The launchpad's fee on a curve SELL (anchor-launchpad-momoswap#70), charged on top of the
   * authorization's floor. Only an agg with cookiebox#7 reports it.
   */
  curveSellFeeBps?: number;
}

export interface AggLimitOrder {
  order: string;
  maker: string;
  inputMint: string;
  outputMint: string;
  makingAmount: string;
  takingAmount: string;
  netTakingAmount: string;
  makerFeeBps: number;
  oriMakingAmount: string;
  oriTakingAmount: string;
  filledPct: number;
  price: number | null;
  kind: ListedOrderKind;
  /** `curve-buy` / `curve-sell` only: the MomoSwap pool. */
  curvePool?: string | null;
  triggerTakingAmount: string | null;
  floorPrice: number | null;
  expiredAt: number | null;
  /** null for a `curve-sell` — a sale authorization records no creation time. */
  createdAt: number | null;
  payoutNative: boolean;
  refundNative: boolean;
  waiting: boolean;
  /** `curve-sell` only, always false: the shares stay spendable, so the order can go unfillable. */
  escrowed?: boolean;
}

interface AggPlaceTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  order: string;
  reserve: string;
  makingAmount: string;
  takingAmount: string;
  netTakingAmount: string;
  makerFeeBps: number;
  triggerTakingAmount: string | null;
  expiredAt: number | null;
  kind: LimitOrderKind;
  payoutNative: boolean;
  refundNative: boolean;
  wrappedLamports: string;
}

interface AggCancelTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  order: string;
  refundAmount: string;
  unwrappedLamports: string;
}

/** Re-hint the aggregator's own failures so an agent knows whether to retry, fix inputs, or stop. */
export function apiError(e: unknown, action: string): CookieMcpError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/disabled/i.test(msg)) {
    return new CookieMcpError(
      "limit orders are switched off on the Cookiebox aggregator right now",
      "nothing was sent; try again later — the program and your existing orders are unaffected",
    );
  }
  if (/AccountNotInitialized|3012/.test(msg)) {
    return new CookieMcpError(
      `${action} failed: the wallet has no token account for the input mint`,
      "you hold none of the input token — check get_balance and the mint address",
    );
  }
  if (/AccountNotFound/.test(msg)) {
    return new CookieMcpError(
      `${action} failed: the wallet has no COOK on chain`,
      "the fee payer account does not exist yet — fund the wallet with COOK first (see get_wallet)",
    );
  }
  if (/insufficient|0x1\b/i.test(msg)) {
    return new CookieMcpError(
      `${action} failed: insufficient funds`,
      "check the wallet holds the full input amount plus a little COOK for fees and rent",
    );
  }
  if (/not found/i.test(msg) && /order/i.test(msg)) {
    return new CookieMcpError(
      "order not found — already filled, cancelled or expired",
      "run get_limit_orders to see what is still open",
    );
  }
  if (/not the maker/i.test(msg)) {
    return new CookieMcpError(
      "this order belongs to another wallet",
      "only the maker can cancel; check get_wallet and get_limit_orders",
    );
  }
  return e instanceof CookieMcpError ? e : new CookieMcpError(`${action} failed: ${msg}`);
}

// --- Reads ----------------------------------------------------------------------------------------

/** Live fee schedule, or null when the aggregator build in production predates the route. */
export async function fetchLimitOrderFees(): Promise<LimitOrderFees | null> {
  try {
    return await fetchJson<LimitOrderFees>(`${COOKIEBOX_AGG_API_URL}/limit-orders/fees`);
  } catch {
    return null;
  }
}

export interface LimitOrderView {
  order: string;
  kind: ListedOrderKind;
  /** `curve-buy` / `curve-sell`: the MomoSwap pool the order trades on. */
  curvePool: string | null;
  /**
   * false only for a `curve-sell`: nothing is locked, the shares stay spendable, and the order
   * silently becomes unfillable if they are sold elsewhere. It cannot be cancelled here.
   */
  escrowed: boolean;
  /** `open`, `filling` (a keeper fill is mid-flight), or `expired` (cancel to get the input back). */
  status: "open" | "filling" | "expired";
  input: { mint: string; symbol: string | null; remaining: string; original: string };
  output: {
    mint: string;
    symbol: string | null;
    /** Gross output the program enforces for the remaining input (a stop: its hidden floor). */
    minReceive: string;
    /** What actually lands in the wallet after the maker fee. */
    netAfterFee: string;
  };
  /** Output per input, human units. For a stop this is the TRIGGER. Display only. */
  price: number | null;
  /** Stop only: the program-enforced floor as a price — a safety net, not what the maker gets. */
  floorPrice: number | null;
  filledPct: number;
  makerFeeBps: number;
  expiresAt: string | null;
  /** null for a `curve-sell`. */
  createdAt: string | null;
  /** A fill pays native COOK to the wallet rather than wCOOK to a token account. */
  payoutNative: boolean;
  /** A cancel/expiry refunds native COOK to the wallet; nothing to unwrap. */
  refundNative: boolean;
}

/** Pure — tested. */
export function formatLimitOrder(
  o: AggLimitOrder,
  input: TokenMeta,
  output: TokenMeta,
  now = Math.floor(Date.now() / 1000),
): LimitOrderView {
  const expired = o.expiredAt != null && o.expiredAt <= now;
  return {
    order: o.order,
    kind: o.kind,
    curvePool: o.curvePool ?? null,
    escrowed: o.escrowed ?? true,
    status: o.waiting ? "filling" : expired ? "expired" : "open",
    input: {
      mint: o.inputMint,
      symbol: input.sym,
      remaining: rawToUi(o.makingAmount, input.dec),
      original: rawToUi(o.oriMakingAmount, input.dec),
    },
    output: {
      mint: o.outputMint,
      symbol: output.sym,
      minReceive: rawToUi(o.takingAmount, output.dec),
      netAfterFee: rawToUi(o.netTakingAmount, output.dec),
    },
    price: o.price,
    floorPrice: o.kind === "stop" ? o.floorPrice : null,
    filledPct: o.filledPct,
    makerFeeBps: o.makerFeeBps,
    expiresAt: o.expiredAt == null ? null : new Date(o.expiredAt * 1000).toISOString(),
    createdAt: o.createdAt == null ? null : new Date(o.createdAt * 1000).toISOString(),
    payoutNative: o.payoutNative,
    refundNative: o.refundNative,
  };
}

export async function getLimitOrders(args: { owner?: string }): Promise<{
  owner: string;
  ownerName?: string;
  fees: LimitOrderFees | null;
  count: number;
  orders: LimitOrderView[];
}> {
  let owner: string;
  let ownerName: string | undefined;
  if (args.owner) {
    const r = await resolveWallet(args.owner, "owner");
    owner = r.pubkey.toBase58();
    ownerName = r.name ?? undefined;
  } else {
    const own = ownPublicKey();
    if (!own) {
      throw new CookieMcpError(
        "no wallet configured and no owner given",
        "pass `owner` (address or .cook name), or set COOKIE_PRIVATE_KEY to list your own orders",
      );
    }
    owner = own;
  }
  const [{ orders }, fees] = await Promise.all([
    fetchJson<{ maker: string; orders: AggLimitOrder[] }>(
      `${COOKIEBOX_AGG_API_URL}/limit-orders?maker=${owner}`,
    ).catch((e) => {
      throw apiError(e, "listing orders");
    }),
    fetchLimitOrderFees(),
  ]);
  const views = await Promise.all(
    orders.map(async (o) => {
      const { input, output } = await resolveMeta(o.inputMint, o.outputMint);
      return formatLimitOrder(o, input, output);
    }),
  );
  return {
    owner,
    ...(ownerName ? { ownerName } : {}),
    fees,
    count: views.length,
    orders: views,
  };
}

// --- Writes ---------------------------------------------------------------------------------------

export async function simulateSignSendConfirm(
  tx: VersionedTransaction,
  signer: TxSigner,
  built: { blockhash: string; lastValidBlockHeight: number },
  what: string,
  summary?: Record<string, unknown>,
): Promise<{ signature: string; confirmed: boolean }> {
  const conn = getConnection();
  const sim = await conn.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "confirmed",
  });
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    throw apiError(
      new Error(`${JSON.stringify(sim.value.err)} ${logs.slice(-4).join(" | ")}`),
      `${what} simulation`,
    );
  }
  await signer.signTransaction(tx, {
    what,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
    ...(summary ? { summary } : {}),
  });
  const signature = await conn.sendRawTransaction(Buffer.from(tx.serialize()));
  try {
    const conf = await conn.confirmTransaction({ signature, ...built }, "confirmed");
    if (conf.value.err) {
      throw new CookieMcpError(
        `the ${what} landed but failed on-chain: ${JSON.stringify(conf.value.err)}`,
        `nothing moved (only the tx fee was spent) — see ${explorerTxUrl(signature)}`,
      );
    }
    return { signature, confirmed: true };
  } catch (e) {
    if (e instanceof CookieMcpError) throw e;
    throw unconfirmedError(what, signature, {
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

export interface PlaceLimitOrderResult {
  signature: string;
  explorerUrl: string;
  /** The order address — for a `curve-sell`, the launchpad sale authorization. */
  order: string;
  kind: ListedOrderKind;
  /** `curve-buy` / `curve-sell`: the MomoSwap pool. */
  curvePool?: string;
  /** false only for a `curve-sell`: nothing is locked, the shares stay spendable. */
  escrowed?: boolean;
  input: { mint: string; symbol: string | null; amount: string };
  output: {
    mint: string;
    symbol: string | null;
    /** TP: the gross output the order demands. Stop: the estimate at the trigger. */
    atPrice: string;
    /** After the maker fee. For a stop this is the estimate at the trigger, not a guarantee. */
    netAfterFee: string;
  };
  /** Output per input, as placed. For a stop this is the trigger. */
  price: string;
  /** Stop only: the program-enforced floor as a price (what a compromised keeper could pay at worst). */
  floorPrice?: number | null;
  makerFeeBps: number;
  /** The router's executable rate at placement, and how far the order sits from it. */
  market: { rate: number; pctFromMarket: number | null } | null;
  /** What was SIGNED. On a curve sell that is the ask or the sale's end, whichever comes first. */
  expiresAt: string | null;
  /**
   * Curve sell only: when the launch's sale closes. `sell_authorized` refuses past it whatever the
   * authorization says, so it is the real deadline and `expiresAt` is never later.
   */
  saleEndsAt?: string | null;
  payoutNative: boolean;
  refundNative: boolean;
  /** Native COOK wrapped into wCOOK inside the placement, in COOK. */
  wrappedCook: string;
  note: string;
}

export async function placeLimitOrder(args: {
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
}): Promise<PlaceLimitOrderResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const kind: LimitOrderKind = args.kind ?? "limit";
  if (args.inputMint === args.outputMint) {
    throw new CookieMcpError("inputMint and outputMint are the same", "pick two different tokens");
  }
  let inputMint: PublicKey;
  let outputMint: PublicKey;
  try {
    inputMint = new PublicKey(args.inputMint);
    outputMint = new PublicKey(args.outputMint);
  } catch {
    throw new CookieMcpError("invalid mint address", "pass base58 mint addresses");
  }
  if (args.floorPrice !== undefined && kind !== "stop") {
    throw new CookieMcpError('floorPrice only applies to kind "stop"', "omit it for a limit order");
  }

  const { input, output } = await resolveMeta(args.inputMint, args.outputMint);
  let makingAmount: bigint;
  try {
    makingAmount = uiToRaw(args.amount, input.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is a UI amount of the input token (max ${input.dec} decimals)`,
    );
  }
  if (makingAmount <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive input amount");
  }
  const price = normalizePrice(args.price);
  const priced = takingAmountForPrice(makingAmount, price, input.dec, output.dec);
  if (!priced) {
    throw new CookieMcpError(
      "price rounds to zero output for this amount",
      "raise the price or the amount",
    );
  }
  const floorPrice = args.floorPrice === undefined ? null : normalizePrice(args.floorPrice);
  const expiredAt = expiryFromSeconds(args.expiresInSeconds);

  // The keeper fills through the aggregator's router, so its executable quote is the only market
  // rate that means anything here — a mid price would misplace the order by the pool fee + impact.
  let market: PlaceLimitOrderResult["market"] = null;
  if (!args.skipMarketCheck) {
    let route;
    try {
      route = await quoteAgg(
        args.inputMint,
        args.outputMint,
        makingAmount.toString(),
        DEFAULT_SLIPPAGE_BPS,
        owner.toBase58(),
      );
    } catch (e) {
      throw await noRouteError([args.inputMint, args.outputMint], e);
    }
    if (!route) {
      const redirected = await noRouteError([args.inputMint, args.outputMint]);
      if (redirected instanceof CookieMcpError && !/no route found/.test(redirected.message)) {
        throw redirected; // launchpad token: point at the curve tools
      }
      throw new CookieMcpError(
        "no route exists between these tokens right now, so the keeper could not fill this order",
        "check the mints with search_tokens; pass skipMarketCheck: true to place it anyway (it rests until a route appears)",
      );
    }
    const marketOut = BigInt(route.grossOutAmount ?? route.totalOutAmount);
    const rate = priceFromAmounts(makingAmount, marketOut, input.dec, output.dec);
    const limitRate = priceFromAmounts(makingAmount, priced, input.dec, output.dec);
    market = {
      rate: rate ?? NaN,
      pctFromMarket: rate != null && limitRate != null ? pctFromMarket(limitRate, rate) : null,
    };
    if (fillsImmediately(kind, priced, marketOut)) {
      const marketStr = rawToUi(marketOut, output.dec);
      throw new CookieMcpError(
        kind === "stop"
          ? `the market already pays ${marketStr} ${output.sym ?? "output"} for this amount — at or below the stop trigger, so it would sell at market immediately`
          : `the market already pays ${marketStr} ${output.sym ?? "output"} for this amount — at or above this limit, so it would fill immediately at a worse rate than a swap`,
        kind === "stop"
          ? "a stop trigger must sit BELOW the current rate; use trade to sell now, or lower the trigger. Pass skipMarketCheck: true to place it anyway"
          : "a limit must sit ABOVE the current rate; use trade to swap now, or raise the price. Pass skipMarketCheck: true to place it anyway",
      );
    }
  }

  let built: AggPlaceTx;
  try {
    built = await fetchJson<AggPlaceTx>(`${COOKIEBOX_AGG_API_URL}/limit-orders/place-tx`, {
      method: "POST",
      body: JSON.stringify({
        owner: owner.toBase58(),
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        makingAmount: makingAmount.toString(),
        price,
        kind,
        ...(expiredAt == null ? {} : { expiredAt }),
        ...(floorPrice == null ? {} : { floorPrice }),
        ...nativeFlagsBody(args),
      }),
      timeoutMs: BUILD_TX_TIMEOUT_MS,
    });
  } catch (e) {
    throw apiError(e, "placing the order");
  }

  // Verify the build against OUR numbers — not the API's echo — before anything is signed.
  const takingAmount = BigInt(built.takingAmount);
  const triggerTakingAmount = BigInt(built.triggerTakingAmount ?? "0");
  if (kind === "stop") {
    if (triggerTakingAmount !== priced) throw refuse("stop trigger differs from the price given");
    const expectedFloor =
      floorPrice == null
        ? null
        : takingAmountForPrice(makingAmount, floorPrice, input.dec, output.dec);
    if (expectedFloor != null && takingAmount !== expectedFloor) throw refuse("stop floor");
    if (takingAmount > priced) throw refuse("stop floor above its trigger");
  } else if (takingAmount !== priced || triggerTakingAmount !== 0n) {
    throw refuse("taking amount differs from the price given");
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  const order = new PublicKey(built.order);
  // What we asked for, not what the API echoed (older agg builds echo neither flag): wrapping
  // native COOK ⇒ the refund is pinned to our wallet; unwrapping a COOK output ⇒ so is the payout.
  const refundNative = (args.wrapSol ?? true) && args.inputMint === COOK_MINT;
  const payoutNative = (args.unwrapSol ?? true) && args.outputMint === COOK_MINT;
  assertPlaceTxTrustworthy(tx, {
    owner,
    inputMint,
    outputMint,
    makingAmount,
    takingAmount,
    triggerTakingAmount,
    kind,
    expiredAt,
    refundNative,
    payoutNative,
    order,
  });

  const { signature } = await simulateSignSendConfirm(tx, signer, built, "limit-order placement", {
    kind,
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: String(args.amount),
    order,
  });

  const feeBps = built.makerFeeBps;
  const shown = kind === "stop" ? triggerTakingAmount : takingAmount;
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: built.order,
    kind,
    input: { mint: args.inputMint, symbol: input.sym, amount: rawToUi(makingAmount, input.dec) },
    output: {
      mint: args.outputMint,
      symbol: output.sym,
      atPrice: rawToUi(shown, output.dec),
      netAfterFee: rawToUi(makerNetOut(shown, feeBps), output.dec),
    },
    price,
    ...(kind === "stop"
      ? { floorPrice: priceFromAmounts(makingAmount, takingAmount, input.dec, output.dec) }
      : {}),
    makerFeeBps: feeBps,
    market,
    expiresAt: expiredAt == null ? null : new Date(expiredAt * 1000).toISOString(),
    payoutNative,
    refundNative,
    wrappedCook: rawToUi(built.wrappedLamports ?? "0", 9),
    note:
      kind === "stop"
        ? "stop-market: once the router's rate falls to the trigger the keeper sells at market and passes the proceeds through (minus the maker fee); the floor is only the program's guarantee against a rogue keeper. Cancel any time with cancel_limit_order."
        : "the keeper fills once the router's rate reaches the price (partial fills possible); the wallet receives the limit minus the maker fee. Cancel any time with cancel_limit_order; an expired order must also be cancelled to get the input back.",
  };
}

export interface CancelLimitOrderResult {
  signature: string;
  explorerUrl: string;
  order: string;
  /**
   * What the cancel returned to the wallet. For a `curve-sell` nothing was ever held: the amount is
   * the shares that are no longer approved for sale, and they never left the position.
   */
  refund: { mint: string; symbol: string | null; amount: string };
  /** COOK unwrapped back to the wallet inside the cancel (a wCOOK-refund order). */
  unwrappedCook: string;
  /** `curve-sell` only: the launchpad sale authorization was revoked (no escrow, no refund). */
  revoked?: true;
}

// --- Curve sells: a launchpad SaleAuthorization, revoked directly -----------------------------------
//
// A curve sell is not an `Order` in the escrow program: shares cannot be escrowed, so the "order" is
// a `SaleAuthorization` the maker signed on the launchpad, and cancelling it is the launchpad's
// `revoke_position_sale(owner, sale_auth)`. This server builds the one instruction itself — from the
// account bytes in hand, not from the API row. (The aggregator's `cancel-tx` gained the same shape
// on 2026-09-22 and routes an authorization address to a revoke; building it here keeps the bytes
// we sign derived from what we read.)

/** `sha256("account:SaleAuthorization")[..8]` — pinned by a test. */
export const SALE_AUTH_DISCRIMINATOR = Uint8Array.from([89, 133, 197, 147, 202, 192, 244, 166]);
/** `sha256("global:revoke_position_sale")[..8]` — pinned by a test. */
export const REVOKE_POSITION_SALE_DISCRIMINATOR = Uint8Array.from([
  104, 153, 76, 236, 211, 155, 3, 134,
]);
/** Borsh layout after the discriminator: pool 8 · owner 40 · delegate 72 · payout 104 · … · bump 168. */
export const SALE_AUTH_SIZE = 169;

export interface SaleAuthView {
  pool: PublicKey;
  owner: PublicKey;
  delegate: PublicKey;
  /** Where fills pay: the curve-sell vault (fee-paying), or the maker's ATA on a legacy order. */
  payoutAccount: PublicKey;
  remainingShares: bigint;
}

/** Decode a `SaleAuthorization`, or null when the bytes are not one. Pure — tested. */
export function decodeSaleAuth(data: Uint8Array): SaleAuthView | null {
  if (data.length < SALE_AUTH_SIZE) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== SALE_AUTH_DISCRIMINATOR[i]) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    pool: new PublicKey(buf.subarray(8, 40)),
    owner: new PublicKey(buf.subarray(40, 72)),
    delegate: new PublicKey(buf.subarray(72, 104)),
    payoutAccount: new PublicKey(buf.subarray(104, 136)),
    remainingShares: buf.readBigUInt64LE(144),
  };
}

/** `revoke_position_sale()`: owner signs, the authorization account is closed. Pure — tested. */
export function buildRevokePositionSaleIx(args: {
  programId: PublicKey;
  owner: PublicKey;
  saleAuth: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.saleAuth, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(REVOKE_POSITION_SALE_DISCRIMINATOR),
  });
}

async function revokeCurveSell(
  signer: TxSigner,
  row: AggLimitOrder,
): Promise<CancelLimitOrderResult> {
  const owner = signer.publicKey;
  const saleAuth = new PublicKey(row.order);
  const conn = getConnection();
  const info = await conn.getAccountInfo(saleAuth, "confirmed");
  if (!info) {
    throw new CookieMcpError(
      "that curve sell no longer exists on chain",
      "it was filled, revoked or expired since the listing — run get_limit_orders",
    );
  }
  // Program-scoped facts come from the artifact, not from a constant: the account's owner must be
  // the launchpad we know, and its bytes must decode as an authorization that belongs to us.
  const launchpad = new PublicKey(PROGRAM_IDS.momoswapLaunchpad);
  if (!info.owner.equals(launchpad)) {
    throw new CookieMcpError(
      `that account is owned by ${info.owner.toBase58()}, not the MomoSwap launchpad`,
      "refusing to sign a revoke against an unknown program",
    );
  }
  const auth = decodeSaleAuth(info.data);
  if (!auth) {
    throw new CookieMcpError(
      "that account is not a launchpad sale authorization",
      "pass the `order` of a `curve-sell` row from get_limit_orders",
    );
  }
  if (!auth.owner.equals(owner)) {
    throw new CookieMcpError(
      "that curve sell belongs to another wallet",
      "only the maker can revoke a sale authorization",
    );
  }
  if (row.curvePool && !auth.pool.equals(new PublicKey(row.curvePool))) {
    throw new CookieMcpError(
      "the authorization's pool does not match the listing",
      "refusing to sign; retry get_limit_orders and report this if it persists",
    );
  }

  // `settle_curve_sell(close)` alone burns ~76k CU (measured in LiteSVM: five CPIs to create,
  // fill and close the scratch wrapped account, plus the vault close); 100k left a revoke + settle
  // a few thousand short. 200k is the per-instruction default anyway.
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildRevokePositionSaleIx({ programId: launchpad, owner, saleAuth }),
  ];
  // A vault-paid order also closes its vault (`settle_curve_sell(close = true)`, maker only):
  // anything a keeper left unsettled is paid out first — maker fee included, the rest as native
  // COOK to this wallet — then the rent comes back. Only while the vault still exists: the program
  // cannot deserialize a missing one.
  if (
    isCurveSellVaultPayout(auth) &&
    (await conn.getAccountInfo(auth.payoutAccount, "confirmed")) != null
  ) {
    instructions.push(
      buildSettleCurveSellIx({ payer: owner, maker: owner, pool: auth.pool, close: true }),
    );
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const { signature } = await simulateSignSendConfirm(
    tx,
    signer,
    { blockhash, lastValidBlockHeight },
    "curve-sell revoke",
    { saleAuth: saleAuth.toBase58(), pool: auth.pool.toBase58() },
  );
  const { input } = await resolveMeta(row.inputMint, row.outputMint);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: row.order,
    refund: {
      mint: row.inputMint,
      symbol: input.sym,
      amount: rawToUi(auth.remainingShares.toString(), input.dec),
    },
    unwrappedCook: "0",
    revoked: true,
  };
}

export async function cancelLimitOrder(args: {
  order: string;
  unwrapSol?: boolean;
}): Promise<CancelLimitOrderResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  let order: PublicKey;
  try {
    order = new PublicKey(args.order);
  } catch {
    throw new CookieMcpError("invalid order address", "pass the `order` from get_limit_orders");
  }

  // Look the order up first so the result can name what came back (and so a stranger's order
  // fails with a sentence, not a 403).
  const { orders } = await fetchJson<{ orders: AggLimitOrder[] }>(
    `${COOKIEBOX_AGG_API_URL}/limit-orders?maker=${owner.toBase58()}`,
  ).catch((e) => {
    throw apiError(e, "looking the order up");
  });
  const mine = orders.find((o) => o.order === args.order);
  if (!mine) {
    throw new CookieMcpError(
      "no open order with that address belongs to this wallet",
      "it may be filled, cancelled or another wallet's — run get_limit_orders",
    );
  }
  if (mine.kind === "curve-sell") return revokeCurveSell(signer, mine);

  let built: AggCancelTx;
  try {
    built = await fetchJson<AggCancelTx>(`${COOKIEBOX_AGG_API_URL}/limit-orders/cancel-tx`, {
      method: "POST",
      body: JSON.stringify({
        owner: owner.toBase58(),
        order: args.order,
        ...nativeFlagsBody(args),
      }),
      timeoutMs: BUILD_TX_TIMEOUT_MS,
    });
  } catch (e) {
    throw apiError(e, "cancelling the order");
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  assertCancelTxTrustworthy(tx, { owner, order });

  const { signature } = await simulateSignSendConfirm(tx, signer, built, "limit-order cancel", {
    order,
  });
  const { input } = await resolveMeta(mine.inputMint, mine.outputMint);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: args.order,
    refund: {
      mint: mine.inputMint,
      symbol: input.sym,
      amount: rawToUi(built.refundAmount ?? mine.makingAmount, input.dec),
    },
    unwrappedCook: rawToUi(built.unwrappedLamports ?? "0", 9),
  };
}
