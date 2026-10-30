// Cookiebox Zip — trailing range orders on CLMM positions (`get_zip_orders`, `start_zip`,
// `stop_zip`).
//
// A one-sided CLMM position already IS a range order: it converts one token into the other as the
// price moves through the range, earning LP fees on the way. What it cannot do is hold the fill — if
// the price turns around, the part of the range it already converted converts straight back. Zip
// fixes that with a keeper that keeps moving the range's TRAILING edge up to the price: each move
// withdraws the filled part to the owner's wallet, so nothing is left behind the price to convert
// back. The position NFT never leaves the wallet; the order's PDA is only its SPL delegate, and the
// program lets that delegate do exactly three things (move the edge, finish, and nothing else).
//
// This server starts and stops orders; the Cookiebox keeper cranks them. Starting costs the owner the
// rent of the payout token accounts and of any tick arrays the range spans — the keeper refuses to
// fund either, because rent it paid could be reclaimed by the owner (close and let it recreate) or
// billed to it by a hostile position. Everything the keeper may do afterwards is predicted here from
// the program's own rules (`decision.ts`), so an agent can tell what happens next without a chain.
import { Percentage } from "@orca-so/common-sdk";
import { PriceMath } from "@orca-so/whirlpools-sdk";
import {
  createApproveInstruction,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, Transaction, type AccountInfo, type Connection } from "@solana/web3.js";
import type BN from "bn.js";
import Decimal from "decimal.js";

import { COOK_MINT, ZIP_KEEPER, explorerTxUrl } from "../config";
import { resolveWallet } from "../domains";
import { CookieMcpError } from "../errors";
import { rawToUi, shortAddr, uiToRaw } from "../format";
import {
  assertClmmMintsPoolable,
  builderToTx,
  buildClmmClient,
  CLMM_FEE_TIER_TICK_SPACING,
  CLMM_PROGRAM_ID,
  clmmLockConfigAddress,
  DEFAULT_CLMM_FEE_TIER_BPS,
  depositClmmPosition,
  findClmmPositions,
  legacyTxWireSize,
  OPEN_POSITION_CU,
  openClmmPosition,
  type SendExtra,
} from "../liquidity/clmm";
import { signSendConfirm } from "../liquidity/send";
import { requireMintMeta, resolveMintMeta, type MintMeta } from "../mintMeta";
import { getQuote } from "../quote";
import { getConnection } from "../rpc";
import type { TxSigner } from "../signer";
import { trade } from "../trade";
import { ownPublicKey, requireSigner } from "../wallet";
import { decideZip, withdrawAmounts, type ZipDecision, type ZipDirection } from "./decision";
import {
  depositZipDirection,
  fromEdgeTick,
  pickFeeOption,
  poolMarketTick,
  prepZipPool,
  sellNowInPool,
  sendPrepared,
  standardPoolPda,
  tickOfReceivePerSell,
  touchedByZip,
  zipCrossedShare,
  zipDefaultPrices,
  zipExpectedReceive,
  zipPriceAtTick,
  zipRangeAbove,
  zipRangeFromPrices,
  zipRangePrices,
  ZipMarketMoved,
  ZIP_SELL_NOW_SLIPPAGE_BPS,
  type ZipFeeOption,
  type ZipOrderRange,
  type ZipOrderSide,
} from "./order";
import {
  MAX_RANGE_TICK_ARRAYS,
  buildDisableIx,
  buildEnableIx,
  buildPayoutAtaIxs,
  buildTickArrayInitIxs,
  decodeRangeOrder,
  enableTransactions,
  findPositionNft,
  listRangeOrders,
  missingTickArrays,
  parsePool,
  parsePosition,
  payoutAccounts,
  positionPdaForMint,
  ZIP_PROGRAM_ID,
  rangeOrderPda,
  rangeTickArrayCount,
  rangeTickArrays,
  zipProgram,
  sqrtAt,
  tickArrayFor,
  type PositionNft,
  type RangeOrder,
} from "./program";

export * from "./decision";
export * from "./order";
export * from "./program";

export const ZIP_NAME = "Zip";

// --- pure helpers ---------------------------------------------------------------------------------

/** Which token(s) a position holds right now, from the CLMM's tick convention. */
export type Holdings = "a" | "b" | "both";

export function positionHoldings(tickCurrent: number, lower: number, upper: number): Holdings {
  if (tickCurrent < lower) return "a";
  if (tickCurrent >= upper) return "b";
  return "both";
}

export interface PairTokens {
  mintA: string;
  mintB: string;
  symA: string | null;
  symB: string | null;
}

function label(mint: string, sym: string | null): string {
  return sym ?? shortAddr(mint);
}

/**
 * Which way an order runs, from the token the caller wants to SELL (either pool mint, or "COOK" for
 * the native mint). With `sell` omitted a one-sided position decides for itself; a position holding
 * both tokens needs to be told. Selling a token the position no longer holds is refused: that side
 * has already converted, there is nothing for a zip to do.
 */
export function directionForSell(
  sell: string | undefined,
  pair: PairTokens,
  holdings: Holdings,
): ZipDirection {
  const a = label(pair.mintA, pair.symA);
  const b = label(pair.mintB, pair.symB);
  if (sell === undefined || sell.trim() === "") {
    if (holdings === "a") return "aToB";
    if (holdings === "b") return "bToA";
    throw new CookieMcpError(
      `the position holds both ${a} and ${b}, so the direction is ambiguous`,
      `pass sell: "${pair.mintA}" to sell ${a} for ${b}, or sell: "${pair.mintB}" to sell ${b} for ${a}`,
    );
  }
  const s = sell.trim();
  const mint = s.toUpperCase() === "COOK" ? COOK_MINT : s;
  let direction: ZipDirection;
  if (mint === pair.mintA) direction = "aToB";
  else if (mint === pair.mintB) direction = "bToA";
  else {
    throw new CookieMcpError(
      `sell must be one of the pool's two tokens, got ${s}`,
      `the pool pairs ${a} (${pair.mintA}) with ${b} (${pair.mintB})`,
    );
  }
  const sold = direction === "aToB" ? a : b;
  const received = direction === "aToB" ? b : a;
  const gone = direction === "aToB" ? holdings === "b" : holdings === "a";
  if (gone) {
    throw new CookieMcpError(
      `the position holds no ${sold}: the price is already past its range on that side, so it has ` +
        `fully converted into ${received}`,
      `nothing to zip — remove_liquidity to take the ${received} out, or sell ${received} for ` +
        `${sold} instead (sell: "${direction === "aToB" ? pair.mintB : pair.mintA}")`,
    );
  }
  return direction;
}

/**
 * The transfer-hook program a Token-2022 mint names, or null (classic mint, no hook, or a hook
 * whose program was unset). Token-2022 refuses every transfer of a hooked mint until the hook has
 * published its `ExtraAccountMetaList`, so the keeper skips such an order; `orderStatus` reports it.
 * A Token-2022 mint whose extensions don't parse is refused rather than read as hook-less.
 */
export function transferHookProgramOf(
  mint: PublicKey,
  info: Pick<AccountInfo<Buffer>, "owner" | "data">,
): PublicKey | null {
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  let parsed: ReturnType<typeof unpackMint>;
  try {
    parsed = unpackMint(mint, info as AccountInfo<Buffer>, TOKEN_2022_PROGRAM_ID);
  } catch (e) {
    throw new CookieMcpError(
      `could not read the Token-2022 extensions of mint ${mint.toBase58()} (${(e as Error).message})`,
      "its transfer hook can't be checked, so nothing was sent; retry, or pick another pool",
    );
  }
  const hook = getTransferHook(parsed);
  return hook && !hook.programId.equals(PublicKey.default) ? hook.programId : null;
}

/** Who cranks an order: Cookiebox's keeper (the default), anyone, or a key of the caller's choosing. */
export type KeeperKind = "cookiebox" | "anyone" | "custom";

export function keeperKind(cranker: PublicKey | null): KeeperKind {
  if (!cranker) return "anyone";
  return cranker.toBase58() === ZIP_KEEPER ? "cookiebox" : "custom";
}

/** Parse the `cranker` argument: omitted / "cookiebox" → the keeper; "anyone" → unpinned; else a key. */
export function resolveCranker(input?: string): { cranker: PublicKey | null; keeper: KeeperKind } {
  const s = input?.trim() ?? "";
  if (s === "" || s.toLowerCase() === "cookiebox" || s.toLowerCase() === "keeper") {
    return { cranker: new PublicKey(ZIP_KEEPER), keeper: "cookiebox" };
  }
  if (s.toLowerCase() === "anyone" || s.toLowerCase() === "none") {
    return { cranker: null, keeper: "anyone" };
  }
  let pk: PublicKey;
  try {
    pk = new PublicKey(s);
  } catch {
    throw new CookieMcpError(
      `cranker must be a public key, "cookiebox" or "anyone", got ${s}`,
      "omit it to let the Cookiebox keeper run the order",
    );
  }
  return { cranker: pk, keeper: keeperKind(pk) };
}

export type OrderStatus = "filling" | "waiting" | "fully-filled" | "paused" | "empty";

/** A finished order's leftover: the empty position, closed by `stop_zip` to return its rent. */
export const FILLED_DETAIL =
  "filled — the keeper paid everything out and closed the order; the empty position is left for " +
  "you to close: stop_zip with `position` = its NFT mint returns the position's rent";

/** What the keeper will do with an order on its next pass, in words. */
export function describeDecision(
  d: ZipDecision,
  p: { direction: ZipDirection; minStep: number; sold: string; received: string },
): string {
  if (d.kind === "finish") {
    return (
      `fully filled — the keeper's next pass withdraws the ${p.received} and the earned fees to the ` +
      `wallet and closes the order`
    );
  }
  if (d.kind === "zip") {
    const edge =
      p.direction === "aToB"
        ? `lower edge up to tick ${d.lower}`
        : `upper edge down to tick ${d.upper}`;
    return `the keeper's next pass moves the ${edge} and pays the filled ${p.received} to the wallet`;
  }
  switch (d.reason) {
    case "stepTooSmall":
      return (
        `waiting for the price to move ${p.minStep} tick spacing${p.minStep === 1 ? "" : "s"} past ` +
        `the trailing edge`
      );
    case "lastSpacing":
      return (
        "waiting in the range's last tick spacing: the edge cannot move any closer, the keeper " +
        `finishes once the price crosses the far edge and the last ${p.sold} has converted`
      );
    case "noLiquidity":
      return "nothing is left to fill — stop_zip closes the order and the position";
    case "liquidityBelowFloor":
      return "waiting (the re-deposit would not fit the liquidity floor; the keeper retries)";
    case "fullyFilled":
      // `decideZip` reports a filled range as `finish`; only a bare `nextRange` says this.
      return `fully filled — nothing of the ${p.sold} is left to convert`;
  }
}

