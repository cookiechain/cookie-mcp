// Cookiebox Ratchet — trailing range orders on CLMM positions (`get_ratchet_orders`, `start_ratchet`,
// `stop_ratchet`).
//
// A one-sided CLMM position already IS a range order: it converts one token into the other as the
// price moves through the range, earning LP fees on the way. What it cannot do is hold the fill — if
// the price turns around, the part of the range it already converted converts straight back. Ratchet
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
import { PriceMath } from "@orca-so/whirlpools-sdk";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction, type AccountInfo, type Connection } from "@solana/web3.js";
import type BN from "bn.js";

import { COOK_MINT, RATCHET_KEEPER, explorerTxUrl } from "../config";
import { resolveWallet } from "../domains";
import { CookieMcpError } from "../errors";
import { rawToUi, shortAddr } from "../format";
import {
  CLMM_PROGRAM_ID,
  buildClmmClient,
  clmmLockConfigAddress,
  findClmmPositions,
} from "../liquidity/clmm";
import { signSendConfirm } from "../liquidity/send";
import { requireMintMeta, resolveMintMeta, type MintMeta } from "../mintMeta";
import { getConnection } from "../rpc";
import type { TxSigner } from "../signer";
import { ownPublicKey, requireSigner } from "../wallet";
import {
  decideRatchet,
  withdrawAmounts,
  type RatchetDecision,
  type RatchetDirection,
} from "./decision";
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
  RATCHET_PROGRAM_ID,
  rangeOrderPda,
  rangeTickArrayCount,
  rangeTickArrays,
  ratchetProgram,
  sqrtAt,
  tickArrayFor,
  type PositionNft,
  type RangeOrder,
} from "./program";

export * from "./decision";
export * from "./program";

export const RATCHET_NAME = "Ratchet";

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
 * has already converted, there is nothing for a ratchet to do.
 */
export function directionForSell(
  sell: string | undefined,
  pair: PairTokens,
  holdings: Holdings,
): RatchetDirection {
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
  let direction: RatchetDirection;
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
      `nothing to ratchet — remove_liquidity to take the ${received} out, or sell ${received} for ` +
        `${sold} instead (sell: "${direction === "aToB" ? pair.mintB : pair.mintA}")`,
    );
  }
  return direction;
}

/** Who cranks an order: Cookiebox's keeper (the default), anyone, or a key of the caller's choosing. */
export type KeeperKind = "cookiebox" | "anyone" | "custom";

export function keeperKind(cranker: PublicKey | null): KeeperKind {
  if (!cranker) return "anyone";
  return cranker.toBase58() === RATCHET_KEEPER ? "cookiebox" : "custom";
}

