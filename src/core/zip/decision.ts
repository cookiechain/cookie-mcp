// The Zip keeper's decision, ported from cookiebox `src/solana/zip/zipDecision.ts`: when
// an order's trailing edge moves, where to, and with how much liquidity. This server never cranks an
// order (the Cookiebox keeper does), but the same rules tell an agent what the keeper will do next
// with an order it starts or lists, and whether a position can be zipped in a direction at all.
//
// `nextRange` mirrors `edge::next_range` in the program (`zip/programs/zip/src/edge.rs`)
// line for line. The program recomputes the range itself and only takes `new_liquidity` from the
// keeper, so a drift here costs a wrong prediction, never funds. Pure: bigints in, plain data out.
//
// CLMM convention: a position holds only token A while `tickCurrent < lower`, both tokens while
// `lower <= tickCurrent < upper`, and only token B once `tickCurrent >= upper`.

/** `aToB` holds A and fills into B as the price rises; `bToA` holds B and fills into A as it falls. */
export type ZipDirection = "aToB" | "bToA";

export type RangeWait = "fullyFilled" | "lastSpacing" | "stepTooSmall";

/** The whole range has converted: nothing of the sold token is left in it. */
export function fullyFilled(
  direction: ZipDirection,
  tickCurrent: number,
  lower: number,
  upper: number,
): boolean {
  return direction === "aToB" ? tickCurrent >= upper : tickCurrent < lower;
}

/** The range after a zip, or why there is none. Mirrors `edge::next_range`. */
export function nextRange(
  direction: ZipDirection,
  tickCurrent: number,
  tickSpacing: number,
  lower: number,
  upper: number,
  minStep: number,
): { lower: number; upper: number } | { wait: RangeWait } {
  if (fullyFilled(direction, tickCurrent, lower, upper)) return { wait: "fullyFilled" };
  const step = tickSpacing * minStep;
  const floor = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
  if (direction === "aToB") {
    // First boundary strictly above the price.
    const newLower = floor + tickSpacing;
    if (newLower >= upper) return { wait: "lastSpacing" };
    if (newLower < lower + step) return { wait: "stepTooSmall" };
    return { lower: newLower, upper };
  }
  // Last boundary at or below the price.
  const newUpper = floor;
  if (newUpper <= lower) return { wait: "lastSpacing" };
  if (newUpper > upper - step) return { wait: "stepTooSmall" };
  return { lower, upper: newUpper };
}

const Q64 = 1n << 64n;

/** The CLMM's `get_amount_delta_a`: L * (sb - sa) * 2^64 / (sa * sb). */
export function amountDeltaA(
  liquidity: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  const numerator = liquidity * (hi - lo) * Q64;
  const denominator = lo * hi;
  const q = numerator / denominator;
  return roundUp && numerator % denominator !== 0n ? q + 1n : q;
}

/** The CLMM's `get_amount_delta_b`: L * (sb - sa) / 2^64. */
export function amountDeltaB(
  liquidity: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  const product = liquidity * (hi - lo);
  const q = product / Q64;
  return roundUp && product % Q64 !== 0n ? q + 1n : q;
}

/**
 * What withdrawing all of `liquidity` pays out, exactly as the CLMM computes it: the status comes
 * from the tick index, the amounts from the sqrt price, rounded down. This is also what the position
 * holds right now, which is how the tools report a position's contents.
 *
 * Not the legacy SDK's `PoolUtil.getTokenAmountsFromLiquidity`: it runs on decimal.js at 20
 * significant digits, too few for L * sqrtPrice (~1e31), and can round UP.
 */