/**
 * An order's status from the keeper's decision and the four things that pause an order: the NFT
 * delegation being gone, a transfer hook with no published extra-account list, a payout account
 * the owner closed, and a tick array the next move needs. Pure, so the rule is testable; the reads
 * happen in the caller.
 */
export function orderStatus(p: {
  decision: ZipDecision;
  delegated: boolean;
  /** Hooked pool mints whose hook has published no `ExtraAccountMetaList` (labels). */
  missingHookMetaLists: string[];
  missingPayout: string[];
  missingTickArrays: number;
  next: string;
}): { status: OrderStatus; detail: string } {
  // `position`, not `pool`: by pool, start_zip would pick a position without an order.
  const onIt = "start_zip with `position` set to this order's positionMint";
  const repair = `${onIt} recreates it (owner-paid) without stopping the order`;
  if (!p.delegated) {
    return {
      status: "paused",
      detail:
        "the position NFT is no longer delegated to the order (approval revoked or NFT moved), so " +
        `the keeper cannot move the edge — if you still hold the NFT, ${onIt} re-approves it ` +
        "without stopping the order; otherwise stop_zip",
    };
  }
  if (p.missingHookMetaLists.length) {
    return {
      status: "paused",
      detail:
        `${hookUnpublished(p.missingHookMetaLists)}, and the keeper skips this order until the ` +
        "issuer publishes one",
    };
  }
  if (p.missingPayout.length) {
    return {
      status: "paused",
      detail:
        `the owner's ${p.missingPayout.join(" and ")} token account was closed; the keeper will not ` +
        `recreate it — ${repair}`,
    };
  }
  if (p.missingTickArrays > 0) {
    return {
      status: "paused",
      detail: `${p.missingTickArrays} tick array(s) the next move needs do not exist — ${repair}`,
    };
  }
  if (p.decision.kind === "finish") return { status: "fully-filled", detail: p.next };
  if (p.decision.kind === "zip") return { status: "filling", detail: p.next };
  if (p.decision.reason === "noLiquidity") return { status: "empty", detail: p.next };
  return { status: "waiting", detail: p.next };
}

// --- chain context --------------------------------------------------------------------------------

interface PositionContext {
  positionPk: PublicKey;
  position: ReturnType<typeof parsePosition>;
  poolPk: PublicKey;
  pool: ReturnType<typeof parsePool>;
  nft: PositionNft | null;
  /** Permanently locked via the CLMM's `lock_position`: Zip cannot reposition it. */
  locked: boolean;
  orderPk: PublicKey;
  order: RangeOrder | null;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
  mintAInfo: AccountInfo<Buffer>;
  mintBInfo: AccountInfo<Buffer>;
  metaA: MintMeta;
  metaB: MintMeta;
}

async function loadPositionContext(
  conn: Connection,
  positionPk: PublicKey,
  positionInfo?: AccountInfo<Buffer> | null,
): Promise<PositionContext> {
  const info =
    positionInfo === undefined ? await conn.getAccountInfo(positionPk, "confirmed") : positionInfo;
  const position = parsePosition(positionPk, info);
  const poolPk = position.whirlpool;
  const orderPk = rangeOrderPda(positionPk);
  const [poolInfo, lockInfo, orderInfo] = await conn.getMultipleAccountsInfo(
    [poolPk, clmmLockConfigAddress(positionPk), orderPk],
    "confirmed",
  );
  const pool = parsePool(poolPk, poolInfo ?? null);
  const [mintAInfo, mintBInfo] = await conn.getMultipleAccountsInfo(
    [pool.tokenMintA, pool.tokenMintB],
    "confirmed",
  );
  if (!mintAInfo || !mintBInfo) {
    throw new CookieMcpError("a pool mint account is missing on chain", "check chain_health");
  }
  const [nft, meta] = await Promise.all([
    findPositionNft(conn, position.positionMint),
    resolveMintMeta([pool.tokenMintA.toBase58(), pool.tokenMintB.toBase58()]),
  ]);
  return {
    positionPk,
    position,
    poolPk,
    pool,
    nft,
    locked: lockInfo != null,
    orderPk,
    order: orderInfo ? decodeRangeOrder(orderInfo.data) : null,
    tokenProgramA: mintAInfo.owner,
    tokenProgramB: mintBInfo.owner,
    mintAInfo,
    mintBInfo,
    metaA: requireMintMeta(meta, pool.tokenMintA.toBase58()),
    metaB: requireMintMeta(meta, pool.tokenMintB.toBase58()),
  };
}

function pairOf(ctx: PositionContext): PairTokens {
  return {
    mintA: ctx.pool.tokenMintA.toBase58(),
    mintB: ctx.pool.tokenMintB.toBase58(),
    symA: ctx.metaA.sym,
    symB: ctx.metaB.sym,
  };
}

function currentPrice(ctx: PositionContext): string {
  return PriceMath.sqrtPriceX64ToPrice(ctx.pool.sqrtPrice as BN, ctx.metaA.dec, ctx.metaB.dec)
    .toSignificantDigits(9)
    .toString();
}

function decisionFor(ctx: PositionContext, direction: ZipDirection, minStep: number) {
  return decideZip({
    direction,
    minStep,
    tickSpacing: ctx.pool.tickSpacing,
    tickCurrent: ctx.pool.tickCurrentIndex,
    sqrtPrice: BigInt(ctx.pool.sqrtPrice.toString()),
    liquidity: BigInt(ctx.position.liquidity.toString()),
    lower: ctx.position.tickLowerIndex,
    upper: ctx.position.tickUpperIndex,
    sqrtAt,
  });
}

export interface TokenRef {
  mint: string;
  symbol: string | null;
}

export interface RangeView {
  lowerTick: number;
  upperTick: number;
  /** The order's prices in `priceUnit` (receive per sell): `from` is the worst fill, `to` the best. */
  from: string;
  to: string;
}

/** The side a direction sells, as the price helpers take it. */
function sideOf(ctx: PositionContext, direction: ZipDirection): ZipOrderSide {
  return {
    sellIsA: direction === "aToB",
    decA: ctx.metaA.dec,
    decB: ctx.metaB.dec,
    tickSpacing: ctx.pool.tickSpacing,
  };
}

/**
 * The position's shape, shared by every result: pair, range, price and what it holds now. Prices
 * are **receive per sell** (what one sold token fetches), as Cookiebox's Zip tab shows them; with
 * no direction (a filled order, whose account is gone) they are tokenB per tokenA.
 */
function positionView(ctx: PositionContext, direction: ZipDirection | null) {
  const pair = pairOf(ctx);
  const a = label(pair.mintA, pair.symA);
  const b = label(pair.mintB, pair.symB);
  const side = sideOf(ctx, direction ?? "aToB");
  const sells = side.sellIsA ? a : b;
  const receives = side.sellIsA ? b : a;
  const lower = ctx.position.tickLowerIndex;
  const upper = ctx.position.tickUpperIndex;
  const [fromTick, toTick] = side.sellIsA ? [lower, upper] : [upper, lower];
  const fmt = (d: Decimal) => d.toSignificantDigits(9).toString();
  const held = withdrawAmounts({
    liquidity: BigInt(ctx.position.liquidity.toString()),
    tickCurrent: ctx.pool.tickCurrentIndex,
    sqrtPrice: BigInt(ctx.pool.sqrtPrice.toString()),
    lower: ctx.position.tickLowerIndex,
    upper: ctx.position.tickUpperIndex,
    sqrtLower: sqrtAt(ctx.position.tickLowerIndex),
    sqrtUpper: sqrtAt(ctx.position.tickUpperIndex),
  });
  return {
    position: ctx.positionPk.toBase58(),
    positionMint: ctx.position.positionMint.toBase58(),
    pool: ctx.poolPk.toBase58(),
    pair: `${a}/${b}`,
    tokenA: { mint: pair.mintA, symbol: pair.symA } as TokenRef,
    tokenB: { mint: pair.mintB, symbol: pair.symB } as TokenRef,
    priceUnit: `${receives} per ${sells}`,
    range: {
      lowerTick: lower,
      upperTick: upper,
      from: fmt(zipPriceAtTick(side, fromTick)),
      to: fmt(zipPriceAtTick(side, toTick)),
    } as RangeView,
    price: {
      tick: ctx.pool.tickCurrentIndex,
      current: fmt(
        side.sellIsA
          ? new Decimal(currentPrice(ctx))
          : new Decimal(1).div(new Decimal(currentPrice(ctx))),
      ),
    },
    tickSpacing: ctx.pool.tickSpacing,
    liquidity: ctx.position.liquidity.toString(),
    inPosition: {
      [a]: rawToUi(held.a, ctx.metaA.dec),
      [b]: rawToUi(held.b, ctx.metaB.dec),
    } as Record<string, string>,
  };
}

function soldReceived(ctx: PositionContext, direction: ZipDirection) {
  const pair = pairOf(ctx);
  const A: TokenRef = { mint: pair.mintA, symbol: pair.symA };
  const B: TokenRef = { mint: pair.mintB, symbol: pair.symB };
  return direction === "aToB" ? { sells: A, receives: B } : { sells: B, receives: A };
}

function tokenNotes(ctx: PositionContext): string[] {
  const notes: string[] = [];
  for (const [meta, prog, mint] of [
    [ctx.metaA, ctx.tokenProgramA, ctx.pool.tokenMintA],
    [ctx.metaB, ctx.tokenProgramB, ctx.pool.tokenMintB],
  ] as const) {
    if (prog.equals(TOKEN_2022_PROGRAM_ID)) {
      notes.push(
        `${label(mint.toBase58(), meta.sym)} is a Token-2022 mint: payouts in it arrive net of any ` +
          "transfer fee, and a transfer hook that refuses a payout pauses the order (nothing else moves)",
      );
    }
  }
  return notes;
}

/**
 * Labels of the pool mints whose transfer hook has published no `ExtraAccountMetaList`. Token-2022
 * refuses every transfer of such a mint, so the keeper skips the order (cookiebox's keeper logs
 * "missing hook meta list" and moves on). Empty for classic and hook-less mints, with no read.
 */
async function missingHookMetaLists(
  conn: Connection,
  mints: { mint: PublicKey; info: AccountInfo<Buffer>; sym: string | null }[],
): Promise<string[]> {
  const hooked = mints
    .map((m) => ({ ...m, hook: transferHookProgramOf(m.mint, m.info) }))
    .filter((h): h is typeof h & { hook: PublicKey } => h.hook != null);
  if (hooked.length === 0) return [];
  const infos = await conn.getMultipleAccountsInfo(
    hooked.map((h) => getExtraAccountMetaAddress(h.mint, h.hook)),
    "confirmed",
  );
  return hooked.filter((_, i) => !infos[i]).map((h) => label(h.mint.toBase58(), h.sym));
}

/** The position's two pool mints, as `missingHookMetaLists` takes them. */
function poolMints(ctx: PositionContext) {
  return [
    { mint: ctx.pool.tokenMintA, info: ctx.mintAInfo, sym: ctx.metaA.sym },
    { mint: ctx.pool.tokenMintB, info: ctx.mintBInfo, sym: ctx.metaB.sym },
  ];
}

