// A Zip order as Cookiebox's /trade tab states it: sell `amount` of one token for the other between
// two prices, **receive per sell** (what one sold token fetches), so for either side a higher price
// is a better fill. Whatever part of the range the market already beats is sold at once, never
// under the From price; the rest waits above the market as a one-sided CLMM position the keeper
// trails. Ported from cookiebox `zipOrderRange.ts`, `zipPoolPrep.ts`, `zipSellNow.ts`.
//
// In pool terms (price = B per A): selling A is a range above the pool price (the position holds
// only A); selling B is a range below it (holds only B), at the reciprocal prices.
import { BN } from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import {
  IGNORE_CACHE,
  MAX_TICK_INDEX,
  MIN_TICK_INDEX,
  PDAUtil,
  PriceMath,
  SwapUtils,
  swapQuoteWithParams,
  TICK_ARRAY_SIZE,
  TickUtil,
  TokenExtensionUtil,
  WhirlpoolIx,
  type WhirlpoolClient,
  type WhirlpoolData,
} from "@orca-so/whirlpools-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Transaction,
  type Connection,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import Decimal from "decimal.js";

import { CookieMcpError } from "../errors";
import {
  CLMM_PROGRAM_ID,
  legacyTxWireSize,
  OPEN_POSITION_CU,
  sendBuilder,
  WHIRLPOOL_CONFIG_ADDRESS,
  type SendExtra,
} from "../liquidity/clmm";
import { signSendConfirm } from "../liquidity/send";
import type { TxSigner } from "../signer";
import type { ZipDirection } from "./decision";
import { buildTickArrayInitIxs, MAX_RANGE_TICK_ARRAYS, rangeTickArrays } from "./program";

// --- the order's range ----------------------------------------------------------------------------

export type ZipOrderSide = { sellIsA: boolean; decA: number; decB: number; tickSpacing: number };

export type ZipOrderRange = { lower: number; upper: number; direction: ZipDirection };

const directionOf = (sellIsA: boolean): ZipDirection => (sellIsA ? "aToB" : "bToA");

function parsePrice(v: string | number | undefined): Decimal | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  try {
    const d = new Decimal(t);
    return d.isFinite() && d.gt(0) ? d : null;
  } catch {
    return null;
  }
}

/** The receive-per-sell price at a tick boundary. */
export function zipPriceAtTick(side: ZipOrderSide, tick: number): Decimal {
  const pool = PriceMath.tickIndexToPrice(tick, side.decA, side.decB);
  return side.sellIsA ? pool : new Decimal(1).div(pool);
}

/** The receive-per-sell price of a pool price (B per A). */
export function zipPriceOfPool(side: ZipOrderSide, bPerA: Decimal): Decimal {
  return side.sellIsA ? bPerA : new Decimal(1).div(bPerA);
}

/**
 * The first tick boundary a new order may start from: one spacing past the current price, on the
 * sell side. The same edge rule the program uses (`edge.rs`), so a range starting here holds only
 * the sold token and its first step is exactly one spacing away.
 */
export function zipStartTick(side: ZipOrderSide, tickCurrent: number): number {
  const base = Math.floor(tickCurrent / side.tickSpacing) * side.tickSpacing;
  return side.sellIsA ? base + side.tickSpacing : base;
}

/**
 * Turn the two prices into the position's tick range, snapped to the pool's spacing. Only unusable
 * input is refused (a missing price, To under From); everything else is fitted silently: a price
 * past what the pool supports is clamped to its limit, a range narrower than one price step is
 * widened to one, and one too wide to run is cut back at the To end. The From end is always kept —
 * it is the price the user won't sell under. Where the market is is not judged here: the part of
 * the range the market beats is sold at once when the order is placed (`zipCrossedShare`).
 */
