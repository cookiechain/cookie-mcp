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

import { COOK_MINT, ZIP_KEEPER, explorerTxUrl } from "../config";
import { resolveWallet } from "../domains";
import { CookieMcpError } from "../errors";
import { rawToUi, shortAddr, uiToRaw } from "../format";
import {
  CLMM_PROGRAM_ID,
  buildClmmClient,
  clmmLockConfigAddress,
  findClmmPositions,
  depositClmmPosition,
  openClmmPosition,
  rangeTicksFromPrices,
} from "../liquidity/clmm";
import { signSendConfirm } from "../liquidity/send";
import { requireMintMeta, resolveMintMeta, type MintMeta } from "../mintMeta";
import { getConnection } from "../rpc";
import type { TxSigner } from "../signer";
import { ownPublicKey, requireSigner } from "../wallet";
import { decideZip, withdrawAmounts, type ZipDecision, type ZipDirection } from "./decision";
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
      return "the position has no liquidity, so there is nothing to fill — stop_zip closes the order";
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
    const usable =
      mode === "stop"
        ? withOrder
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

/** The order `stop_zip` names, read straight from the program (its position may be gone). */
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
        `no Cookiebox CLMM position or Zip order for ${args.position}`,
        "pass the position NFT mint, the position account or the order address (get_zip_orders lists them)",
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

export interface ZipOrderView {
  order: string;
  owner: string;
  status: OrderStatus | "stale";
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
  const found = await listRangeOrders(conn, new PublicKey(owner));
  const orders = await Promise.all(found.map((f) => describeOrder(conn, f.address, f.order)));
  return { owner, ...(ownerName ? { ownerName } : {}), count: orders.length, orders };
}

// --- writes ---------------------------------------------------------------------------------------

export interface StartZipArgs {
  /** The position NFT mint (or the position account). */
  position?: string;
  /** Alternatively: your position in this CLMM pool (or, with `amount`, the pool to open one in). */
  pool?: string;
  /** The token to sell: either pool mint, or "COOK". Optional for a one-sided position. */
  sell?: string;
  /**
   * Open a NEW one-sided position first: deposit this much of `sell` (UI units) into `pool` over
   * `priceLower`..`priceUpper` (tokenB per tokenA), then zip it. All three go together.
   */
  amount?: string | number;
  priceLower?: string | number;
  priceUpper?: string | number;
  /** Tick spacings the price must move past the edge before it follows (default 1). */
  minStep?: number;
  /** Who may crank: omitted = the Cookiebox keeper; "anyone"; or a public key. */
  cranker?: string;
}

export interface StartZipResult extends ReturnType<typeof positionView> {
  signature: string;
  explorerUrl: string;
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
  created: { tickArrays: number; payoutAccounts: number };
  /** Set when this call opened the position too (`amount` given); `signature` null = it existed already. */
  opened?: { positionMint: string; signature: string | null; explorerUrl: string | null };
  /** Set when the order was already running and this call only recreated what the keeper needs. */
  repaired?: { delegation: boolean };
  notes: string[];
}

export const MIN_STEP_MAX = 65_535;

/**
 * Start a Zip order on one of the wallet's CLMM positions. Creates the owner's payout token
 * accounts and any tick arrays the range spans (owner-paid, idempotent), then `enable`s the order —
 * delegating the position NFT to the order PDA and pinning the cranker. Each transaction is
 * simulated before signing; with an external signer a tick-array batch is handed back as an
 * intermediate step and the tool is called again to continue.
 */
export async function startZip(args: StartZipArgs): Promise<StartZipResult> {
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

  const opening = args.amount != null || args.priceLower != null || args.priceUpper != null;
  const opened = opening ? await openPositionForZip(conn, signer, args) : null;
  const { positionPk, info } = opened
    ? { positionPk: opened.positionPk, info: undefined }
    : await resolvePosition(conn, args, signer, "start");
  const ctx = await loadPositionContext(conn, positionPk, info);
  const pair = pairOf(ctx);

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
    ...(opened
      ? {
          opened: {
            positionMint: opened.positionMint,
            signature: opened.signature,
            explorerUrl: opened.signature ? explorerTxUrl(opened.signature) : null,
          },
        }
      : {}),
    ...positionView(ctx),
    notes,
  };
}

/**
 * `start_zip` with `amount` + `priceLower` + `priceUpper`: open a one-sided position in `pool`
 * first. The range must sit entirely on the `sell` side of the current price (above it to sell
 * token A, below it to sell token B), so nothing counts as filled the moment it opens. Re-entrant
 * for an external signer: a position of this wallet with exactly this range, liquidity and no order
 * is used instead of opening another, so "submit, then call again" lands on the enable step.
 */