function hookUnpublished(labels: string[]): string {
  return (
    `the ${labels.join(" and ")} transfer hook has published no extra-account list on chain, so ` +
    "Token-2022 cannot move the token"
  );
}

/** `start_zip`'s refusal for a pool with such a hook: the keeper could never crank the order. */
function hookRefusal(labels: string[]): CookieMcpError {
  return new CookieMcpError(
    `${hookUnpublished(labels)} and the keeper could never crank this order`,
    "ask the issuer to publish the hook's ExtraAccountMetaList, or pick another pool",
  );
}

// --- resolving which position -------------------------------------------------------------------

function positionKey(arg: string): PublicKey {
  try {
    return new PublicKey(arg.trim());
  } catch {
    throw new CookieMcpError(
      `invalid position: ${arg}`,
      "pass the position NFT mint or the position account (base58)",
    );
  }
}

/**
 * The position an argument names: `position` is the NFT mint (what cookiebox.app/position/<mint>
 * shows) or the position account; `pool` means "my position in that pool" and needs a signer.
 */
async function resolvePosition(
  conn: Connection,
  args: { position?: string; pool?: string },
  signer: TxSigner | null,
  mode: "start" | "stop",
): Promise<{ positionPk: PublicKey; info?: AccountInfo<Buffer> }> {
  if (args.position) {
    const pk = positionKey(args.position);
    const candidates = [positionPdaForMint(pk), pk];
    const infos = await conn.getMultipleAccountsInfo(candidates, "confirmed");
    for (let i = 0; i < candidates.length; i++) {
      const info = infos[i];
      if (info && info.owner.equals(CLMM_PROGRAM_ID)) return { positionPk: candidates[i]!, info };
    }
    throw new CookieMcpError(
      `no Cookiebox CLMM position for ${args.position}`,
      "pass the position NFT mint (see cookiebox.app/positions, or get_balance for NFT mints you hold)",
    );
  }
  if (args.pool) {
    if (!signer) {
      throw new CookieMcpError(
        "`pool` needs a wallet to look up your position in it",
        "pass `position` (the NFT mint) instead, or configure a signer",
      );
    }
    let poolPk: PublicKey;
    try {
      poolPk = new PublicKey(args.pool.trim());
    } catch {
      throw new CookieMcpError(`invalid pool address: ${args.pool}`, "pass a valid pool pubkey");
    }
    const client = buildClmmClient(conn, signer);
    const mine = await findClmmPositions(conn, client, signer.publicKey, poolPk);
    if (mine.length === 0) {
      throw new CookieMcpError(
        "no CLMM position of yours in that pool",
        "add_liquidity on the cookiebox-clmm pool first, or check the pool address",
      );
    }
    const orderInfos = await conn.getMultipleAccountsInfo(
      mine.map((p) => rangeOrderPda(p.positionAddress)),
      "confirmed",
    );
    const withOrder = mine.filter((_, i) => orderInfos[i] != null);
    // Stop: a running order, else a filled order's leftover (an empty position) to close.
    const usable =
      mode === "stop"
        ? withOrder.length
          ? withOrder
          : mine.filter((p) => p.liquidity.isZero())
        : mine.filter((p, i) => !orderInfos[i] && !p.locked && p.liquidity.gtn(0));
    // Nothing left to start but one running order: that one is meant — start repairs it.
    if (mode === "start" && usable.length === 0 && withOrder.length === 1) {
      return { positionPk: withOrder[0]!.positionAddress };
    }
    if (usable.length === 0) {
      throw mode === "stop"
        ? new CookieMcpError(
            "none of your positions in that pool has a Zip order running",
            "nothing to stop — get_zip_orders lists the ones that do",
          )
        : new CookieMcpError(
            withOrder.length
              ? "every usable position of yours in that pool already has a Zip order running"
              : "no position of yours in that pool can be zipped (locked or empty)",
            withOrder.length
              ? "to repair a paused one, pass `position` with its NFT mint " +
                  `(${withOrder.map((p) => p.positionMint.toBase58()).join(", ")}); ` +
                  "stop_zip one first to change its direction"
              : "a Zip needs an unlocked position with liquidity",
          );
    }
    if (usable.length > 1) {
      throw new CookieMcpError(
        `you hold ${usable.length} such positions in that pool`,
        `pass \`position\` with one of their NFT mints: ${usable.map((p) => p.positionMint.toBase58()).join(", ")}`,
      );
    }
    // Not read here: `loadPositionContext` fetches it (an `undefined` info means "not fetched yet").
    return { positionPk: usable[0]!.positionAddress };
  }
  throw new CookieMcpError(
    "pass `position` (the position NFT mint) or `pool`",
    "get_zip_orders / get_balance show the NFT mints; `pool` picks your position in that pool",
  );
}

type Owned = Pick<AccountInfo<Buffer>, "owner"> | null;

/**
 * Which account a `stop_zip` `position` argument names, from one read of: the argument itself,
 * the order of the position the argument mints, the order of the argument read as a position
 * account, and the position the argument mints. The argument may be the NFT mint, the position
 * account or the order itself, and an order is found even when its position is gone (stale), since
 * `disable` needs neither the position nor the NFT. Pure, so the rule is testable.
 */
export function pickStopOrder(reads: {
  arg: Owned;
  orderForMint: Owned;
  orderForAccount: Owned;
  positionForMint: Owned;
}): "arg" | "orderForMint" | "orderForAccount" | "noOrder" | "notFound" {
  const isOrder = (i: Owned) => i?.owner.equals(ZIP_PROGRAM_ID) ?? false;
  const isPosition = (i: Owned) => i?.owner.equals(CLMM_PROGRAM_ID) ?? false;
  if (isOrder(reads.arg)) return "arg";
  if (isOrder(reads.orderForMint)) return "orderForMint";
  if (isOrder(reads.orderForAccount)) return "orderForAccount";
  return isPosition(reads.positionForMint) || isPosition(reads.arg) ? "noOrder" : "notFound";
}

const NO_ORDER = () =>
  new CookieMcpError(
    "this position has no Zip order running",
    "nothing to stop — get_zip_orders lists the ones that do",
  );

type StopTarget = {
  /** The running (or stale) order, or null for a filled order's leftover position. */
  order: { orderPk: PublicKey; order: RangeOrder } | null;
  /** Set when `order` is null: the empty position to close. */
  positionPk?: PublicKey;
};

/**
 * What `stop_zip` names, read straight from the program: a running order (its position may be
 * gone), or a position with no order left — a filled order's leftover, which the stop closes.
 */
async function resolveStopOrder(
  conn: Connection,
  args: { position?: string; pool?: string },
  signer: TxSigner,
): Promise<StopTarget> {
  if (args.position) {
    const arg = positionKey(args.position);
    const positionForMint = positionPdaForMint(arg);
    const keys = {
      arg,
      orderForMint: rangeOrderPda(positionForMint),
      orderForAccount: rangeOrderPda(arg),
    };
    const [argInfo, orderForMint, orderForAccount, positionInfo] =
      await conn.getMultipleAccountsInfo(
        [keys.arg, keys.orderForMint, keys.orderForAccount, positionForMint],
        "confirmed",
      );
    const infos = {
      arg: argInfo ?? null,
      orderForMint: orderForMint ?? null,
      orderForAccount: orderForAccount ?? null,
    };
    const pick = pickStopOrder({ ...infos, positionForMint: positionInfo ?? null });
    if (pick === "noOrder") {
      // A position without an order: closable here only when it is a filled order's leftover.
      const positionPk = positionInfo?.owner.equals(CLMM_PROGRAM_ID) ? positionForMint : arg;
      const info = positionPk.equals(arg) ? argInfo! : positionInfo!;
      if (!parsePosition(positionPk, info).liquidity.isZero()) throw NO_ORDER();
      return { order: null, positionPk };
    }
    if (pick === "notFound") {
      throw new CookieMcpError(
        `no Cookiebox CLMM position or Zip order for ${args.position}`,
        "pass the position NFT mint, the position account or the order address (get_zip_orders lists them)",
      );
    }
    return { order: { orderPk: keys[pick], order: decodeRangeOrder(infos[pick]!.data) } };
  }
  const { positionPk } = await resolvePosition(conn, args, signer, "stop");
  const orderPk = rangeOrderPda(positionPk);
  const info = await conn.getAccountInfo(orderPk, "confirmed");
  if (!info) return { order: null, positionPk };
  return { order: { orderPk, order: decodeRangeOrder(info.data) } };
}

// --- reads ----------------------------------------------------------------------------------------

export interface ZipOrderView {
  /** The order account; for a filled order (account closed) its former address. */
  order: string;
  owner: string;
  status: OrderStatus | "stale" | "filled";
  /** What the status means and what the keeper does next, in words. */
  detail: string;
  direction: ZipDirection;
  sells: TokenRef;
  receives: TokenRef;
  minStep: number;
  cranker: string | null;
  keeper: KeeperKind;
  /** The NFT holder's wallet, when it is not the order's owner (the NFT moved; the order is stale). */
  nftHeldBy?: string;
  position: string;
  positionMint: string;
  pool?: string;
  pair?: string;
  priceUnit?: string;
  range?: RangeView;
  price?: { tick: number; current: string };
  inPosition?: Record<string, string>;
  notes?: string[];
}