export function zipRangeFromPrices(
  side: ZipOrderSide,
  p: { from: string | number | undefined; to: string | number | undefined },
): ZipOrderRange {
  const from = parsePrice(p.from);
  const to = parsePrice(p.to);
  if (!from || !to) {
    throw new CookieMcpError(
      "pass both `from` and `to`: positive prices, as what one sold token fetches",
      "for example from: 20, to: 22 sells across 20–22 RECEIVE per SELL",
    );
  }
  if (to.lt(from)) {
    throw new CookieMcpError(
      `\`to\` (${to.toString()}) is below \`from\` (${from.toString()})`,
      "both prices are what one sold token fetches, so `to` is the better (higher) one; swap them",
    );
  }
  const s = side.tickSpacing;
  const minTick = Math.ceil(MIN_TICK_INDEX / s) * s;
  const maxTick = Math.floor(MAX_TICK_INDEX / s) * s;
  const clamp = (t: number) => Math.min(maxTick, Math.max(minTick, t));
  const [poolLo, poolHi] = side.sellIsA
    ? [from, to]
    : [new Decimal(1).div(to), new Decimal(1).div(from)];
  const tick = (d: Decimal) => {
    try {
      return clamp(PriceMath.priceToInitializableTickIndex(d, side.decA, side.decB, s));
    } catch {
      return d.lt(1) ? minTick : maxTick;
    }
  };
  let lower = tick(poolLo);
  let upper = tick(poolHi);
  const widest = (MAX_RANGE_TICK_ARRAYS - 1) * TICK_ARRAY_SIZE * s;
  if (side.sellIsA) {
    upper = Math.min(Math.max(upper, lower + s), lower + widest);
    if (upper > maxTick) [lower, upper] = [maxTick - s, maxTick];
  } else {
    lower = Math.max(Math.min(lower, upper - s), upper - widest);
    if (lower < minTick) [lower, upper] = [minTick, minTick + s];
  }
  return { lower, upper, direction: directionOf(side.sellIsA) };
}

/** The range's two prices, receive per sell, From first (6 significant digits). */
export function zipRangePrices(side: ZipOrderSide, r: ZipOrderRange): { from: string; to: string } {
  const [fromTick, toTick] = side.sellIsA ? [r.lower, r.upper] : [r.upper, r.lower];
  const fmt = (t: number) => zipPriceAtTick(side, t).toSignificantDigits(6).toString();
  return { from: fmt(fromTick), to: fmt(toTick) };
}

/** Which one token a position over [lower, upper) holds at `tickCurrent`, or null when both. */
export function depositZipDirection(
  tickCurrent: number,
  lower: number,
  upper: number,
): ZipDirection | null {
  if (tickCurrent < lower) return "aToB";
  if (tickCurrent >= upper) return "bToA";
  return null;
}

const sqrtAtTick = (tick: number) => new Decimal("1.0001").pow(tick / 2);

/**
 * The share (0–1) of an order's amount at prices the market already beats: the part a one-sided
 * position over the range would hold between its From end and the market. Liquidity is uniform in
 * √price, so selling A over [L, U] holds A ∝ 1/√L − 1/√U, and selling B holds B ∝ √U − √L.
 */
export function zipCrossedShare(range: ZipOrderRange, marketTick: number): Decimal {
  const sL = sqrtAtTick(range.lower);
  const sU = sqrtAtTick(range.upper);
  if (range.direction === "aToB") {
    if (marketTick < range.lower) return new Decimal(0);
    if (marketTick >= range.upper) return new Decimal(1);
    const one = new Decimal(1);
    return one
      .div(sL)
      .sub(one.div(sqrtAtTick(marketTick)))
      .div(one.div(sL).sub(one.div(sU)));
  }
  if (marketTick >= range.upper) return new Decimal(0);
  if (marketTick < range.lower) return new Decimal(1);
  return sU.sub(sqrtAtTick(marketTick)).div(sU.sub(sL));
}

/**
 * What is left of the range once the part the market beats is sold: it starts one price step past
 * the market (the program's edge rule), keeps its To end, and is `null` when nothing is left.
 */
