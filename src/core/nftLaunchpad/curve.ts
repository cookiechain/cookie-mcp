// A drop's bonding curve, designed from the two numbers a creator thinks in.
//
// The program takes `virtual_payment_reserve` and `virtual_nft_reserve`. What a creator means is
// "the first item costs X, and the last one about N times that". This is the inverse — a port of the
// MomoSwap launch wizard's `$lib/launch/nft/curve.ts`, so a drop launched here prices exactly like one
// launched from the site — plus a walk of the real curve, so every number reported (last price, the
// raise at sell-out, the floor) is what the chain will charge.
//
// Constant product, one unit per step: the i-th unit costs about k / (y·(y−1)), so last ÷ first is
// (y₀ / (y₀ − S))². For a multiple m (s = √m): y₀ = S·s / (s − 1), x₀ = p₀ · (y₀ − 1).

/** The launch wizard's bounds: below ~1.2× the reserves blow up for no visible difference. */
export const MIN_CURVE_MULTIPLE = 1.2;
export const MAX_CURVE_MULTIPLE = 25;
export const MIN_DROP_SUPPLY = 2;
export const MAX_DROP_SUPPLY = 10_000;
/** `graduate` locks at most half the raise as the floor (program `MAX_FLOOR_LOCK_BPS`). */
export const MAX_FLOOR_LOCK_BPS = 5_000;

export interface CurveReserves {
  virtualPaymentReserve: bigint;
  virtualNftReserve: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Cost of taking one unit off the curve at reserves (x, y), before fees — the program's `quote_buy`. */
export function unitCost(x: bigint, y: bigint): bigint {
  if (y <= 1n) throw new RangeError("curve exhausted: the last unit cannot be priced");
  return ceilDiv(x * y, y - 1n) - x;
}

/**
 * Reserves for `supply` items whose first unit costs `startRaw` on the curve (fee excluded), ending
 * near `multiple`× that. Null for inputs the program would refuse or that cannot be priced.
 */
export function designCurve(
  supply: number,
  startRaw: bigint,
  multiple: number,
): CurveReserves | null {
  if (!Number.isInteger(supply) || supply < MIN_DROP_SUPPLY || supply > MAX_DROP_SUPPLY)
    return null;
  if (startRaw <= 0n || !Number.isFinite(multiple)) return null;
  const m = Math.min(MAX_CURVE_MULTIPLE, Math.max(MIN_CURVE_MULTIPLE, multiple));
  const s = Math.sqrt(m);
  // The program requires virtual_nft_reserve > total_supply; the formula clears it, but a rounding
  // floor must never land ON it.
  const y0 = Math.max(supply + 1, Math.ceil((supply * s) / (s - 1)));
  return { virtualPaymentReserve: startRaw * BigInt(y0 - 1), virtualNftReserve: BigInt(y0) };
}

export interface CurveProfile {
  firstRaw: bigint;
  lastRaw: bigint;
  /** Net COOK the curve takes in if every item mints — what graduation splits. */
  raiseRaw: bigint;
}

/** Walk the whole supply exactly as the chain prices it. */
export function profileCurve(r: CurveReserves, supply: number): CurveProfile {
  let x = r.virtualPaymentReserve;
  let y = r.virtualNftReserve;
  let raise = 0n;
  let first = 0n;
  let last = 0n;
  for (let i = 0; i < supply; i++) {
    const cost = unitCost(x, y);
    if (i === 0) first = cost;
    last = cost;
    raise += cost;
    x += cost;
    y -= 1n;
  }
  return { firstRaw: first, lastRaw: last, raiseRaw: raise };
}

/**
 * Collectors see the curve price plus the trade fee, and that all-in number is the one a creator sets
 * (it is what the site shows as "to mint"). Curve = all-in × 10000 / (10000 + fee), floored.
 */
export function allInToCurveRaw(allInRaw: bigint, tradeFeeBps: number): bigint {
  return (allInRaw * 10_000n) / BigInt(10_000 + tradeFeeBps);
}

export function curveToAllInRaw(curveRaw: bigint, tradeFeeBps: number): bigint {
  return curveRaw + (curveRaw * BigInt(tradeFeeBps)) / 10_000n;
}

/** `graduate`: the floor is raise × floor_lock_bps, the creator gets the rest, the floor splits per item. */
export function graduationSplit(
  raiseRaw: bigint,
  floorLockBps: number,
  supply: number,
): { floorRaw: bigint; creatorRaw: bigint; floorPriceRaw: bigint } {
  const floorRaw = (raiseRaw * BigInt(floorLockBps)) / 10_000n;
  return {
    floorRaw,
    creatorRaw: raiseRaw - floorRaw,
    floorPriceRaw: supply > 0 ? floorRaw / BigInt(supply) : 0n,
  };
}

// ── Graduation at a target (anchor #92) ──────────────────────────────────────
//
// A drop may graduate before it sells out, once the raise reaches a creator-chosen target between half
// and all of the sell-out raise. The program checks the target against the CLOSED-FORM sell-out raise
// below (`validate_graduation_target`), not the unit-by-unit walk, so the target is resolved from it —
// as the backend and the launch wizard both do.

export const MIN_TARGET_BPS = 5_000;
export const MAX_TARGET_BPS = 10_000;

/** ceil(vpr · supply / (vnr − supply)); null when the reserves cannot sell out this supply. */
export function selloutRaise(vpr: bigint, vnr: bigint, supply: bigint): bigint | null {
  if (vpr <= 0n || supply <= 0n || vnr <= supply) return null;
  return ceilDiv(vpr * supply, vnr - supply);
}

/** The raw target for `bps` of the sell-out raise, rounded up. */
export function targetForBps(selloutRaw: bigint, bps: number): bigint {
  return ceilDiv(selloutRaw * BigInt(bps), 10_000n);
}

/** How many buys bring the raise to `targetRaw` (the buy that graduates the drop), or null. */
export function unitsToTarget(r: CurveReserves, supply: number, targetRaw: bigint): number | null {
  if (targetRaw <= 0n) return null;
  let x = r.virtualPaymentReserve;
  let y = r.virtualNftReserve;
  let raised = 0n;
  for (let i = 1; i <= supply; i++) {
    const cost = unitCost(x, y);
    raised += cost;
    if (raised >= targetRaw) return i;
    x += cost;
    y -= 1n;
  }
  return null;
}