async function describeOrder(
  conn: Connection,
  address: PublicKey,
  order: RangeOrder,
): Promise<ZipOrderView> {
  // Stale only when the position account is really gone. Any other failure (an RPC error, missing
  // mint metadata) propagates: a flaky read must never tell the agent to stop a live order.
  const positionInfo = await conn.getAccountInfo(order.position, "confirmed");
  if (!positionInfo) {
    return {
      order: address.toBase58(),
      owner: order.owner.toBase58(),
      status: "stale",
      detail:
        "the position account no longer exists (closed) — stop_zip with `position` = this " +
        "order's address or its NFT mint closes the order and refunds its rent to the owner",
      direction: order.direction,
      sells: { mint: "", symbol: null },
      receives: { mint: "", symbol: null },
      minStep: order.minStep,
      cranker: order.cranker?.toBase58() ?? null,
      keeper: keeperKind(order.cranker),
      position: order.position.toBase58(),
      positionMint: order.positionMint.toBase58(),
    };
  }
  const ctx = await loadPositionContext(conn, order.position, positionInfo);
  const view = positionView(ctx, order.direction);
  const { sells, receives } = soldReceived(ctx, order.direction);
  const decision = decisionFor(ctx, order.direction, order.minStep);
  const next = describeDecision(decision, {
    direction: order.direction,
    minStep: order.minStep,
    sold: label(sells.mint, sells.symbol),
    received: label(receives.mint, receives.symbol),
  });

  const payout = payoutAccounts({
    order: address,
    owner: order.owner,
    mintA: ctx.pool.tokenMintA,
    mintB: ctx.pool.tokenMintB,
    tokenProgramA: ctx.tokenProgramA,
    tokenProgramB: ctx.tokenProgramB,
  });
  const needed =
    decision.kind === "zip"
      ? [
          tickArrayFor(ctx.poolPk, decision.lower, ctx.pool.tickSpacing),
          tickArrayFor(ctx.poolPk, decision.upper, ctx.pool.tickSpacing),
        ]
      : [];
  const [ataInfos, missingArrays, noMetaLists] = await Promise.all([
    payout.ownerAtas.length
      ? conn.getMultipleAccountsInfo(
          payout.ownerAtas.map((a) => a.address),
          "confirmed",
        )
      : Promise.resolve([] as (AccountInfo<Buffer> | null)[]),
    needed.length ? missingTickArrays(conn, needed) : Promise.resolve([]),
    missingHookMetaLists(conn, poolMints(ctx)),
  ]);
  const missingPayout = payout.ownerAtas
    .filter((_, i) => !ataInfos[i])
    .map((a) =>
      label(a.mint.toBase58(), a.mint.equals(ctx.pool.tokenMintA) ? ctx.metaA.sym : ctx.metaB.sym),
    );
  const delegated = ctx.nft?.delegate?.equals(address) ?? false;
  const { status, detail } = orderStatus({
    decision,
    delegated,
    missingHookMetaLists: noMetaLists,
    missingPayout,
    missingTickArrays: missingArrays.length,
    next,
  });
  const notes = tokenNotes(ctx);
  const keeper = keeperKind(order.cranker);
  if (keeper === "custom") {
    notes.push(
      `only ${order.cranker!.toBase58()} may crank this order — the Cookiebox keeper will not touch it`,
    );
  } else if (keeper === "anyone") {
    notes.push(
      "anyone may crank this order; a hostile cranker can hand most of it back unconverted " +
        "(see the Zip trust model) — the Cookiebox keeper does crank unpinned orders",
    );
  }
  const nftHeldBy =
    ctx.nft && !ctx.nft.holder.equals(order.owner) ? ctx.nft.holder.toBase58() : undefined;
  return {
    order: address.toBase58(),
    owner: order.owner.toBase58(),
    status,
    detail,
    direction: order.direction,
    sells,
    receives,
    minStep: order.minStep,
    cranker: order.cranker?.toBase58() ?? null,
    keeper,
    ...(nftHeldBy ? { nftHeldBy } : {}),
    ...view,
    ...(notes.length ? { notes } : {}),
  };
}

export interface ZipOrdersResult {
  owner: string;
  ownerName?: string;
  count: number;
  orders: ZipOrderView[];
}

/** A wallet's open Zip orders, read straight from the program (no key needed). */
export async function getZipOrders(args: { owner?: string }): Promise<ZipOrdersResult> {
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
  const conn = getConnection();
  const ownerPk = new PublicKey(owner);
  const [found, filled] = await Promise.all([
    listRangeOrders(conn, ownerPk),
    filledZipPositions(conn, ownerPk),
  ]);
  const orders = await Promise.all(found.map((f) => describeOrder(conn, f.address, f.order)));
  for (const f of filled) {
    const ctx = await loadPositionContext(conn, f.positionPk, f.info);
    orders.push({
      order: ctx.orderPk.toBase58(),
      owner,
      status: "filled",
      detail: FILLED_DETAIL,
      direction: "aToB",
      sells: { mint: "", symbol: null },
      receives: { mint: "", symbol: null },
      minStep: 0,
      cranker: null,
      keeper: "cookiebox",
      ...positionView(ctx, null),
    });
  }
  return { owner, ...(ownerName ? { ownerName } : {}), count: orders.length, orders };
}

/** Recent order-PDA transactions read to tell a finished order from a stray transfer. */
const FILLED_HISTORY_SIGS = 5;

/**
 * The wallet's empty CLMM positions left behind by a finished Zip order (the keeper's `finish`
 * closed the order; only the owner can close the position). Found through the wallet's position
 * NFTs, then the order PDA's history: one of its recent transactions must name the Zip program.
 */
async function filledZipPositions(
  conn: Connection,
  owner: PublicKey,
): Promise<{ positionPk: PublicKey; info: AccountInfo<Buffer> }[]> {
  const [spl, spl2022] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(SPL_TOKEN_ID) }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const mints: PublicKey[] = [];
  for (const { account } of [...spl.value, ...spl2022.value]) {
    const parsed = (
      account.data as {
        parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number }; mint?: string } };
      }
    ).parsed?.info;
    if (parsed?.tokenAmount?.amount === "1" && parsed.tokenAmount.decimals === 0 && parsed.mint) {
      mints.push(new PublicKey(parsed.mint));
    }
  }
  if (mints.length === 0) return [];
  const pdas = mints.map(positionPdaForMint);
  const infos: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < pdas.length; i += 100) {
    infos.push(...(await conn.getMultipleAccountsInfo(pdas.slice(i, i + 100), "confirmed")));
  }
  const empty = pdas
    .map((pk, i) => ({ pk, info: infos[i] }))
    .filter((x): x is { pk: PublicKey; info: AccountInfo<Buffer> } => {
      if (!x.info || !x.info.owner.equals(CLMM_PROGRAM_ID)) return false;
      return parsePosition(x.pk, x.info).liquidity.isZero();
    });
  if (empty.length === 0) return [];
  const orderInfos = await conn.getMultipleAccountsInfo(
    empty.map((x) => rangeOrderPda(x.pk)),
    "confirmed",
  );
  const out: { positionPk: PublicKey; info: AccountInfo<Buffer> }[] = [];
  await Promise.all(
    empty.map(async (x, i) => {
      // An open order (Zip-owned PDA) is listed by `listRangeOrders`, not here.
      if (orderInfos[i]?.owner.equals(ZIP_PROGRAM_ID)) return;
      try {
        if (await orderPdaTouchedByZip(conn, rangeOrderPda(x.pk))) {
          out.push({ positionPk: x.pk, info: x.info });
        }
      } catch {
        // Unknown stays unlisted: a flaky read must not invent an order.
      }
    }),
  );
  return out;
}