export function zipRangeAbove(
  side: ZipOrderSide,
  range: ZipOrderRange,
  marketTick: number,
): ZipOrderRange | null {
  const start = zipStartTick(side, marketTick);
  if (side.sellIsA) {
    const lower = Math.max(range.lower, start);
    return lower < range.upper ? { ...range, lower } : null;
  }
  const upper = Math.min(range.upper, start);
  return upper > range.lower ? { ...range, upper } : null;
}

/**
 * Where a pool created for an order starts: just outside the range on the side the order sells
 * into, so the first buy fills it at the From price. Selling A, one tick below `lower` (the
 * program's edge rule then starts at `lower`); selling B, exactly `upper`.
 */
export function zipNewPoolTick(range: ZipOrderRange): number {
  return range.direction === "aToB" ? range.lower - 1 : range.upper;
}

/** Default prices: from one spacing past the current price, to `widthPct` above it. */
export function zipDefaultPrices(
  side: ZipOrderSide,
  tickCurrent: number,
  widthPct = 10,
): { from: string; to: string } {
  const start = zipPriceAtTick(side, zipStartTick(side, tickCurrent));
  return {
    from: start.toSignificantDigits(6).toString(),
    to: start
      .mul(1 + widthPct / 100)
      .toSignificantDigits(6)
      .toString(),
  };
}

/** Expected receive for `amountUi` sold: the crossed part at the market, the rest at the geometric mean. */
export function zipExpectedReceive(
  side: ZipOrderSide,
  range: ZipOrderRange,
  amountUi: Decimal,
  marketTick: number | null,
): Decimal {
  const avgOver = (r: ZipOrderRange) => {
    const [from, to] = side.sellIsA ? [r.lower, r.upper] : [r.upper, r.lower];
    return zipPriceAtTick(side, from).mul(zipPriceAtTick(side, to)).sqrt();
  };
  if (marketTick == null) return amountUi.mul(avgOver(range));
  const share = zipCrossedShare(range, marketTick);
  const rest = zipRangeAbove(side, range, marketTick);
  const now = zipPriceAtTick(side, marketTick);
  return amountUi
    .mul(share)
    .mul(now)
    .add(rest ? amountUi.mul(new Decimal(1).sub(share)).mul(avgOver(rest)) : 0);
}

// --- which pool -----------------------------------------------------------------------------------

/** The standard-tier pool PDA for a pair at a tick spacing (canonical mint order). */
export function standardPoolPda(
  mintA: PublicKey,
  mintB: PublicKey,
  tickSpacing: number,
): PublicKey {
  return PDAUtil.getWhirlpool(CLMM_PROGRAM_ID, WHIRLPOOL_CONFIG_ADDRESS, mintA, mintB, tickSpacing)
    .publicKey;
}

export interface ZipFeeOption {
  feeBps: number;
  tickSpacing: number;
  poolPk: PublicKey;
  /** The pool's state when it exists; `null` for a pool the order would create. */
  pool: WhirlpoolData | null;
}

/**
 * The fee the order earns: `feeBps` when given, else the deepest existing pool of the pair, else the
 * default tier. Pure over the read pools, so the rule is testable.
 */
export function pickFeeOption(
  options: ZipFeeOption[],
  feeBps: number | undefined,
  defaultFeeBps: number,
): ZipFeeOption {
  if (feeBps != null) {
    const o = options.find((x) => x.feeBps === feeBps);
    if (!o) {
      throw new CookieMcpError(
        `unsupported CLMM fee ${feeBps} bps`,
        `use one of: ${options.map((x) => x.feeBps).join(", ")}`,
      );
    }
    return o;
  }
  let deepest: ZipFeeOption | null = null;
  for (const o of options) {
    const liq = o.pool ? BigInt(o.pool.liquidity.toString()) : 0n;
    if (liq > 0n && (!deepest || liq > BigInt(deepest.pool!.liquidity.toString()))) deepest = o;
  }
  if (deepest) return deepest;
  return options.find((o) => o.feeBps === defaultFeeBps) ?? options[0]!;
}