async function openPositionForZip(
  conn: Connection,
  signer: TxSigner,
  args: StartZipArgs,
): Promise<OpenedForZip> {
  if (args.amount == null || args.priceLower == null || args.priceUpper == null) {
    throw new CookieMcpError(
      "to open a position, pass amount, priceLower and priceUpper together",
      "or leave all three out to zip a position you already hold (`position` or `pool`)",
    );
  }
  if (args.position) {
    throw new CookieMcpError(
      "`position` and amount/priceLower/priceUpper don't go together: the first zips a position " +
        "you hold, the others open a new one",
      "drop `position` to open a new one in `pool`, or drop the other three to zip it",
    );
  }
  if (!args.pool) {
    throw new CookieMcpError(
      "opening a position needs `pool` (the cookiebox-clmm pool to open it in)",
      "see get_pools",
    );
  }
  if (!args.sell || !args.sell.trim()) {
    throw new CookieMcpError(
      "opening a position needs `sell`: the token you deposit and sell (a pool mint, or COOK)",
      "the position is one-sided, so what you deposit is what the order sells",
    );
  }
  let poolPk: PublicKey;
  try {
    poolPk = new PublicKey(args.pool.trim());
  } catch {
    throw new CookieMcpError(`invalid pool address: ${args.pool}`, "pass a valid pool pubkey");
  }
  const pool = parsePool(poolPk, await conn.getAccountInfo(poolPk, "confirmed"));
  const [meta, [mintAInfo, mintBInfo]] = await Promise.all([
    resolveMintMeta([pool.tokenMintA.toBase58(), pool.tokenMintB.toBase58()]),
    conn.getMultipleAccountsInfo([pool.tokenMintA, pool.tokenMintB], "confirmed"),
  ]);
  const metaA = requireMintMeta(meta, pool.tokenMintA.toBase58());
  const metaB = requireMintMeta(meta, pool.tokenMintB.toBase58());
  const pair: PairTokens = {
    mintA: pool.tokenMintA.toBase58(),
    mintB: pool.tokenMintB.toBase58(),
    symA: metaA.sym,
    symB: metaB.sym,
  };
  const current = PriceMath.sqrtPriceX64ToPrice(pool.sqrtPrice as BN, metaA.dec, metaB.dec)
    .toSignificantDigits(9)
    .toString();
  const priceUnit = `${label(pair.mintB, pair.symB)} per ${label(pair.mintA, pair.symA)}`;
  const [lower, upper] = rangeTicksFromPrices({
    lower: args.priceLower,
    upper: args.priceUpper,
    decA: metaA.dec,
    decB: metaB.dec,
    tickSpacing: pool.tickSpacing,
    unit: `${priceUnit}, now ${current}`,
  });
  const holdings = positionHoldings(pool.tickCurrentIndex, lower, upper);
  const price = (tick: number) =>
    PriceMath.tickIndexToPrice(tick, metaA.dec, metaB.dec).toSignificantDigits(9).toString();
  // Our same-range positions come first: with an external signer each call stops at the next
  // unsigned tx, so an earlier call of this request may already have opened (and funded) one. The
  // refusals below name it, so a price that moved meanwhile never strands it.
  const sameRange = await sameRangePositions(conn, signer, pool, poolPk, lower, upper);
  const stranded = strandedPositionHint(sameRange.map((p) => p.positionMint.toBase58()));
  if (holdings === "both") {
    throw new CookieMcpError(
      `the range ${price(lower)}–${price(upper)} contains the current price ${current} (${priceUnit})`,
      `a Zip starts from a one-sided range: to sell ${label(pair.mintA, pair.symA)} put the ` +
        `whole range above the price, to sell ${label(pair.mintB, pair.symB)} put it below` +
        stranded,
    );
  }
  // A range on one side of the price holds one token, so it can only sell that one.
  let direction: ZipDirection;
  try {
    direction = directionForSell(args.sell, pair, holdings);
  } catch (e) {
    if (!(e instanceof CookieMcpError) || !/holds no/.test(e.message)) throw e;
    const holds = holdings === "a" ? label(pair.mintA, pair.symA) : label(pair.mintB, pair.symB);
    const other = holdings === "a" ? label(pair.mintB, pair.symB) : label(pair.mintA, pair.symA);
    throw new CookieMcpError(
      `a range ${holdings === "a" ? "above" : "below"} the current price ${current} (${priceUnit}) ` +
        `holds only ${holds}, so it can only sell ${holds}, not ${other}`,
      `to sell ${other}, put the whole range ${holdings === "a" ? "below" : "above"} the price` +
        stranded,
    );
  }
  const spanned = rangeTickArrayCount(lower, upper, pool.tickSpacing);
  if (spanned > MAX_RANGE_TICK_ARRAYS) {
    throw new CookieMcpError(
      `this range spans ${spanned} tick arrays; Zip supports up to ${MAX_RANGE_TICK_ARRAYS}`,
      "narrow the range",
    );
  }
  // Everything that can refuse runs before the first send, so a refusal never leaves a funded
  // position without an order behind.
  if (!mintAInfo || !mintBInfo) {
    throw new CookieMcpError(
      `the pool's ${!mintAInfo ? "token A" : "token B"} mint account was not found`,
      "the pool may be misconfigured or the RPC lagging; retry, or pick another pool",
    );
  }
  const noMetaLists = await missingHookMetaLists(conn, [
    { mint: pool.tokenMintA, info: mintAInfo, sym: metaA.sym },
    { mint: pool.tokenMintB, info: mintBInfo, sym: metaB.sym },
  ]);
  if (noMetaLists.length) throw hookRefusal(noMetaLists);
  const sold =
    direction === "aToB" ? { ...metaA, mint: pair.mintA } : { ...metaB, mint: pair.mintB };
  const soldLabel = label(sold.mint, sold.sym);
  let wantRaw: bigint;
  try {
    wantRaw = uiToRaw(args.amount, sold.dec);
  } catch (e) {
    throw new CookieMcpError((e as Error).message, `amount is how much ${soldLabel} to deposit`);
  }
  if (wantRaw <= 0n) {
    throw new CookieMcpError("amount must be above zero", `how much ${soldLabel} to deposit`);
  }
  const amounts = {
    amountA: direction === "aToB" ? args.amount : undefined,
    amountB: direction === "bToA" ? args.amount : undefined,
  };
  const summary = {
    action: "open position for zip",
    pool: poolPk.toBase58(),
    deposit: `${String(args.amount)} ${soldLabel}`,
    range: `${price(lower)}–${price(upper)} ${priceUnit} (ticks ${lower}..${upper})`,
    currentPrice: `${current} ${priceUnit}`,
    direction,
    then: WAIT_BEFORE_RECALL,
  };

  // Re-entry: a same-range position of ours is this request's earlier call — funded, or empty when
  // the open went out as open + deposit and only the open landed. Use it rather than open another.
  const candidates: ReentryCandidate[] = sameRange.map((p) => ({
    ...p,
    held: direction === "aToB" ? p.held.a : p.held.b,
  }));
  const reentry = pickReentry(candidates, wantRaw);
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
    const more = reentry.more.map((c) => c.positionMint.toBase58());
    throw new CookieMcpError(
      `you already hold a position with exactly this range and no order (NFT ${mint}), holding ` +
        `${rawToUi(reentry.c.held, sold.dec)} ${soldLabel} rather than ${String(args.amount)}` +
        (more.length ? ` (and ${more.length} more like it: NFT ${more.join(", ")})` : ""),
      `zip that one with \`position: "${mint}"\` (no amount/prices), or nudge ` +
        "priceLower/priceUpper so the new range differs",
    );
  }
  // The open sends its tick arrays (rent, never refunded) before the deposit is simulated, so a
  // shortfall must be caught here, not by that simulation.
  const soldMint = new PublicKey(sold.mint);
  const balance = await soldBalanceRaw(
    conn,
    signer.publicKey,
    soldMint,
    (direction === "aToB" ? mintAInfo : mintBInfo).owner,
  );
  const short = depositShortfall({
    balance,
    want: wantRaw,
    dec: sold.dec,
    label: soldLabel,
    native: soldMint.toBase58() === COOK_MINT,
  });
  if (short) throw short;
  if (reentry?.kind === "deposit") {
    const signature = await depositClmmPosition(
      conn,
      signer,
      { poolPk, positionPk: reentry.c.positionPk, ...amounts },
      { step: "intermediate", summary: { ...summary, action: "deposit into opened position" } },
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
    { poolPk, tickLower: lower, tickUpper: upper, ...amounts },
    { step: "intermediate", summary },
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
    created: { tickArrays: missingArrays.length, payoutAccounts: missingAtas },
    repaired: { delegation: reapprove },
    ...positionView(ctx),
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
 * Stop a Zip order: closes the `RangeOrder` (rent back to its owner) and, when this wallet holds
 * the NFT, revokes the delegation. The position and its liquidity are untouched — whatever has
 * filled so far is already in the wallet, the rest stays in the position as it is. Works on a stale
 * order too (position closed): `disable` needs neither the position nor the NFT.
 */
export async function stopZip(args: { position?: string; pool?: string }): Promise<StopZipResult> {
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
  const program = zipProgram(conn);
  const ix = await buildDisableIx({
    program,
    signer: me,
    owner: order.owner,
    position: order.position,
    nft: holdsNft && nft ? { address: nft.address, tokenProgram: nft.tokenProgram } : null,
  });
  const tx = new Transaction().add(ix);
  const signature = await signSendConfirm(conn, tx, signer, [], "stop zip", {
    summary: {
      action: "stop zip",
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