async function orderPdaTouchedByZip(conn: Connection, orderPk: PublicKey): Promise<boolean> {
  const sigs = (
    await conn.getSignaturesForAddress(orderPk, { limit: FILLED_HISTORY_SIGS }, "confirmed")
  ).filter((s) => !s.err);
  if (sigs.length === 0) return false;
  const txs = await conn.getTransactions(
    sigs.map((s) => s.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  );
  return touchedByZip(
    ZIP_PROGRAM_ID,
    txs.map((tx) => tx?.transaction.message.getAccountKeys().staticAccountKeys ?? null),
  );
}

const SPL_TOKEN_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// --- writes ---------------------------------------------------------------------------------------

export interface StartZipArgs {
  /** The token to sell: a mint, or "COOK". With `position`, which side of that position to sell. */
  sell?: string;
  /** The token to receive: a mint, or "COOK". */
  receive?: string;
  /** How much of `sell` the order sells (UI units). */
  amount?: string | number;
  /**
   * The order's prices, **receive per sell** (what one sold token fetches): `from` is the price
   * nothing sells under, `to` the best one. Default: from one price step past the market to 10%
   * above it. Whatever part of the range the market already beats is sold at once, never under
   * `from`; the rest waits above the market.
   */
  from?: string | number;
  to?: string | number;
  /** The LP fee the order earns, in bps (the pool it goes into). Default: the pair's deepest pool. */
  fee?: number;
  /**
   * Instead of sell/receive/amount: a CLMM position you already hold, by NFT mint (or position
   * account). Zips it as it is (one-sided; `sell` picks the side of one holding both), or repairs a
   * paused order already running on it.
   */
  position?: string;
  /** Tick spacings the price must move past the edge before it follows (default 1). */
  minStep?: number;
  /** Who may crank: omitted = the Cookiebox keeper; "anyone"; or a public key. */
  cranker?: string;
}

export interface StartZipResult extends ReturnType<typeof positionView> {
  signature: string;
  explorerUrl: string;
  /** Every transaction this call landed, oldest first (a sale, a pool, tick arrays, the open, the start). */
  signatures: string[];
  order: string;
  direction: ZipDirection;
  sells: TokenRef;
  receives: TokenRef;
  minStep: number;
  cranker: string | null;
  keeper: KeeperKind;
  /** What the keeper does next, from the program's rules and the current price. */
  next: string;
  /** Owner-paid setup this start included (idempotent: 0 when they already existed). */
  created: { tickArrays: number; payoutAccounts: number; pool: boolean };
  /** Sold at once because the market already paid more than those prices (UI units of `sell`). */
  soldNow?: { amount: string; signature: string | null };
  /** Set when this call opened the position too; `signature` null = it existed already. */
  opened?: { positionMint: string; signature: string | null; explorerUrl: string | null };
  /** Set when the order was already running and this call only recreated what the keeper needs. */
  repaired?: { delegation: boolean };
  notes: string[];
}

/** `start_zip` sold the whole order at once: the market already beat every price in the range. */
export interface SwappedResult {
  swapped: true;
  signature: string;
  explorerUrl: string;
  signatures: string[];
  sold: string;
  sells: TokenRef;
  receives: TokenRef;
  note: string;
}

export const MIN_STEP_MAX = 65_535;

/**
 * Place a Zip order the way Cookiebox's /trade tab does: `sell` `amount` for `receive` between
 * `from` and `to` (receive per sell). In order: sell what the market already beats (in the pool
 * when it is live, else through the router, never under `from`); get the pool ready (created if
 * the pair has none at that fee, an empty one moved to the order); open a one-sided position with
 * the rest and `enable` the order. Every transaction is simulated before signing; with an external
 * signer each step is handed back (`intermediate`) and the tool is called again to continue — the
 * flow re-prices against the market on every call, so nothing is sold twice.
 *
 * With `position`, zips (or repairs) a CLMM position the wallet already holds.
 */
export async function startZip(args: StartZipArgs): Promise<StartZipResult | SwappedResult> {
  const signer = requireSigner();
  const conn = getConnection();

  const minStep = args.minStep ?? 1;
  if (!Number.isInteger(minStep) || minStep < 1 || minStep > MIN_STEP_MAX) {
    throw new CookieMcpError(
      `minStep must be an integer from 1 to ${MIN_STEP_MAX}`,
      "it counts tick spacings; 1 follows the price as closely as the pool allows",
    );
  }
  const { cranker, keeper } = resolveCranker(args.cranker);
  const settings = { minStep, cranker, keeper };

  if (args.position) {
    if (args.receive != null || args.amount != null || args.from != null || args.to != null) {
      throw new CookieMcpError(
        "`position` zips a position you hold; receive/amount/from/to place a new order",
        "pass one or the other",
      );
    }
    const { positionPk, info } = await resolvePosition(conn, args, signer, "start");
    const ctx = await loadPositionContext(conn, positionPk, info);
    return zipExisting(conn, signer, ctx, args.sell, settings, null, { sigs: [], pool: false });
  }
  return placeZip(conn, signer, args, settings);
}

type Settings = { minStep: number; cranker: PublicKey | null; keeper: KeeperKind };

/** Zip a position the wallet holds (opened by this call, or held before): checks, setup, `enable`. */
async function zipExisting(
  conn: Connection,
  signer: TxSigner,
  ctx: PositionContext,
  sell: string | undefined,
  settings: Settings,
  opened: OpenedForZip | null,
  landed: { sigs: string[]; soldNow?: { amount: string; signature: string | null }; pool: boolean },
): Promise<StartZipResult> {
  const owner = signer.publicKey;
  const { minStep, cranker, keeper } = settings;
  const pair = pairOf(ctx);
  const args = { sell };

  if (ctx.order) return repairZip(conn, signer, { ...ctx, order: ctx.order });
  if (!ctx.nft || !ctx.nft.holder.equals(owner)) {
    throw new CookieMcpError(
      ctx.nft
        ? `the position NFT is held by ${ctx.nft.holder.toBase58()}, not this wallet`
        : "the position NFT was not found in any wallet",
      "only the NFT holder can start a Zip on a position",
    );
  }
  if (ctx.locked) {
    throw new CookieMcpError(
      "this CLMM position is permanently locked, and the CLMM refuses to reposition a locked position",
      "a Zip needs an unlocked position; its fees are still claimable via claim_fees",
    );
  }
  if (ctx.position.liquidity.isZero()) {
    throw new CookieMcpError(
      "this position has no liquidity, so there is nothing to fill",
      "add_liquidity to it first, or pick another position",
    );
  }
  const holdings = positionHoldings(
    ctx.pool.tickCurrentIndex,
    ctx.position.tickLowerIndex,
    ctx.position.tickUpperIndex,
  );
  const direction = directionForSell(args.sell, pair, holdings);
  const { sells, receives } = soldReceived(ctx, direction);
  // Opening checked this before sending anything; a held position is checked here.
  if (!opened) {
    const noMetaLists = await missingHookMetaLists(conn, poolMints(ctx));
    if (noMetaLists.length) throw hookRefusal(noMetaLists);
  }

  const spanned = rangeTickArrayCount(
    ctx.position.tickLowerIndex,
    ctx.position.tickUpperIndex,
    ctx.pool.tickSpacing,
  );
  if (spanned > MAX_RANGE_TICK_ARRAYS) {
    throw new CookieMcpError(
      `this range spans ${spanned} tick arrays; Zip supports up to ${MAX_RANGE_TICK_ARRAYS}`,
      "use a narrower position (a full range on the 0.25% tier is too wide; on the 0.3% tier it fits)",
    );
  }

  // Owner-paid prerequisites, idempotent: the tick arrays the range spans and the payout accounts.
  const missing = await missingTickArrays(
    conn,
    rangeTickArrays(
      ctx.poolPk,
      ctx.position.tickLowerIndex,
      ctx.position.tickUpperIndex,
      ctx.pool.tickSpacing,
    ),
  );
  const inits = buildTickArrayInitIxs(conn, {
    whirlpool: ctx.poolPk,
    arrays: missing,
    funder: owner,
  });
  const payout = payoutAccounts({
    order: ctx.orderPk,
    owner,
    mintA: ctx.pool.tokenMintA,
    mintB: ctx.pool.tokenMintB,
    tokenProgramA: ctx.tokenProgramA,
    tokenProgramB: ctx.tokenProgramB,
  });
  const ataInfos = payout.ownerAtas.length
    ? await conn.getMultipleAccountsInfo(
        payout.ownerAtas.map((a) => a.address),
        "confirmed",
      )
    : [];
  const payoutAccountsCreated = ataInfos.filter((i) => !i).length;

  const program = zipProgram(conn);
  const enable = [
    ...buildPayoutAtaIxs({
      owner,
      mintA: ctx.pool.tokenMintA,
      mintB: ctx.pool.tokenMintB,
      tokenProgramA: ctx.tokenProgramA,
      tokenProgramB: ctx.tokenProgramB,
    }),
    await buildEnableIx({
      program,
      owner,
      whirlpool: ctx.poolPk,
      position: ctx.positionPk,
      nft: ctx.nft.address,
      nftTokenProgram: ctx.nft.tokenProgram,
      direction,
      minStep,
      cranker,
    }),
  ];
  const txs = enableTransactions(inits, enable);

  const summary = {
    action: "start zip",
    position: ctx.positionPk.toBase58(),
    positionMint: ctx.position.positionMint.toBase58(),
    sells: label(sells.mint, sells.symbol),
    receives: label(receives.mint, receives.symbol),
    direction,
    minStep,
    cranker: cranker?.toBase58() ?? "anyone",
    tickArraysToCreate: missing.length,
  };
  let signature = "";
  for (let i = 0; i < txs.length; i++) {
    const last = i === txs.length - 1;
    const tx = new Transaction().add(...txs[i]!);
    signature = await signSendConfirm(
      conn,
      tx,
      signer,
      [],
      last ? "start zip" : `zip tick arrays (${i + 1}/${txs.length - 1})`,
      { step: last ? "final" : "intermediate", summary },
    );
  }

  const decision = decisionFor(ctx, direction, minStep);
  const next = describeDecision(decision, {
    direction,
    minStep,
    sold: label(sells.mint, sells.symbol),
    received: label(receives.mint, receives.symbol),
  });
  const notes = [
    "the position NFT stays in your wallet: the order is only its SPL delegate, and the program " +
      "lets it move the trailing edge and finish, nothing else",
    "the position keeps earning LP fees while it fills; finish pays them out with the last fill",
    ...tokenNotes(ctx),
  ];
  if (opened?.reused === "funded") {
    notes.unshift(
      `continued with position ${opened.positionMint} that an earlier call opened (same range, ` +
        "about the same amount, no order): nothing new was deposited",
    );
  } else if (opened?.reused === "empty") {
    notes.unshift(
      `deposited into position ${opened.positionMint}, which an earlier call opened but whose ` +
        "deposit had not landed",
    );
  }
  if (keeper === "anyone") {
    notes.push(
      "unpinned: anyone may crank this order, and a hostile cranker can hand most of it back " +
        "unconverted (about 1 - 1/minStep). The Cookiebox keeper cranks unpinned orders too",
    );
  } else if (keeper === "custom") {
    notes.push(`only ${cranker!.toBase58()} may crank this order; the Cookiebox keeper will not`);
  }
  const signatures = [...landed.sigs, ...(opened?.signature ? [opened.signature] : []), signature];
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    signatures,
    order: ctx.orderPk.toBase58(),
    direction,
    sells,
    receives,
    minStep,
    cranker: cranker?.toBase58() ?? null,
    keeper,
    next,
    created: {
      tickArrays: missing.length,
      payoutAccounts: payoutAccountsCreated,
      pool: landed.pool,
    },
    ...(landed.soldNow ? { soldNow: landed.soldNow } : {}),
    ...(opened
      ? {
          opened: {
            positionMint: opened.positionMint,
            signature: opened.signature,
            explorerUrl: opened.signature ? explorerTxUrl(opened.signature) : null,
          },
        }
      : {}),
    ...positionView(ctx, direction),
    notes,
  };
}

/** Re-pricing rounds when the live pool moves into the range between a read and a send. */
const PLACE_ATTEMPTS = 3;

/** A token the order names: a mint or "COOK", with its decimals and symbol. */
async function resolveOrderMints(
  sell: string | undefined,
  receive: string | undefined,
): Promise<{ sell: MintMeta & { mint: PublicKey }; receive: MintMeta & { mint: PublicKey } }> {
  const parse = (v: string | undefined, name: string): PublicKey => {
    const t = v?.trim() ?? "";
    if (!t) {
      throw new CookieMcpError(
        `pass \`${name}\`: the token to ${name} (a mint, or "COOK")`,
        "a Zip order sells `amount` of `sell` for `receive` between `from` and `to`",
      );
    }
    try {
      return new PublicKey(t.toUpperCase() === "COOK" ? COOK_MINT : t);
    } catch {
      throw new CookieMcpError(`invalid ${name} mint: ${t}`, 'pass a base58 mint or "COOK"');
    }
  };
  const s = parse(sell, "sell");
  const r = parse(receive, "receive");
  if (s.equals(r)) {
    throw new CookieMcpError("sell and receive are the same token", "pick two different tokens");
  }
  const meta = await resolveMintMeta([s.toBase58(), r.toBase58()]);
  return {
    sell: { ...requireMintMeta(meta, s.toBase58()), mint: s },
    receive: { ...requireMintMeta(meta, r.toBase58()), mint: r },
  };
}

/** The pair's standard-tier pools, one per fee the config knows, existing or not. */
async function readFeeOptions(
  conn: Connection,
  mintA: PublicKey,
  mintB: PublicKey,
): Promise<ZipFeeOption[]> {
  const tiers = Object.entries(CLMM_FEE_TIER_TICK_SPACING).map(([bps, spacing]) => ({
    feeBps: Number(bps),
    tickSpacing: spacing,
    poolPk: standardPoolPda(mintA, mintB, spacing),
  }));
  const infos = await conn.getMultipleAccountsInfo(
    tiers.map((t) => t.poolPk),
    "confirmed",
  );
  return tiers.map((t, i) => ({
    ...t,
    pool: infos[i]?.owner.equals(CLMM_PROGRAM_ID) ? parsePool(t.poolPk, infos[i]!) : null,
  }));
}

type Market = { tick: number; venue: "pool" } | { tick: number; venue: "router" };

/**
 * The market as a pool tick: the chosen pool's own price when it has liquidity, else what the
 * router pays for `amount` right now (an empty pool's price is whatever it was left at). `null`
 * when nothing prices the pair.
 */
async function readMarket(
  conn: Connection,
  option: ZipFeeOption,
  side: ZipOrderSide,
  sell: MintMeta & { mint: PublicKey },
  receive: MintMeta & { mint: PublicKey },
  amountRaw: bigint,
): Promise<Market | null> {
  const info = await conn.getAccountInfo(option.poolPk, "confirmed");
  const pool = info?.owner.equals(CLMM_PROGRAM_ID) ? parsePool(option.poolPk, info) : null;
  const own = poolMarketTick(pool);
  if (own != null) return { tick: own, venue: "pool" };
  try {
    const q = await getQuote({
      inputMint: sell.mint.toBase58(),
      outputMint: receive.mint.toBase58(),
      amount: rawToUi(amountRaw, sell.dec),
      slippageBps: ZIP_SELL_NOW_SLIPPAGE_BPS,
    });
    const perSell = new Decimal(q.output.outAfterFee).div(rawToUi(amountRaw, sell.dec));
    if (!perSell.isFinite() || perSell.lte(0)) return null;
    const tick = tickOfReceivePerSell(side, perSell);
    return tick == null ? null : { tick, venue: "router" };
  } catch {
    return null;
  }
}