// --- the market -----------------------------------------------------------------------------------

/**
 * The pool's own price as a tick when it has liquidity (an empty pool's price is whatever it was
 * left at), else `null`: the caller then prices against the router, or not at all.
 */
export function poolMarketTick(pool: WhirlpoolData | null): number | null {
  if (!pool || pool.liquidity.isZero()) return null;
  return pool.tickCurrentIndex;
}

/** A receive-per-sell price (one sold token fetches `receivePerSell`) as the pool's tick. */
export function tickOfReceivePerSell(side: ZipOrderSide, receivePerSell: Decimal): number | null {
  try {
    const bPerA = side.sellIsA ? receivePerSell : new Decimal(1).div(receivePerSell);
    return PriceMath.priceToTickIndex(bPerA, side.decA, side.decB);
  } catch {
    return null;
  }
}

// --- the pool, ready for the deposit --------------------------------------------------------------

/** Pool creation, price moves through empty tick arrays and tick-array inits all fit well under. */
const ZIP_PREP_COMPUTE_UNITS = 1_400_000;
/** Price-move swaps an order may need; a pool parked further away is refused, not walked. */
export const MAX_ZIP_PRICE_MOVE_SWAPS = 8;
const LEGACY_TX_MAX_BYTES = 1232;

/** The live pool's price moved into the order's range: re-price above the market and retry. */
export class ZipMarketMoved extends Error {
  constructor() {
    super("the market price moved into the order's range");
  }
}

export const TOO_FAR = "this fee's pool can't take the order right now";

/**
 * The swaps that walk an empty pool's price from `from` to `target`, each as the tick it starts
 * from and the price limit it stops at — or `null` past {@link MAX_ZIP_PRICE_MOVE_SWAPS}.
 *
 * One swap reaches through the three tick arrays the program derives from the price. Across empty
 * arrays it can go as far as the last one's edge — its start tick going down, its last tick going
 * up — and stopping exactly there stores a known tick: one below the start going down (the edge
 * counts as crossed), the edge itself going up. The final swap stops on the target.
 */
export function zipPriceMoveSteps(
  from: number,
  target: number,
  spacing: number,
  aToB: boolean,
): { from: number; limit: number }[] | null {
  const span = TICK_ARRAY_SIZE * spacing;
  const steps: { from: number; limit: number }[] = [];
  let tick = from;
  while (tick !== target) {
    if (steps.length >= MAX_ZIP_PRICE_MOVE_SWAPS) return null;
    const base = TickUtil.getStartTickIndex(tick + (aToB ? 0 : spacing), spacing);
    const edge = aToB ? base - 2 * span : base + 3 * span - spacing;
    const last = aToB ? target >= edge : target <= edge;
    const limit = last ? target : edge;
    if (limit === tick) return null;
    steps.push({ from: tick, limit });
    tick = last || !aToB ? limit : edge - 1;
  }
  return steps;
}

function threeTickArrays(tick: number, spacing: number, aToB: boolean, poolPk: PublicKey) {
  const arrays = SwapUtils.getTickArrayPublicKeys(tick, spacing, aToB, CLMM_PROGRAM_ID, poolPk);
  return {
    tickArray0: arrays[0]!,
    tickArray1: arrays[1] ?? arrays[0]!,
    tickArray2: arrays[2] ?? arrays[1] ?? arrays[0]!,
  };
}

const computeLimit = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: ZIP_PREP_COMPUTE_UNITS });