/** Parse the `cranker` argument: omitted / "cookiebox" → the keeper; "anyone" → unpinned; else a key. */
export function resolveCranker(input?: string): { cranker: PublicKey | null; keeper: KeeperKind } {
  const s = input?.trim() ?? "";
  if (s === "" || s.toLowerCase() === "cookiebox" || s.toLowerCase() === "keeper") {
    return { cranker: new PublicKey(RATCHET_KEEPER), keeper: "cookiebox" };
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

/** What the keeper will do with an order on its next pass, in words. */
export function describeDecision(
  d: RatchetDecision,
  p: { direction: RatchetDirection; minStep: number; sold: string; received: string },
): string {
  if (d.kind === "finish") {
    return (
      `fully filled — the keeper's next pass withdraws the ${p.received} and the earned fees to the ` +
      `wallet and closes the order`
    );
  }
  if (d.kind === "ratchet") {
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
      return "the position has no liquidity, so there is nothing to fill — stop_ratchet closes the order";
    case "liquidityBelowFloor":
      return "waiting (the re-deposit would not fit the liquidity floor; the keeper retries)";
    case "fullyFilled":
      // `decideRatchet` reports a filled range as `finish`; only a bare `nextRange` says this.
      return `fully filled — nothing of the ${p.sold} is left to convert`;
  }
}

/**
 * An order's status from the keeper's decision and the three things that pause an order: the NFT
 * delegation being gone, a payout account the owner closed, and a tick array the next move needs.
 * Pure, so the rule is testable; the reads happen in the caller.
 */
export function orderStatus(p: {
  decision: RatchetDecision;
  delegated: boolean;
  missingPayout: string[];
  missingTickArrays: number;
  next: string;
}): { status: OrderStatus; detail: string } {
  const restart = "stop_ratchet, then start_ratchet again (starting recreates what is missing)";
  if (!p.delegated) {
    return {
      status: "paused",
      detail:
        "the position NFT is no longer delegated to the order (approval revoked or NFT moved), so " +
        `the keeper cannot move the edge — ${restart}`,
    };
  }
  if (p.missingPayout.length) {
    return {
      status: "paused",
      detail:
        `the owner's ${p.missingPayout.join(" and ")} token account was closed; the keeper will not ` +
        `recreate it — ${restart}`,
    };
  }
  if (p.missingTickArrays > 0) {
    return {
      status: "paused",
      detail: `${p.missingTickArrays} tick array(s) the next move needs do not exist — ${restart}`,
    };
  }
  if (p.decision.kind === "finish") return { status: "fully-filled", detail: p.next };
  if (p.decision.kind === "ratchet") return { status: "filling", detail: p.next };
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
  /** Permanently locked via the CLMM's `lock_position`: Ratchet cannot reposition it. */
  locked: boolean;
  orderPk: PublicKey;
  order: RangeOrder | null;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
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

function priceAtTick(tick: number, ctx: PositionContext): string {
  return PriceMath.tickIndexToPrice(tick, ctx.metaA.dec, ctx.metaB.dec)
    .toSignificantDigits(9)
    .toString();
}

function currentPrice(ctx: PositionContext): string {
  return PriceMath.sqrtPriceX64ToPrice(ctx.pool.sqrtPrice as BN, ctx.metaA.dec, ctx.metaB.dec)
    .toSignificantDigits(9)
    .toString();
}

function decisionFor(ctx: PositionContext, direction: RatchetDirection, minStep: number) {
  return decideRatchet({
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
  /** Prices as tokenB per tokenA (the pool's canonical orientation; see `priceUnit`). */
  lowerPrice: string;
  upperPrice: string;
}

/** The position's shape, shared by every result: pair, range, price and what it holds now. */
function positionView(ctx: PositionContext) {
  const pair = pairOf(ctx);
  const a = label(pair.mintA, pair.symA);
  const b = label(pair.mintB, pair.symB);
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
    priceUnit: `${b} per ${a}`,
    range: {
      lowerTick: ctx.position.tickLowerIndex,
      upperTick: ctx.position.tickUpperIndex,
      lowerPrice: priceAtTick(ctx.position.tickLowerIndex, ctx),
      upperPrice: priceAtTick(ctx.position.tickUpperIndex, ctx),
    } as RangeView,
    price: { tick: ctx.pool.tickCurrentIndex, current: currentPrice(ctx) },
    tickSpacing: ctx.pool.tickSpacing,
    liquidity: ctx.position.liquidity.toString(),
    inPosition: {
      [a]: rawToUi(held.a, ctx.metaA.dec),
      [b]: rawToUi(held.b, ctx.metaB.dec),
    } as Record<string, string>,
  };
}

function soldReceived(ctx: PositionContext, direction: RatchetDirection) {
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
    const usable =
      mode === "stop"
        ? withOrder
        : mine.filter((p, i) => !orderInfos[i] && !p.locked && p.liquidity.gtn(0));
    if (usable.length === 0) {
      throw mode === "stop"
        ? new CookieMcpError(
            "none of your positions in that pool has a Ratchet order running",
            "nothing to stop — get_ratchet_orders lists the ones that do",
          )
        : new CookieMcpError(
            withOrder.length
              ? "every usable position of yours in that pool already has a Ratchet order running"
              : "no position of yours in that pool can be ratcheted (locked or empty)",
            withOrder.length
              ? "get_ratchet_orders shows them; stop_ratchet one first to change its direction"
              : "a Ratchet needs an unlocked position with liquidity",
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
    "get_ratchet_orders / get_balance show the NFT mints; `pool` picks your position in that pool",
  );
}

type Owned = Pick<AccountInfo<Buffer>, "owner"> | null;

/**
 * Which account a `stop_ratchet` `position` argument names, from one read of: the argument itself,
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
  const isOrder = (i: Owned) => i?.owner.equals(RATCHET_PROGRAM_ID) ?? false;
  const isPosition = (i: Owned) => i?.owner.equals(CLMM_PROGRAM_ID) ?? false;
  if (isOrder(reads.arg)) return "arg";
  if (isOrder(reads.orderForMint)) return "orderForMint";
  if (isOrder(reads.orderForAccount)) return "orderForAccount";
  return isPosition(reads.positionForMint) || isPosition(reads.arg) ? "noOrder" : "notFound";
}

const NO_ORDER = () =>
  new CookieMcpError(
    "this position has no Ratchet order running",
    "nothing to stop — get_ratchet_orders lists the ones that do",
  );

/** The order `stop_ratchet` names, read straight from the program (its position may be gone). */
async function resolveStopOrder(
  conn: Connection,
  args: { position?: string; pool?: string },
  signer: TxSigner,
): Promise<{ orderPk: PublicKey; order: RangeOrder }> {
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
    if (pick === "noOrder") throw NO_ORDER();
    if (pick === "notFound") {
      throw new CookieMcpError(
        `no Cookiebox CLMM position or Ratchet order for ${args.position}`,
        "pass the position NFT mint, the position account or the order address (get_ratchet_orders lists them)",
      );
    }
    return { orderPk: keys[pick], order: decodeRangeOrder(infos[pick]!.data) };
  }
  const { positionPk } = await resolvePosition(conn, args, signer, "stop");
  const orderPk = rangeOrderPda(positionPk);
  const info = await conn.getAccountInfo(orderPk, "confirmed");
  if (!info) throw NO_ORDER();
  return { orderPk, order: decodeRangeOrder(info.data) };
}

// --- reads ----------------------------------------------------------------------------------------

export interface RatchetOrderView {
  order: string;
  owner: string;
  status: OrderStatus | "stale";
  /** What the status means and what the keeper does next, in words. */
  detail: string;
  direction: RatchetDirection;
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
): Promise<RatchetOrderView> {
  // Stale only when the position account is really gone. Any other failure (an RPC error, missing
  // mint metadata) propagates: a flaky read must never tell the agent to stop a live order.
  const positionInfo = await conn.getAccountInfo(order.position, "confirmed");
  if (!positionInfo) {
    return {
      order: address.toBase58(),
      owner: order.owner.toBase58(),
      status: "stale",
      detail:
        "the position account no longer exists (closed) — stop_ratchet with `position` = this " +
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
  const view = positionView(ctx);
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
    decision.kind === "ratchet"
      ? [
          tickArrayFor(ctx.poolPk, decision.lower, ctx.pool.tickSpacing),
          tickArrayFor(ctx.poolPk, decision.upper, ctx.pool.tickSpacing),
        ]
      : [];
  const [ataInfos, missingArrays] = await Promise.all([
    payout.ownerAtas.length
      ? conn.getMultipleAccountsInfo(
          payout.ownerAtas.map((a) => a.address),
          "confirmed",
        )
      : Promise.resolve([] as (AccountInfo<Buffer> | null)[]),
    needed.length ? missingTickArrays(conn, needed) : Promise.resolve([]),
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
        "(see the Ratchet trust model) — the Cookiebox keeper does crank unpinned orders",
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

export interface RatchetOrdersResult {
  owner: string;
  ownerName?: string;
  count: number;
  orders: RatchetOrderView[];
}

/** A wallet's open Ratchet orders, read straight from the program (no key needed). */
export async function getRatchetOrders(args: { owner?: string }): Promise<RatchetOrdersResult> {
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
  const found = await listRangeOrders(conn, new PublicKey(owner));
  const orders = await Promise.all(found.map((f) => describeOrder(conn, f.address, f.order)));
  return { owner, ...(ownerName ? { ownerName } : {}), count: orders.length, orders };
}

// --- writes ---------------------------------------------------------------------------------------

export interface StartRatchetArgs {
  /** The position NFT mint (or the position account). */
  position?: string;
  /** Alternatively: your position in this CLMM pool. */
  pool?: string;
  /** The token to sell: either pool mint, or "COOK". Optional for a one-sided position. */
  sell?: string;
  /** Tick spacings the price must move past the edge before it follows (default 1). */
  minStep?: number;
  /** Who may crank: omitted = the Cookiebox keeper; "anyone"; or a public key. */
  cranker?: string;
}

export interface StartRatchetResult extends ReturnType<typeof positionView> {
  signature: string;
  explorerUrl: string;
  order: string;
  direction: RatchetDirection;
  sells: TokenRef;
  receives: TokenRef;
  minStep: number;
  cranker: string | null;
  keeper: KeeperKind;
  /** What the keeper does next, from the program's rules and the current price. */
  next: string;
  /** Owner-paid setup this start included (idempotent: 0 when they already existed). */
  created: { tickArrays: number; payoutAccounts: number };
  notes: string[];
}

export const MIN_STEP_MAX = 65_535;

/**
 * Start a Ratchet order on one of the wallet's CLMM positions. Creates the owner's payout token
 * accounts and any tick arrays the range spans (owner-paid, idempotent), then `enable`s the order —
 * delegating the position NFT to the order PDA and pinning the cranker. Each transaction is
 * simulated before signing; with an external signer a tick-array batch is handed back as an
 * intermediate step and the tool is called again to continue.
 */
export async function startRatchet(args: StartRatchetArgs): Promise<StartRatchetResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();

  const minStep = args.minStep ?? 1;
  if (!Number.isInteger(minStep) || minStep < 1 || minStep > MIN_STEP_MAX) {
    throw new CookieMcpError(
      `minStep must be an integer from 1 to ${MIN_STEP_MAX}`,
      "it counts tick spacings; 1 follows the price as closely as the pool allows",
    );
  }
  const { cranker, keeper } = resolveCranker(args.cranker);

  const { positionPk, info } = await resolvePosition(conn, args, signer, "start");
  const ctx = await loadPositionContext(conn, positionPk, info);
  const pair = pairOf(ctx);

  if (ctx.order) {
    const { sells, receives } = soldReceived(ctx, ctx.order.direction);
    throw new CookieMcpError(
      `this position already has a Ratchet order running (${label(sells.mint, sells.symbol)} → ` +
        `${label(receives.mint, receives.symbol)}, order ${ctx.orderPk.toBase58()})`,
      "stop_ratchet it first to change the direction, step or cranker; get_ratchet_orders shows it",
    );
  }
  if (!ctx.nft || !ctx.nft.holder.equals(owner)) {
    throw new CookieMcpError(
      ctx.nft
        ? `the position NFT is held by ${ctx.nft.holder.toBase58()}, not this wallet`
        : "the position NFT was not found in any wallet",
      "only the NFT holder can start a Ratchet on a position",
    );
  }
  if (ctx.locked) {
    throw new CookieMcpError(
      "this CLMM position is permanently locked, and the CLMM refuses to reposition a locked position",
      "a Ratchet needs an unlocked position; its fees are still claimable via claim_fees",
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

  const spanned = rangeTickArrayCount(
    ctx.position.tickLowerIndex,
    ctx.position.tickUpperIndex,
    ctx.pool.tickSpacing,
  );
  if (spanned > MAX_RANGE_TICK_ARRAYS) {
    throw new CookieMcpError(
      `this range spans ${spanned} tick arrays; Ratchet supports up to ${MAX_RANGE_TICK_ARRAYS}`,
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

  const program = ratchetProgram(conn);
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
    action: "start ratchet",
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
      last ? "start ratchet" : `ratchet tick arrays (${i + 1}/${txs.length - 1})`,
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
  if (keeper === "anyone") {
    notes.push(
      "unpinned: anyone may crank this order, and a hostile cranker can hand most of it back " +
        "unconverted (about 1 - 1/minStep). The Cookiebox keeper cranks unpinned orders too",
    );
  } else if (keeper === "custom") {
    notes.push(`only ${cranker!.toBase58()} may crank this order; the Cookiebox keeper will not`);
  }
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: ctx.orderPk.toBase58(),
    direction,
    sells,
    receives,
    minStep,
    cranker: cranker?.toBase58() ?? null,
    keeper,
    next,
    created: { tickArrays: missing.length, payoutAccounts: payoutAccountsCreated },
    ...positionView(ctx),
    notes,
  };
}

export interface StopRatchetResult {
  signature: string;
  explorerUrl: string;
  order: string;
  position: string;
  positionMint: string;
  pool: string;
  /** True when this wallet holds the NFT and the stop revoked the order's delegation on it. */
  delegationRevoked: boolean;
  rentRefundedTo: string;
  note: string;
}

/**
 * Stop a Ratchet order: closes the `RangeOrder` (rent back to its owner) and, when this wallet holds
 * the NFT, revokes the delegation. The position and its liquidity are untouched — whatever has
 * filled so far is already in the wallet, the rest stays in the position as it is. Works on a stale
 * order too (position closed): `disable` needs neither the position nor the NFT.
 */
export async function stopRatchet(args: {
  position?: string;
  pool?: string;
}): Promise<StopRatchetResult> {
  const signer = requireSigner();
  const me = signer.publicKey;
  const conn = getConnection();
  const { orderPk, order } = await resolveStopOrder(conn, args, signer);
  // Closing a position burns its NFT, so on a stale order the mint may hold nothing (or be gone).
  const [mintInfo, positionInfo] = await conn.getMultipleAccountsInfo(
    [order.positionMint, order.position],
    "confirmed",
  );
  const nft = mintInfo ? await findPositionNft(conn, order.positionMint) : null;
  const holdsNft = nft?.holder.equals(me) ?? false;
  if (!order.owner.equals(me) && !holdsNft) {
    throw new CookieMcpError(
      `that order belongs to ${order.owner.toBase58()}`,
      "only the order's owner, or whoever holds the position NFT now, can stop it",
    );
  }
  const program = ratchetProgram(conn);
  const ix = await buildDisableIx({
    program,
    signer: me,
    owner: order.owner,
    position: order.position,
    nft: holdsNft && nft ? { address: nft.address, tokenProgram: nft.tokenProgram } : null,
  });
  const tx = new Transaction().add(ix);
  const signature = await signSendConfirm(conn, tx, signer, [], "stop ratchet", {
    summary: {
      action: "stop ratchet",
      order: orderPk.toBase58(),
      position: order.position.toBase58(),
      revokesDelegation: holdsNft,
    },
  });
  const delegated = nft?.delegate?.equals(orderPk) ?? false;
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: orderPk.toBase58(),
    position: order.position.toBase58(),
    positionMint: order.positionMint.toBase58(),
    pool: order.whirlpool.toBase58(),
    delegationRevoked: holdsNft && delegated,
    rentRefundedTo: order.owner.toBase58(),
    note: positionInfo
      ? "the position and its liquidity are unchanged; what had filled is already in the wallet, the " +
        "rest stays in the position (remove_liquidity / claim_fees as usual)"
      : "the position was already closed; this only closed the order and refunded its rent",
  };
}