/**
 * Sell `amountRaw` through the router with a floor at `from` on the whole fill: halves the amount
 * while the market can't take it at that floor, and sells nothing if it never can — the order
 * then rests at `from` and fills there.
 */
async function sellNowViaRouter(
  side: ZipOrderSide,
  sell: MintMeta & { mint: PublicKey },
  receive: MintMeta & { mint: PublicKey },
  range: ZipOrderRange,
  amountRaw: bigint,
): Promise<{ takes: bigint; signature: string | null }> {
  const perSell = zipPriceAtTick(side, fromEdgeTick(range));
  for (let amount = amountRaw, i = 0; amount > 0n && i < 4; amount /= 2n, i++) {
    const ui = rawToUi(amount, sell.dec);
    const floor = perSell.mul(ui);
    let minOut: Decimal;
    try {
      const q = await getQuote({
        inputMint: sell.mint.toBase58(),
        outputMint: receive.mint.toBase58(),
        amount: ui,
        slippageBps: ZIP_SELL_NOW_SLIPPAGE_BPS,
      });
      minOut = new Decimal(q.output.minOut);
    } catch {
      return { takes: 0n, signature: null };
    }
    if (minOut.lt(floor)) continue;
    const r = await trade({
      inputMint: sell.mint.toBase58(),
      outputMint: receive.mint.toBase58(),
      amount: ui,
      slippageBps: ZIP_SELL_NOW_SLIPPAGE_BPS,
      aggregator: "cookiebox",
    });
    return { takes: amount, signature: r.signature };
  }
  return { takes: 0n, signature: null };
}

/**
 * The trade-style `start_zip`: see {@link startZip}. Every refusal (tokens, amount, balance, a
 * hook with no meta list, a mint the CLMM won't pool) runs before the first send.
 */
async function placeZip(
  conn: Connection,
  signer: TxSigner,
  args: StartZipArgs,
  settings: Settings,
): Promise<StartZipResult | SwappedResult> {
  const owner = signer.publicKey;
  const { sell, receive } = await resolveOrderMints(args.sell, args.receive);
  if (args.amount == null) {
    throw new CookieMcpError("pass `amount`: how much of `sell` to sell (UI units)", "");
  }
  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, sell.dec);
  } catch (e) {
    throw new CookieMcpError(
      (e as Error).message,
      `amount is how much ${label(sell.mint.toBase58(), sell.sym)} to sell`,
    );
  }
  if (amountRaw <= 0n) throw new CookieMcpError("amount must be above zero", "");
  const sellLabel = label(sell.mint.toBase58(), sell.sym);
  const receiveLabel = label(receive.mint.toBase58(), receive.sym);

  // The pool's canonical mint order: prices, ticks and the pool PDA all use it.
  const sellIsA = Buffer.compare(sell.mint.toBuffer(), receive.mint.toBuffer()) < 0;
  const [mintA, mintB] = sellIsA ? [sell.mint, receive.mint] : [receive.mint, sell.mint];
  const [metaA, metaB] = sellIsA ? [sell, receive] : [receive, sell];
  const [mintAInfo, mintBInfo] = await conn.getMultipleAccountsInfo([mintA, mintB], "confirmed");
  if (!mintAInfo || !mintBInfo) {
    throw new CookieMcpError("a token's mint account was not found on chain", "check the mints");
  }
  const noMetaLists = await missingHookMetaLists(conn, [
    { mint: mintA, info: mintAInfo, sym: metaA.sym },
    { mint: mintB, info: mintBInfo, sym: metaB.sym },
  ]);
  if (noMetaLists.length) throw hookRefusal(noMetaLists);
  const balance = await soldBalanceRaw(
    conn,
    owner,
    sell.mint,
    (sellIsA ? mintAInfo : mintBInfo).owner,
  );
  const short = depositShortfall({
    balance,
    want: amountRaw,
    dec: sell.dec,
    label: sellLabel,
    native: sell.mint.toBase58() === COOK_MINT,
  });
  if (short) throw short;

  const options = await readFeeOptions(conn, mintA, mintB);
  const option = pickFeeOption(options, args.fee, DEFAULT_CLMM_FEE_TIER_BPS);
  if (!option.pool) await assertClmmMintsPoolable(conn, [mintA, mintB]);
  const side: ZipOrderSide = {
    sellIsA,
    decA: metaA.dec,
    decB: metaB.dec,
    tickSpacing: option.tickSpacing,
  };
  const client = buildClmmClient(conn, signer);

  // The range: typed prices, or the default just above the market.
  let market = await readMarket(conn, option, side, sell, receive, amountRaw);
  const typed = args.from != null || args.to != null;
  if (!typed && !market) {
    throw new CookieMcpError(
      `nothing prices ${sellLabel}/${receiveLabel} right now (no live pool, no route), so there is no default range`,
      "pass `from` and `to` (what one sold token fetches)",
    );
  }
  let range: ZipOrderRange | null = zipRangeFromPrices(
    side,
    typed ? { from: args.from, to: args.to } : zipDefaultPrices(side, market!.tick),
  );
  const asked = zipRangePrices(side, range);
  const sigs: string[] = [];
  let soldNowRaw = 0n;
  let soldSig: string | null = null;
  let poolCreated = false;
  const summaryBase = {
    action: "zip order",
    sell: `${String(args.amount)} ${sellLabel}`,
    receive: receiveLabel,
    prices: `${asked.from}–${asked.to} ${receiveLabel} per ${sellLabel}`,
    fee: `${option.feeBps / 100}%`,
    pool: option.poolPk.toBase58(),
  };
  const step = (action: string, more: Record<string, unknown> = {}): SendExtra => ({
    step: "intermediate",
    summary: { ...summaryBase, action, ...more, then: WAIT_BEFORE_RECALL },
  });

  for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
    // 1–2: sell the part of the range the market beats; the rest starts one step past the market.
    if (market && range) {
      const share = zipCrossedShare(range, market.tick);
      const left = amountRaw - soldNowRaw;
      const crossed = share.gte(1) ? left : BigInt(share.mul(left.toString()).floor().toFixed(0));
      if (crossed > 0n) {
        const sale =
          market.venue === "pool"
            ? await sellNowInPool(
                conn,
                signer,
                client,
                option.poolPk,
                range,
                crossed,
                step("zip: sell the part the market already beats", {
                  sellsNow: `${rawToUi(crossed, sell.dec)} ${sellLabel}`,
                  floor: `${asked.from} ${receiveLabel} per ${sellLabel}`,
                }),
              )
            : await sellNowViaRouter(side, sell, receive, range, crossed);
        soldNowRaw += sale.takes;
        if (sale.signature) {
          soldSig = sale.signature;
          sigs.push(sale.signature);
        }
        if (sale.takes > 0n)
          market = await readMarket(conn, option, side, sell, receive, amountRaw);
      }
      range = market ? zipRangeAbove(side, range, market.tick) : range;
    }
    const orderRaw = amountRaw - soldNowRaw;
    if (orderRaw <= 0n || !range) {
      const signature = sigs[sigs.length - 1] ?? "";
      return {
        swapped: true,
        signature,
        explorerUrl: explorerTxUrl(signature),
        signatures: sigs,
        sold: `${rawToUi(soldNowRaw, sell.dec)} ${sellLabel}`,
        sells: { mint: sell.mint.toBase58(), symbol: sell.sym },
        receives: { mint: receive.mint.toBase58(), symbol: receive.sym },
        note:
          "the market already paid more than every price in the range, so the whole amount was " +
          "sold at once (never under `from`); no order was opened",
      };
    }

    // 3: the pool.
    let prep;
    try {
      prep = await prepZipPool({
        conn,
        client,
        owner,
        mintA,
        mintB,
        tickSpacing: option.tickSpacing,
        poolPk: option.poolPk,
        range,
        tokenProgramA: mintAInfo.owner,
        tokenProgramB: mintBInfo.owner,
      });
    } catch (e) {
      if (e instanceof ZipMarketMoved) {
        market = await readMarket(conn, option, side, sell, receive, amountRaw);
        continue;
      }
      throw e;
    }
    if (prep.kind === "create") {
      sigs.push(
        ...(await sendPrepared(
          conn,
          signer,
          prep.txs,
          prep.signers,
          "zip: create pool",
          step("zip: create the pool", {
            creates: "the pool at this fee, priced at `from`, and its tick arrays",
          }),
        )),
      );
      poolCreated = true;
    } else if (prep.kind === "move") {
      sigs.push(
        ...(await sendPrepared(
          conn,
          signer,
          prep.txs,
          [],
          "zip: move empty pool price",
          step("zip: move the empty pool's price to `from`", {
            trades: "nothing (the pool has no liquidity)",
          }),
        )),
      );
    }

    // 4: the position, then the order on it (`zipExisting` does the setup and `enable`).
    const fitted = zipRangePrices(side, range);
    let opened: OpenedForZip;
    try {
      opened = await openOneSided(conn, signer, client, {
        poolPk: option.poolPk,
        range,
        side,
        amountRaw: orderRaw,
        sold: { ...sell, label: sellLabel },
        extra: step("zip: open the position", {
          deposits: `${rawToUi(orderRaw, sell.dec)} ${sellLabel}`,
          prices: `${fitted.from}–${fitted.to} ${receiveLabel} per ${sellLabel}`,
        }),
      });
    } catch (e) {
      if (e instanceof ZipMarketMoved) {
        market = await readMarket(conn, option, side, sell, receive, amountRaw);
        continue;
      }
      throw e;
    }
    const ctx = await loadPositionContext(conn, opened.positionPk);
    const result = await zipExisting(conn, signer, ctx, sell.mint.toBase58(), settings, opened, {
      sigs,
      ...(soldNowRaw > 0n
        ? {
            soldNow: {
              amount: `${rawToUi(soldNowRaw, sell.dec)} ${sellLabel}`,
              signature: soldSig,
            },
          }
        : {}),
      pool: poolCreated,
    });
    const human = new Decimal(rawToUi(orderRaw, sell.dec));
    result.notes.unshift(
      `expect about ${zipExpectedReceive(side, range, human, market?.tick ?? null)
        .toSignificantDigits(6)
        .toString()} ${receiveLabel} for the ${rawToUi(orderRaw, sell.dec)} ${sellLabel} in the order, plus the LP fees it earns` +
        (fitted.from !== asked.from || fitted.to !== asked.to
          ? `; placed at ${fitted.from}–${fitted.to} ${receiveLabel} per ${sellLabel} (prices snap to the pool's steps, a range the market already beats starts one step past it, and one too wide to run is cut at the \`to\` end)`
          : ""),
    );
    return result;
  }
  throw new CookieMcpError(
    "the market kept moving into the order's range while it was being placed",
    "try again; what was sold so far is in your wallet",
  );
}