/** Append `ixs` in order to the last tx while they fit, opening new ones as needed. */
function pack(owner: PublicKey, txs: Transaction[], ixs: TransactionInstruction[]): Transaction[] {
  for (const ix of ixs) {
    const last = txs[txs.length - 1]!;
    last.instructions.push(ix);
    if (legacyTxWireSize(last, owner) <= LEGACY_TX_MAX_BYTES) continue;
    last.instructions.pop();
    const t = new Transaction().add(computeLimit(), ix);
    t.feePayer = owner;
    txs.push(t);
  }
  return txs;
}

export type PoolPrep =
  | { kind: "ready" }
  | { kind: "create"; txs: Transaction[]; signers: import("@solana/web3.js").Signer[] }
  | { kind: "move"; txs: Transaction[] };

/**
 * Get the pool ready for a Zip order's deposit, so any pair, fee and price works:
 * - **no pool** at the chosen fee → create it on the standard tier, priced right at the order's
 *   edge (`zipNewPoolTick`), with the range's tick arrays in the same transactions;
 * - **an empty pool** parked on the wrong side of the order → move its price to the order's edge.
 *   With no liquidity a swap only moves the price: it trades nothing, so it costs only the fee;
 * - anything else → nothing to do. A pool with liquidity is never moved: its price is the market,
 *   and the order is priced against it (`ZipMarketMoved` when it has moved into the range).
 */
