import { PriceMath } from "@orca-so/whirlpools-sdk";
import { describe, expect, it } from "vitest";

import {
  amountDeltaA,
  amountDeltaB,
  decideZip,
  fullyFilled,
  maxLiquidity,
  nextRange,
  withdrawAmounts,
  type ZipDirection,
} from "./decision";

const sqrtAt = (tick: number) => BigInt(PriceMath.tickIndexToSqrtPriceX64(tick).toString());

// The live COOK/COOKHOUSE position (pool 8UPUKWa8…): spacing 64, range [-39296, -38336], price parked
// on the upper edge, holding only COOKHOUSE (token B) — direction bToA. Same numbers as the cookiebox
// keeper's suite and the program's LiteSVM suite, so the three implementations stay in step.
const LOWER = -39296;
const UPPER = -38336;

describe("nextRange mirrors edge::next_range", () => {
  it("bToA moves the upper edge down to the boundary at or below the price", () => {
    expect(nextRange("bToA", -38500, 64, LOWER, UPPER, 1)).toEqual({ lower: LOWER, upper: -38528 });
    expect(nextRange("bToA", -38464, 64, LOWER, UPPER, 1)).toEqual({ lower: LOWER, upper: -38464 });
  });

  it("bToA waits for min_step", () => {
    expect(nextRange("bToA", -38400, 64, LOWER, UPPER, 2)).toEqual({ wait: "stepTooSmall" });
    expect(nextRange("bToA", -38464, 64, LOWER, UPPER, 2)).toEqual({ lower: LOWER, upper: -38464 });
    expect(nextRange("bToA", UPPER, 64, LOWER, UPPER, 1)).toEqual({ wait: "stepTooSmall" });
    expect(nextRange("bToA", UPPER + 500, 64, LOWER, UPPER, 1)).toEqual({ wait: "stepTooSmall" });
  });

  it("bToA in the last spacing waits; below lower is fully filled", () => {
    expect(nextRange("bToA", LOWER + 10, 64, LOWER, UPPER, 1)).toEqual({ wait: "lastSpacing" });
    expect(nextRange("bToA", LOWER, 64, LOWER, UPPER, 1)).toEqual({ wait: "lastSpacing" });
    expect(nextRange("bToA", LOWER - 1, 64, LOWER, UPPER, 1)).toEqual({ wait: "fullyFilled" });
  });

  it("aToB moves the lower edge strictly above the price", () => {
    expect(nextRange("aToB", -39200, 64, LOWER, UPPER, 1)).toEqual({ lower: -39168, upper: UPPER });
    expect(nextRange("aToB", -39232, 64, LOWER, UPPER, 1)).toEqual({ lower: -39168, upper: UPPER });
    expect(nextRange("aToB", LOWER - 1, 64, LOWER, UPPER, 1)).toEqual({ wait: "stepTooSmall" });
    expect(nextRange("aToB", -39232, 64, LOWER, UPPER, 3)).toEqual({ wait: "stepTooSmall" });
    expect(nextRange("aToB", UPPER - 1, 64, LOWER, UPPER, 1)).toEqual({ wait: "lastSpacing" });
    expect(nextRange("aToB", UPPER, 64, LOWER, UPPER, 1)).toEqual({ wait: "fullyFilled" });
  });

  it("positive ticks (Math.floor matches Rust's div_euclid on both signs)", () => {
    expect(nextRange("aToB", 130, 64, 0, 640, 1)).toEqual({ lower: 192, upper: 640 });
    expect(nextRange("bToA", 130, 64, 0, 640, 1)).toEqual({ lower: 0, upper: 128 });
  });

  it("fullyFilled follows the CLMM's tick convention (upper is exclusive)", () => {
    expect(fullyFilled("aToB", UPPER, LOWER, UPPER)).toBe(true);
    expect(fullyFilled("aToB", UPPER - 1, LOWER, UPPER)).toBe(false);
    expect(fullyFilled("bToA", LOWER, LOWER, UPPER)).toBe(false);
    expect(fullyFilled("bToA", LOWER - 1, LOWER, UPPER)).toBe(true);
  });
});