/**
 * Open the one-sided position an order rests on. Re-entrant for an external signer: a position of
 * this wallet with exactly this range and no order is continued (used when it holds the amount,
 * deposited into when it is empty), never opened twice. Re-checks on a fresh pool read that the
 * range still sits on the sell side of the price (`ZipMarketMoved` otherwise).
 */
async function openOneSided(
  conn: Connection,
  signer: TxSigner,
  client: ReturnType<typeof buildClmmClient>,
  p: {
    poolPk: PublicKey;
    range: ZipOrderRange;
    side: ZipOrderSide;
    amountRaw: bigint;
    sold: MintMeta & { mint: PublicKey; label: string };
    extra: SendExtra;
  },
): Promise<OpenedForZip> {
  const { range, poolPk } = p;
  const pool = parsePool(poolPk, await conn.getAccountInfo(poolPk, "confirmed"));
  if (depositZipDirection(pool.tickCurrentIndex, range.lower, range.upper) !== range.direction) {
    throw new ZipMarketMoved();
  }
  const sameRange = await sameRangePositions(conn, signer, pool, poolPk, range.lower, range.upper);
  const candidates: ReentryCandidate[] = sameRange.map((x) => ({
    ...x,
    held: range.direction === "aToB" ? x.held.a : x.held.b,
  }));
  const reentry = pickReentry(candidates, p.amountRaw);
  if (reentry?.kind === "reuse") {
    return {
      positionPk: reentry.c.positionPk,
      positionMint: reentry.c.positionMint.toBase58(),
      signature: null,
      reused: "funded",
    };
  }
  if (reentry?.kind === "conflict") {
    const mint = reentry.c.positionMint.toBase58();
    throw new CookieMcpError(
      `you already hold a position with exactly this range and no order (NFT ${mint}), holding ` +
        `${rawToUi(reentry.c.held, p.sold.dec)} ${p.sold.label} rather than ${rawToUi(p.amountRaw, p.sold.dec)}`,
      `zip that one with \`position: "${mint}"\`, or nudge \`from\`/\`to\` so the new range differs`,
    );
  }
  const ui = rawToUi(p.amountRaw, p.sold.dec);
  const amounts = {
    amountA: range.direction === "aToB" ? ui : undefined,
    amountB: range.direction === "bToA" ? ui : undefined,
  };
  void client;
  if (reentry?.kind === "deposit") {
    const signature = await depositClmmPosition(
      conn,
      signer,
      { poolPk, positionPk: reentry.c.positionPk, ...amounts },
      p.extra,
    );
    return {
      positionPk: reentry.c.positionPk,
      positionMint: reentry.c.positionMint.toBase58(),
      signature,
      reused: "empty",
    };
  }
  const opened = await openClmmPosition(
    conn,
    signer,
    { poolPk, tickLower: range.lower, tickUpper: range.upper, ...amounts },
    p.extra,
  );
  return {
    positionPk: opened.positionAddress,
    positionMint: opened.positionMint.toBase58(),
    signature: opened.signature,
    reused: null,
  };
}

/** Both open and deposit go out as `step: "intermediate"`; a re-call before they confirm repeats them. */
const WAIT_BEFORE_RECALL =
  "wait for this transaction to confirm (submit_signed_tx reports `confirmed`) before calling " +
  "start_zip again, or the next call sends it a second time";

/**
 * What the wallet can deposit of `mint`, raw: native lamports for COOK (the CLMM client wraps the
 * deposit from lamports into a temporary account), else the associated token account's balance.
 */
async function soldBalanceRaw(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<bigint> {
  if (mint.toBase58() === COOK_MINT) return BigInt(await conn.getBalance(owner, "confirmed"));
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const info = await conn.getAccountInfo(ata, "confirmed");
  return info ? unpackAccount(ata, info, tokenProgram).amount : 0n;
}

/** The refusal for a deposit the wallet can't cover, or null. Native COOK also pays the fees. */
export function depositShortfall(p: {
  balance: bigint;
  want: bigint;
  dec: number;
  label: string;
  native: boolean;
}): CookieMcpError | null {
  if (p.balance >= p.want) return null;
  return new CookieMcpError(
    `this wallet holds ${rawToUi(p.balance, p.dec)} ${p.label}, less than the ${rawToUi(p.want, p.dec)} ` +
      `${p.label} to deposit`,
    "lower `amount`" +
      (p.native ? " (leave some COOK for fees and the position and tick-array rent)" : "") +
      "; nothing was sent",
  );
}

/**
 * The wallet's unlocked, order-less positions in `pool` with exactly this tick range, with what each
 * holds of both tokens at the current price. These are what an earlier call of the same request
 * opened; the caller names them in refusals and continues with one of them.
 */
async function sameRangePositions(
  conn: Connection,
  signer: TxSigner,
  pool: ReturnType<typeof parsePool>,
  poolPk: PublicKey,
  lower: number,
  upper: number,
): Promise<SameRangePosition[]> {
  const client = buildClmmClient(conn, signer);
  const mine = await findClmmPositions(conn, client, signer.publicKey, poolPk);
  if (mine.length === 0) return [];
  const [infos, orders] = await Promise.all([
    conn.getMultipleAccountsInfo(
      mine.map((p) => p.positionAddress),
      "confirmed",
    ),
    conn.getMultipleAccountsInfo(
      mine.map((p) => rangeOrderPda(p.positionAddress)),
      "confirmed",
    ),
  ]);
  const found: SameRangePosition[] = [];
  for (let i = 0; i < mine.length; i++) {
    const own = mine[i]!;
    if (own.locked || orders[i] || !infos[i]) continue;
    const pos = parsePosition(own.positionAddress, infos[i]!);
    if (pos.tickLowerIndex !== lower || pos.tickUpperIndex !== upper) continue;
    const liquidity = BigInt(pos.liquidity.toString());
    found.push({
      positionPk: own.positionAddress,
      positionMint: own.positionMint,
      liquidity,
      held: withdrawAmounts({
        liquidity,
        tickCurrent: pool.tickCurrentIndex,
        sqrtPrice: BigInt((pool.sqrtPrice as BN).toString()),
        lower,
        upper,
        sqrtLower: sqrtAt(lower),
        sqrtUpper: sqrtAt(upper),
      }),
    });
  }
  return found;
}

interface SameRangePosition {
  positionPk: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  held: { a: bigint; b: bigint };
}

/**
 * Appended to a refusal of the range when the wallet already holds a position with it: an earlier
 * call of this request opened it and the price moved since, so the agent must not just nudge the
 * range and open another.
 */
export function strandedPositionHint(mints: string[]): string {
  if (mints.length === 0) return "";
  const one = mints.length === 1;
  return (
    `; note you already hold ${one ? "a position" : `${mints.length} positions`} with exactly this ` +
    `range and no order (NFT ${mints.join(", ")}), likely opened by an earlier call of this ` +
    `request: once the price is back on its side, zip it with \`position: "${mints[0]}"\` ` +
    "(no amount/prices), or remove_liquidity to take the deposit out"
  );
}

interface OpenedForZip {
  positionPk: PublicKey;
  positionMint: string;
  /** The open (or deposit) signature; null when an already-funded position was reused. */
  signature: string | null;
  /** "funded": an earlier call's position, used as is; "empty": one whose deposit this call made. */
  reused: "funded" | "empty" | null;
}

/** A same-range, unlocked, order-less position of the wallet, as `pickReentry` weighs it. */
export interface ReentryCandidate {
  positionPk: PublicKey;
  positionMint: PublicKey;
  liquidity: bigint;
  /** Raw amount of the token being sold that the position holds now. */
  held: bigint;
}

/**
 * Which existing position an open-and-zip call continues with, if any. One holding about the
 * requested amount (within 1% or two raw units, whichever is looser; never more — a one-sided
 * deposit rounds down) is the earlier call's open: reuse it. Otherwise an empty one is an open whose
 * deposit never landed: deposit into it. A funded one holding something else is not this request's,
 * so the caller refuses rather than guess (`more` = the other funded ones, for the message). Null:
 * open a new position.
 */
export function pickReentry(
  candidates: ReentryCandidate[],
  wantRaw: bigint,
):
  | { kind: "reuse" | "deposit"; c: ReentryCandidate; more: [] }
  | { kind: "conflict"; c: ReentryCandidate; more: ReentryCandidate[] }
  | null {
  const funded = candidates.filter((c) => c.liquidity > 0n);
  const match = funded.find(
    (c) => c.held <= wantRaw && (c.held * 100n >= wantRaw * 99n || wantRaw - c.held <= 2n),
  );
  if (match) return { kind: "reuse", c: match, more: [] };
  const empty = candidates.find((c) => c.liquidity === 0n);
  if (empty) return { kind: "deposit", c: empty, more: [] };
  return funded.length ? { kind: "conflict", c: funded[0]!, more: funded.slice(1) } : null;
}

/**
 * What `start_zip` on a running order does: re-approve the NFT when this wallet holds it and
 * the delegation is gone, recreate whatever else is missing, or refuse with the reason nothing here
 * helps — nothing missing, a hook only its issuer can fix, or a delegation only the holder can.
 */
export function repairPlan(p: {
  missingTickArrays: number;
  missingPayout: number;
  holdsNft: boolean;
  delegatedToOrder: boolean;
  missingHookMetaLists: string[];
}): { reapprove: boolean; refuse: null | "nothing" | "hook" | "nftElsewhere" } {
  const reapprove = p.holdsNft && !p.delegatedToOrder;
  // Without the delegation the keeper can't crank at all, so recreating the rest would only spend
  // rent on an order that stays paused; the holder's own repair redoes it once the NFT is back.
  if (!p.delegatedToOrder && !p.holdsNft) return { reapprove, refuse: "nftElsewhere" };
  if (p.missingTickArrays > 0 || p.missingPayout > 0 || reapprove) {
    return { reapprove, refuse: null };
  }
  return { reapprove, refuse: p.missingHookMetaLists.length ? "hook" : "nothing" };
}

/**
 * `start_zip` on a position whose order is already running: recreate what the keeper needs and
 * the owner is responsible for — tick arrays the range spans, the owner's payout accounts, and the
 * NFT's delegation to the order (re-approve, when this wallet still holds it). Nothing about the
 * order changes. With nothing missing it refuses, as before: stop first to change it.
 */
async function repairZip(
  conn: Connection,
  signer: TxSigner,
  ctx: PositionContext & { order: RangeOrder },
): Promise<StartZipResult> {
  const owner = signer.publicKey;
  const order = ctx.order;
  const { sells, receives } = soldReceived(ctx, order.direction);
  const running =
    `this position already has a Zip order running (${label(sells.mint, sells.symbol)} → ` +
    `${label(receives.mint, receives.symbol)}, order ${ctx.orderPk.toBase58()})`;
  if (!order.owner.equals(owner)) {
    throw new CookieMcpError(
      `${running}, owned by ${order.owner.toBase58()}`,
      "only its owner may repair it; stop_zip is open to the NFT holder too",
    );
  }
  const payout = payoutAccounts({
    order: ctx.orderPk,
    owner,
    mintA: ctx.pool.tokenMintA,
    mintB: ctx.pool.tokenMintB,
    tokenProgramA: ctx.tokenProgramA,
    tokenProgramB: ctx.tokenProgramB,
  });
  const [missingArrays, ataInfos, noMetaLists] = await Promise.all([
    missingTickArrays(
      conn,
      rangeTickArrays(
        ctx.poolPk,
        ctx.position.tickLowerIndex,
        ctx.position.tickUpperIndex,
        ctx.pool.tickSpacing,
      ),
    ),
    payout.ownerAtas.length
      ? conn.getMultipleAccountsInfo(
          payout.ownerAtas.map((a) => a.address),
          "confirmed",
        )
      : Promise.resolve([] as (AccountInfo<Buffer> | null)[]),
    missingHookMetaLists(conn, poolMints(ctx)),
  ]);
  const missingAtas = ataInfos.filter((i) => !i).length;
  const { reapprove, refuse } = repairPlan({
    missingTickArrays: missingArrays.length,
    missingPayout: missingAtas,
    holdsNft: ctx.nft != null && ctx.nft.holder.equals(owner),
    delegatedToOrder: ctx.nft?.delegate?.equals(ctx.orderPk) ?? false,
    missingHookMetaLists: noMetaLists,
  });
  if (refuse === "hook") {
    throw new CookieMcpError(
      `${running}, paused because ${hookUnpublished(noMetaLists)}`,
      "nothing start_zip can recreate fixes that: it resumes once the issuer publishes the " +
        "hook's ExtraAccountMetaList; stop_zip to take the position back meanwhile",
    );
  }
  if (refuse === "nftElsewhere") {
    throw new CookieMcpError(
      `${running}, paused because the position NFT is not in this wallet, so only its holder can ` +
        "re-approve it",
      "move the NFT back and call start_zip again, or stop_zip to close the order",
    );
  }
  if (refuse === "nothing") {
    throw new CookieMcpError(
      running,
      "stop_zip it first to change the direction, step or cranker; get_zip_orders shows it",
    );
  }

  const inits = buildTickArrayInitIxs(conn, {
    whirlpool: ctx.poolPk,
    arrays: missingArrays,
    funder: owner,
  });
  const tail = [
    ...(missingAtas
      ? buildPayoutAtaIxs({
          owner,
          mintA: ctx.pool.tokenMintA,
          mintB: ctx.pool.tokenMintB,
          tokenProgramA: ctx.tokenProgramA,
          tokenProgramB: ctx.tokenProgramB,
        })
      : []),
    ...(reapprove
      ? [
          createApproveInstruction(
            ctx.nft!.address,
            ctx.orderPk,
            owner,
            1,
            [],
            ctx.nft!.tokenProgram,
          ),
        ]
      : []),
  ];
  const txs = enableTransactions(inits, tail).filter((ixs) => ixs.length > 0);
  // An SPL account has one delegate: re-approving revokes whoever holds it now (a marketplace, say).
  const replacedDelegate = reapprove ? (ctx.nft!.delegate?.toBase58() ?? null) : null;
  const summary = {
    action: "repair zip",
    order: ctx.orderPk.toBase58(),
    position: ctx.positionPk.toBase58(),
    tickArraysToCreate: missingArrays.length,
    payoutAccountsToCreate: missingAtas,
    reapproveNft: reapprove,
    ...(replacedDelegate ? { revokesDelegate: replacedDelegate } : {}),
  };
  let signature = "";
  for (let i = 0; i < txs.length; i++) {
    const last = i === txs.length - 1;
    signature = await signSendConfirm(
      conn,
      new Transaction().add(...txs[i]!),
      signer,
      [],
      last ? "repair zip" : `zip tick arrays (${i + 1}/${txs.length - 1})`,
      { step: last ? "final" : "intermediate", summary },
    );
  }
  const decision = decisionFor(ctx, order.direction, order.minStep);
  const next = describeDecision(decision, {
    direction: order.direction,
    minStep: order.minStep,
    sold: label(sells.mint, sells.symbol),
    received: label(receives.mint, receives.symbol),
  });
  const keeper = keeperKind(order.cranker);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: ctx.orderPk.toBase58(),
    direction: order.direction,
    sells,
    receives,
    minStep: order.minStep,
    cranker: order.cranker?.toBase58() ?? null,
    keeper,
    next,
    signatures: [signature],
    created: { tickArrays: missingArrays.length, payoutAccounts: missingAtas, pool: false },
    repaired: { delegation: reapprove },
    ...positionView(ctx, order.direction),
    notes: [
      "the order kept running and nothing about it changed; this only recreated what the keeper " +
        "needs to crank it (the keeper never pays that rent itself)",
      ...(replacedDelegate
        ? [
            `the NFT's previous delegate ${replacedDelegate} was revoked by the re-approval (an ` +
              "account has one delegate); anything that relied on it, like a listing, no longer can",
          ]
        : []),
      ...(noMetaLists.length
        ? [
            `still paused: ${hookUnpublished(noMetaLists)}; the keeper resumes once the issuer ` +
              "publishes one, and nothing start_zip can recreate changes that",
          ]
        : []),
      ...tokenNotes(ctx),
    ],
  };
}