export async function prepZipPool(p: {
  conn: Connection;
  client: WhirlpoolClient;
  owner: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  tickSpacing: number;
  poolPk: PublicKey;
  range: ZipOrderRange;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
}): Promise<PoolPrep> {
  const { conn, client, owner, mintA, mintB, range, poolPk } = p;
  const rangeInits = () =>
    buildTickArrayInitIxs(conn, {
      whirlpool: poolPk,
      arrays: rangeTickArrays(poolPk, range.lower, range.upper, p.tickSpacing),
      funder: owner,
    });

  // Re-checked on chain: a pool may have been created since the options were read.
  if (!(await conn.getAccountInfo(poolPk, "confirmed"))) {
    const { tx } = await client.createPool(
      WHIRLPOOL_CONFIG_ADDRESS,
      mintA,
      mintB,
      p.tickSpacing,
      zipNewPoolTick(range),
      owner,
    );
    const payload = await tx.build({ maxSupportedTransactionVersion: "legacy" });
    const create = payload.transaction as Transaction;
    create.instructions.unshift(computeLimit());
    create.feePayer = owner;
    return {
      kind: "create",
      txs: pack(owner, [create], rangeInits()),
      signers: payload.signers as import("@solana/web3.js").Signer[],
    };
  }

  const pool = await client.getPool(poolPk, IGNORE_CACHE);
  const data = pool.getData();
  if (depositZipDirection(data.tickCurrentIndex, range.lower, range.upper) === range.direction) {
    return { kind: "ready" };
  }
  if (!data.liquidity.isZero()) throw new ZipMarketMoved();

  // Selling A the price must end below the range (move down, a→b); selling B, above it (b→a).
  // Either way the swap's input is the sold token, so the wallet holds it.
  const aToB = range.direction === "aToB";
  const target = zipNewPoolTick(range);
  const spacing = data.tickSpacing;
  const span = TICK_ARRAY_SIZE * spacing;

  // Liquidity anywhere between the price and the order's edge would trade, not just move.
  const pathStarts: number[] = [];
  const from = TickUtil.getStartTickIndex(data.tickCurrentIndex, spacing);
  const to = TickUtil.getStartTickIndex(target, spacing);
  for (let s = from; aToB ? s >= to : s <= to; s += aToB ? -span : span) pathStarts.push(s);
  const tooFar = () =>
    new CookieMcpError(
      `${TOO_FAR}: its price is parked too far from the order, or other liquidity sits in between`,
      "pass another `fee`, or move `from` closer to where that pool's price is",
    );
  if (pathStarts.length > MAX_ZIP_PRICE_MOVE_SWAPS * 3 + 3) throw tooFar();
  const pathArrays = await client.getFetcher().getTickArrays(
    pathStarts.map((s) => PDAUtil.getTickArray(CLMM_PROGRAM_ID, poolPk, s).publicKey),
    IGNORE_CACHE,
  );
  const [lo, hi] = aToB ? [target, data.tickCurrentIndex] : [data.tickCurrentIndex, target];
  pathArrays.forEach((arr, i) => {
    arr?.ticks.forEach((t, j) => {
      const tick = pathStarts[i]! + j * spacing;
      if (t.initialized && tick >= lo && tick <= hi) throw tooFar();
    });
  });

  const ataA = getAssociatedTokenAddressSync(mintA, owner, true, p.tokenProgramA);
  const ataB = getAssociatedTokenAddressSync(mintB, owner, true, p.tokenProgramB);
  const [ataAInfo, ataBInfo] = await conn.getMultipleAccountsInfo([ataA, ataB], "confirmed");
  const setup: TransactionInstruction[] = [];
  const cleanup: TransactionInstruction[] = [];
  for (const [ata, mint, program, info] of [
    [ataA, mintA, p.tokenProgramA, ataAInfo],
    [ataB, mintB, p.tokenProgramB, ataBInfo],
  ] as const) {
    if (info) continue;
    setup.push(createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, program));
    if (mint.equals(NATIVE_MINT)) cleanup.push(createCloseAccountInstruction(ata, owner, owner));
  }

  const ctx = client.getContext();
  const extCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
    client.getFetcher(),
    mintA,
    mintB,
    IGNORE_CACHE,
  );
  const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(
    conn,
    extCtx,
    aToB ? ataA : data.tokenVaultA,
    aToB ? data.tokenVaultA : ataA,
    aToB ? owner : poolPk,
    aToB ? data.tokenVaultB : ataB,
    aToB ? ataB : data.tokenVaultB,
    aToB ? poolPk : owner,
  );
  const oracle = PDAUtil.getOracle(CLMM_PROGRAM_ID, poolPk).publicKey;
  const steps = zipPriceMoveSteps(data.tickCurrentIndex, target, spacing, aToB);
  if (!steps) throw tooFar();
  const swaps = steps.flatMap(
    (step) =>
      WhirlpoolIx.swapV2Ix(ctx.program, {
        amount: new BN(1),
        otherAmountThreshold: new BN(0),
        sqrtPriceLimit: PriceMath.tickIndexToSqrtPriceX64(step.limit),
        amountSpecifiedIsInput: true,
        aToB,
        ...threeTickArrays(step.from, spacing, aToB, poolPk),
        whirlpool: poolPk,
        tokenMintA: mintA,
        tokenMintB: mintB,
        tokenOwnerAccountA: ataA,
        tokenOwnerAccountB: ataB,
        tokenVaultA: data.tokenVaultA,
        tokenVaultB: data.tokenVaultB,
        tokenTransferHookAccountsA: hooks.tokenTransferHookAccountsA,
        tokenTransferHookAccountsB: hooks.tokenTransferHookAccountsB,
        tokenProgramA: p.tokenProgramA,
        tokenProgramB: p.tokenProgramB,
        oracle,
        tokenAuthority: owner,
      }).instructions,
  );
  const move = new Transaction().add(computeLimit(), ...setup);
  move.feePayer = owner;
  return {
    kind: "move",
    txs: pack(owner, pack(owner, [move], [...swaps, ...cleanup]), rangeInits()),
  };
}

// --- selling the crossed part now -----------------------------------------------------------------

/** Slippage on the sale; the From price is the hard floor regardless. */
export const ZIP_SELL_NOW_SLIPPAGE_BPS = 50;

/** The order's From edge as a pool tick: the price nothing is sold under. */
export const fromEdgeTick = (range: ZipOrderRange) =>
  range.direction === "aToB" ? range.lower : range.upper;