describe("amount math matches the CLMM's rounding", () => {
  const L = 10n ** 12n;
  it("round-up adds one exactly when there is a remainder", () => {
    const [a, b] = [sqrtAt(-512), sqrtAt(0)];
    expect(amountDeltaA(L, a, b, true) - amountDeltaA(L, a, b, false)).toBe(1n);
    expect(amountDeltaB(L, a, b, true) - amountDeltaB(L, a, b, false)).toBe(1n);
    expect(amountDeltaB(0n, a, b, true)).toBe(0n);
  });

  it("withdrawAmounts picks the status from the tick, not the sqrt price", () => {
    const base = {
      liquidity: L,
      lower: -1280,
      upper: 0,
      sqrtLower: sqrtAt(-1280),
      sqrtUpper: sqrtAt(0),
    };
    expect(withdrawAmounts({ ...base, tickCurrent: 0, sqrtPrice: sqrtAt(0) }).a).toBe(0n);
    expect(withdrawAmounts({ ...base, tickCurrent: -1281, sqrtPrice: sqrtAt(-1281) }).b).toBe(0n);
    const mid = withdrawAmounts({ ...base, tickCurrent: -500, sqrtPrice: sqrtAt(-500) });
    expect(mid.a > 0n && mid.b > 0n).toBe(true);
  });

  // Regression from the program's LiteSVM suite: the exact numbers whose deposit equalled the
  // withdrawal when sized without the one-unit margin.
  it("reproduces the LiteSVM case (L=1e12, range [-1280,0], price at -500)", () => {
    const out = withdrawAmounts({
      liquidity: L,
      tickCurrent: -500,
      sqrtPrice: 17991314827369146358n,
      lower: -1280,
      upper: 0,
      sqrtLower: sqrtAt(-1280),
      sqrtUpper: sqrtAt(0),
    });
    expect(out.b).toBe(37303130133n);
  });
});

describe("maxLiquidity never asks for more than unfilled - 1", () => {
  const cases: [ZipDirection, number, number][] = [
    ["bToA", -39296, -38528],
    ["bToA", -1280, -512],
    ["aToB", 640, 1408],
    ["aToB", -39168, -38336],
  ];
  for (const [direction, lo, hi] of cases) {
    it(`${direction} [${lo}, ${hi}]`, () => {
      const [sLo, sHi] = [sqrtAt(lo), sqrtAt(hi)];
      for (const unfilled of [2n, 3n, 1_000n, 37303130133n, 24_000_000_000_000n, 2n ** 63n]) {
        const L = maxLiquidity(direction, unfilled, sLo, sHi);
        const deposit =
          direction === "bToA" ? amountDeltaB(L, sLo, sHi, true) : amountDeltaA(L, sLo, sHi, true);
        expect(deposit <= unfilled - 1n).toBe(true);
        const more =
          direction === "bToA"
            ? amountDeltaB(L + 1n, sLo, sHi, true)
            : amountDeltaA(L + 1n, sLo, sHi, true);
        expect(more >= deposit).toBe(true);
      }
      expect(maxLiquidity(direction, 1n, sLo, sHi)).toBe(0n);
    });
  }
});

describe("decideZip", () => {
  const L = 3505876075642183n; // the live position's liquidity
  const order = (tickCurrent: number, over: Partial<Parameters<typeof decideZip>[0]> = {}) =>
    decideZip({
      direction: "bToA",
      minStep: 1,
      tickSpacing: 64,
      tickCurrent,
      sqrtPrice: sqrtAt(tickCurrent),
      liquidity: L,
      lower: LOWER,
      upper: UPPER,
      sqrtAt,
      ...over,
    });

  it("waits while the price sits on the unfilled edge (the live order right now)", () => {
    expect(order(UPPER)).toEqual({ kind: "wait", reason: "stepTooSmall" });
  });

  it("zips with liquidity at least the old once the price moved a spacing", () => {
    const d = order(-38500);
    expect(d.kind).toBe("zip");
    if (d.kind !== "zip") return;
    expect([d.lower, d.upper]).toEqual([LOWER, -38528]);
    expect(d.liquidity >= L).toBe(true);
  });

  it("finishes once fully filled, even with no liquidity left", () => {
    expect(order(LOWER - 1)).toEqual({ kind: "finish" });
    expect(order(LOWER - 1, { liquidity: 0n })).toEqual({ kind: "finish" });
  });

  it("waits in the last spacing", () => {
    expect(order(LOWER + 3)).toEqual({ kind: "wait", reason: "lastSpacing" });
  });

  it("an emptied position waits rather than predicting a doomed zip", () => {
    expect(order(-38500, { liquidity: 0n })).toEqual({ kind: "wait", reason: "noLiquidity" });
  });

  it("aToB mirrors it", () => {
    const d = decideZip({
      direction: "aToB",
      minStep: 1,
      tickSpacing: 64,
      tickCurrent: 600,
      sqrtPrice: sqrtAt(600),
      liquidity: 10n ** 12n,
      lower: 128,
      upper: 1408,
      sqrtAt,
    });
    expect(d).toMatchObject({ kind: "zip", lower: 640, upper: 1408 });
  });
});
