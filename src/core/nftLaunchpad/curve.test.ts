import { describe, expect, it } from "vitest";

import {
  allInToCurveRaw,
  curveToAllInRaw,
  designCurve,
  graduationSplit,
  profileCurve,
  selloutRaise,
  targetForBps,
  unitCost,
  unitsToTarget,
} from "./curve";

describe("unitCost — the program's quote_buy", () => {
  it("rounds the cost up, in the pool's favour", () => {
    // k = 1000·10; ceil(10000 / 9) = 1112; 1112 − 1000 = 112 (111.1 exactly).
    expect(unitCost(1000n, 10n)).toBe(112n);
  });

  it("refuses to price the last unit, as the program does", () => {
    expect(() => unitCost(1000n, 1n)).toThrow(RangeError);
  });
});

describe("designCurve + the graduation target, golden against MomoSwap", () => {
  // 444 items, 150 COOK all-in at a 2% fee, ending near 4×. The sell-out raise, the 75% target and the
  // buy that reaches it are what api.momoswap.fun's `/v1/nft/graduation-target/preview` returned for
  // these reserves (2026-10-26) — the backend port of the program's `validate_graduation_target`.
  const start = allInToCurveRaw(150_000_000_000n, 200);
  const r = designCurve(444, start, 4)!;

  it("designs the reserves the launch wizard would", () => {
    expect(start).toBe(147_058_823_529n);
    expect(r).toEqual({ virtualPaymentReserve: 130_441_176_470_223n, virtualNftReserve: 888n });
  });

  it("resolves a target exactly as the program checks it", () => {
    const sellout = selloutRaise(r.virtualPaymentReserve, r.virtualNftReserve, 444n)!;
    expect(sellout).toBe(130_441_176_470_223n);
    const target = targetForBps(sellout, 7_500);
    expect(target).toBe(97_830_882_352_668n);
    expect(unitsToTarget(r, 444, target)).toBe(381);
  });

  it("walks the curve: the first item costs the start price, the last about 4×", () => {
    const p = profileCurve(r, 444);
    expect(p.firstRaw).toBe(start);
    expect(p.lastRaw).toBe(586_252_478_519n);
    expect(p.raiseRaw).toBe(130_441_176_470_553n);
    // The all-in price round-trips to within the fee's floor.
    expect(curveToAllInRaw(p.firstRaw, 200)).toBe(149_999_999_999n);
  });

  it("refuses what the program would refuse", () => {
    expect(designCurve(1, start, 4)).toBeNull();
    expect(designCurve(10_001, start, 4)).toBeNull();
    expect(designCurve(100, 0n, 4)).toBeNull();
    expect(designCurve(2.5, start, 4)).toBeNull();
    expect(selloutRaise(1n, 10n, 10n)).toBeNull();
  });

  it("always leaves the NFT-side reserve above the supply", () => {
    for (const m of [1.2, 2, 25])
      expect(designCurve(1000, 5n, m)!.virtualNftReserve > 1000n).toBe(true);
  });
});

describe("graduationSplit", () => {
  it("locks floor_lock_bps of the raise and splits it per item", () => {
    expect(graduationSplit(1_000_000n, 2_000, 4)).toEqual({
      floorRaw: 200_000n,
      creatorRaw: 800_000n,
      floorPriceRaw: 50_000n,
    });
  });
});