export interface StopZipResult {
  signature: string;
  explorerUrl: string;
  /** Every transaction this call landed, oldest first. */
  signatures: string[];
  /** The order account (closed by this call), or null when it was already gone (a filled order). */
  order: string | null;
  position: string;
  positionMint: string;
  pool: string;
  /** True when this wallet held the NFT and the stop revoked the order's delegation on it. */
  delegationRevoked: boolean;
  /** True when the position's liquidity, fees and rewards were withdrawn and the position closed. */
  positionClosed: boolean;
  rentRefundedTo: string;
  note: string;
}

/** Slippage on the withdraw when an order is stopped: the position is one-sided, so small. */
const ZIP_STOP_SLIPPAGE_BPS = 100;

/**
 * Stop a Zip order and leave nothing behind, as Cookiebox's Stop does: `disable` (closes the
 * order, revokes the NFT delegation), then the pool's own close path — withdraw all liquidity,
 * collect fees and rewards, close the position and burn its NFT — so the wallet gets back
 * everything that was not filled yet. On a filled order (the keeper's `finish` already paid
 * everything out and closed the order) only the empty position is closed, returning its rent.
 * When the NFT is in another wallet only the order is closed; a stale order (position already
 * closed) stops too, refunding its rent.
 */
export async function stopZip(args: { position?: string; pool?: string }): Promise<StopZipResult> {
  const signer = requireSigner();
  const me = signer.publicKey;
  const conn = getConnection();
  const found = await resolveStopOrder(conn, args, signer);
  const positionPk = found.order ? found.order.order.position : found.positionPk!;
  const positionInfo = await conn.getAccountInfo(positionPk, "confirmed");
  const position = positionInfo ? parsePosition(positionPk, positionInfo) : null;
  const positionMint = found.order ? found.order.order.positionMint : position!.positionMint;
  const mintInfo = await conn.getAccountInfo(positionMint, "confirmed");
  const nft = mintInfo ? await findPositionNft(conn, positionMint) : null;
  const holdsNft = nft?.holder.equals(me) ?? false;
  const owner = found.order?.order.owner ?? me;
  if (found.order && !owner.equals(me) && !holdsNft) {
    throw new CookieMcpError(
      `that order belongs to ${owner.toBase58()}`,
      "only the order's owner, or whoever holds the position NFT now, can stop it",
    );
  }
  if (!found.order && !holdsNft) {
    throw new CookieMcpError(
      "this position has no Zip order running, and this wallet does not hold its NFT",
      "nothing to stop — get_zip_orders lists the ones that do",
    );
  }
  const orderPk = found.order?.orderPk ?? null;
  const pool = found.order?.order.whirlpool ?? position!.whirlpool;
  const summary = {
    action: found.order ? "stop zip" : "close filled zip position",
    order: orderPk?.toBase58() ?? null,
    position: positionPk.toBase58(),
    revokesDelegation: holdsNft && found.order != null,
    withdrawsAndClosesPosition: holdsNft && position != null,
  };
  const sigs: string[] = [];

  // The pool's close path, when this wallet can run it (it holds the NFT and the position exists).
  const closeTxs: Transaction[] = [];
  if (position && holdsNft) {
    const client = buildClmmClient(conn, signer);
    const whirlpool = await client.getPool(pool);
    const builders = await whirlpool.closePosition(
      positionPk,
      Percentage.fromFraction(ZIP_STOP_SLIPPAGE_BPS, 10_000),
      me,
      me,
      me,
    );
    for (const b of builders) {
      if (b.isEmpty()) continue;
      closeTxs.push((await builderToTx(b, OPEN_POSITION_CU)).tx);
    }
  }
  if (found.order) {
    // `disable` first, while the NFT still exists: the close burns it.
    const disable = await buildDisableIx({
      program: zipProgram(conn),
      signer: me,
      owner,
      position: positionPk,
      nft: holdsNft && nft ? { address: nft.address, tokenProgram: nft.tokenProgram } : null,
    });
    const first = closeTxs[0];
    if (first) {
      first.instructions.splice(1, 0, disable);
      first.feePayer = me;
      if (legacyTxWireSize(first, me) > 1232) {
        first.instructions.splice(1, 1);
        closeTxs.unshift(new Transaction().add(disable));
      }
    } else {
      closeTxs.push(new Transaction().add(disable));
    }
  }
  if (closeTxs.length === 0) {
    throw new CookieMcpError("nothing to close for this order", "it may already be closed");
  }
  for (let i = 0; i < closeTxs.length; i++) {
    const last = i === closeTxs.length - 1;
    sigs.push(
      await signSendConfirm(
        conn,
        closeTxs[i]!,
        signer,
        [],
        found.order ? "stop zip" : "close zip position",
        {
          step: last ? "final" : "intermediate",
          summary: last ? summary : { ...summary, then: WAIT_BEFORE_RECALL },
        },
      ),
    );
  }
  const signature = sigs[sigs.length - 1]!;
  const delegated = nft?.delegate && orderPk ? nft.delegate.equals(orderPk) : false;
  const positionClosed = position != null && holdsNft;
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    signatures: sigs,
    order: orderPk?.toBase58() ?? null,
    position: positionPk.toBase58(),
    positionMint: positionMint.toBase58(),
    pool: pool.toBase58(),
    delegationRevoked: holdsNft && delegated,
    positionClosed,
    rentRefundedTo: owner.toBase58(),
    note: !found.order
      ? "the filled order's empty position was closed and its rent returned to the wallet"
      : positionClosed
        ? "the order was closed and the position withdrawn in full — what had filled was already " +
          "in the wallet, the rest, the fees and the position's rent are now too; the position NFT was burned"
        : position
          ? "the order was closed and its rent refunded; the position is held by another wallet, so it " +
            "stays as it is (its holder can remove_liquidity)"
          : "the position was already closed; this only closed the order and refunded its rent",
  };
}