export function withdrawAmounts(p: {
  liquidity: bigint;
  tickCurrent: number;
  sqrtPrice: bigint;
  lower: number;
  upper: number;
  sqrtLower: bigint;
  sqrtUpper: bigint;
}): { a: bigint; b: bigint } {
  if (p.tickCurrent < p.lower) {
    return { a: amountDeltaA(p.liquidity, p.sqrtLower, p.sqrtUpper, false), b: 0n };
  }
  if (p.tickCurrent < p.upper) {
    return {
      a: amountDeltaA(p.liquidity, p.sqrtPrice, p.sqrtUpper, false),
      b: amountDeltaB(p.liquidity, p.sqrtLower, p.sqrtPrice, false),
    };
  }
  return { a: 0n, b: amountDeltaB(p.liquidity, p.sqrtLower, p.sqrtUpper, false) };
}

/**
 * The most liquidity the new one-sided range can take from `unfilled` tokens, leaving at least one
 * behind. One unit, because an exact match fails: the CLMM's `calculate_token_delta(x, x)` reports a
 * zero-amount transfer *from the owner*, which the token program refuses since the program's PDA is
 * not the owner. Rounding is the CLMM's (deposits round up), so the deposit is <= unfilled - 1.
 */
export function maxLiquidity(
  direction: ZipDirection,
  unfilled: bigint,
  sqrtNewLower: bigint,
  sqrtNewUpper: bigint,
): bigint {
  if (unfilled <= 1n) return 0n;
  const budget = unfilled - 1n;
  const width = sqrtNewUpper - sqrtNewLower;
  // bToA: the new range is below the price and holds only B: b = L * width / 2^64.
  if (direction === "bToA") return (budget * Q64) / width;
  // aToB: the new range is above the price and holds only A: a = L * width * 2^64 / (lo * hi).
  return (budget * sqrtNewLower * sqrtNewUpper) / (width * Q64);
}

/** `zip` refuses liquidity below the old minus this fraction (1 ppm, `LIQUIDITY_TOLERANCE_DENOM`). */
export const LIQUIDITY_TOLERANCE_DENOM = 1_000_000n;

export type ZipDecision =
  | { kind: "zip"; lower: number; upper: number; liquidity: bigint }
  | { kind: "finish" }
  | { kind: "wait"; reason: RangeWait | "noLiquidity" | "liquidityBelowFloor" };

/**
 * One order's move on the keeper's next pass. `sqrtAt` is the CLMM's tick-to-sqrt-price (the SDK's
 * `PriceMath.tickIndexToSqrtPriceX64`), passed in so this module stays dependency-free.
 */
export function decideZip(p: {
  direction: ZipDirection;
  minStep: number;
  tickSpacing: number;
  tickCurrent: number;
  sqrtPrice: bigint;
  liquidity: bigint;
  lower: number;
  upper: number;
  sqrtAt: (tick: number) => bigint;
}): ZipDecision {
  if (fullyFilled(p.direction, p.tickCurrent, p.lower, p.upper)) {
    // `finish` also collects fees, so it is worth sending even once the liquidity is gone.
    return { kind: "finish" };
  }
  if (p.liquidity === 0n) return { kind: "wait", reason: "noLiquidity" };
  const next = nextRange(p.direction, p.tickCurrent, p.tickSpacing, p.lower, p.upper, p.minStep);
  if ("wait" in next) return { kind: "wait", reason: next.wait };

  const out = withdrawAmounts({
    liquidity: p.liquidity,
    tickCurrent: p.tickCurrent,
    sqrtPrice: p.sqrtPrice,
    lower: p.lower,
    upper: p.upper,
    sqrtLower: p.sqrtAt(p.lower),
    sqrtUpper: p.sqrtAt(p.upper),
  });
  const unfilled = p.direction === "aToB" ? out.a : out.b;
  const liquidity = maxLiquidity(p.direction, unfilled, p.sqrtAt(next.lower), p.sqrtAt(next.upper));
  // Cannot happen with exact math (the new range is a sub-range of the old one on the unfilled
  // side, so the old liquidity always fits). Waiting beats sending a transaction that must fail.
  if (liquidity < p.liquidity - p.liquidity / LIQUIDITY_TOLERANCE_DENOM) {
    return { kind: "wait", reason: "liquidityBelowFloor" };
  }
  return { kind: "zip", lower: next.lower, upper: next.upper, liquidity };
}