/**
 * Sell up to `amountRaw` in the live pool, its price limit at From, so every unit fetches at least
 * From. Returns what the swap spent (re-quoted to exactly that when the limit stops it early, so
 * the rest of the wallet's balance is left for the order), or 0n when nothing would sell.
 */
export async function sellNowInPool(
  conn: Connection,
  signer: TxSigner,
  client: WhirlpoolClient,
  poolPk: PublicKey,
  range: ZipOrderRange,
  amountRaw: bigint,
  extra: SendExtra,
): Promise<{ takes: bigint; signature: string | null }> {
  const whirlpool = await client.getPool(poolPk, IGNORE_CACHE);
  const data = whirlpool.getData();
  const aToB = range.direction === "aToB";
  const limit = PriceMath.tickIndexToSqrtPriceX64(fromEdgeTick(range));
  if (aToB ? limit.gte(data.sqrtPrice) : limit.lte(data.sqrtPrice)) {
    return { takes: 0n, signature: null };
  }
  const fetcher = client.getFetcher();
  const [tickArrays, oracleData, tokenExtensionCtx] = await Promise.all([
    SwapUtils.getTickArrays(
      data.tickCurrentIndex,
      data.tickSpacing,
      aToB,
      CLMM_PROGRAM_ID,
      poolPk,
      fetcher,
      IGNORE_CACHE,
    ),
    SwapUtils.getOracle(CLMM_PROGRAM_ID, poolPk, fetcher, IGNORE_CACHE),
    TokenExtensionUtil.buildTokenExtensionContext(fetcher, data, IGNORE_CACHE),
  ]);
  const quote = (tokenAmount: BN) =>
    swapQuoteWithParams(
      {
        whirlpoolData: data,
        tokenAmount,
        otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
        sqrtPriceLimit: limit,
        aToB,
        amountSpecifiedIsInput: true,
        tickArrays,
        oracleData,
        tokenExtensionCtx,
        timestampInSeconds: new BN(Math.floor(Date.now() / 1000)),
      },
      Percentage.fromFraction(ZIP_SELL_NOW_SLIPPAGE_BPS, 10_000),
    );
  let q = quote(new BN(amountRaw.toString()));
  const takes = BigInt(q.estimatedAmountIn.toString());
  if (takes <= 0n || q.estimatedAmountOut.isZero()) return { takes: 0n, signature: null };
  if (takes < amountRaw) q = quote(q.estimatedAmountIn);
  const builder = await whirlpool.swap(q, signer.publicKey);
  const signature = await sendBuilder(
    conn,
    signer,
    builder,
    OPEN_POSITION_CU,
    "zip: sell the part the market already beats",
    extra,
  );
  return { takes, signature };
}

/** Send prepared legacy transactions in order through the shared simulate-first sender. */
export async function sendPrepared(
  conn: Connection,
  signer: TxSigner,
  txs: Transaction[],
  signers: import("@solana/web3.js").Signer[],
  what: string,
  extra: SendExtra,
): Promise<string[]> {
  const sigs: string[] = [];
  for (let i = 0; i < txs.length; i++) {
    const label = txs.length > 1 ? `${what} (${i + 1}/${txs.length})` : what;
    // Only the first transaction can carry the pool-mint style ephemeral signers.
    sigs.push(await signSendConfirm(conn, txs[i]!, signer, i === 0 ? signers : [], label, extra));
  }
  return sigs;
}

// --- a filled order's leftover position -----------------------------------------------------------

/**
 * Whether an empty CLMM position is a Zip order's leftover: the keeper's `finish` withdrew
 * everything and closed the order, leaving the empty position for its owner to close. One of the
 * order PDA's recent successful transactions must name the Zip program — anyone can send lamports
 * to the PDA, so a bare signature on it is not enough. Pure over the fetched keys.
 */
export function touchedByZip(zipId: PublicKey, txKeys: (readonly PublicKey[] | null)[]): boolean {
  return txKeys.some((keys) => keys?.some((k) => k.equals(zipId)) ?? false);
}
