import { BN } from "@coral-xyz/anchor";
import { PriceMath } from "@orca-so/whirlpools-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  depositZipDirection,
  MAX_ZIP_PRICE_MOVE_SWAPS,
  pickFeeOption,
  poolMarketTick,
  tickOfReceivePerSell,
  touchedByZip,
  zipCrossedShare,
  zipDefaultPrices,
  zipExpectedReceive,
  zipNewPoolTick,
  zipPriceAtTick,
  zipPriceMoveSteps,
  zipRangeAbove,
  zipRangeFromPrices,
  zipRangePrices,
  zipStartTick,
  type ZipFeeOption,
  type ZipOrderSide,
} from "./order";

// COOK (9 dec) / a 6-dec token, spacing 64, price parked inside the -38400 spacing.
const A: ZipOrderSide = { sellIsA: true, decA: 9, decB: 6, tickSpacing: 64 };
const B: ZipOrderSide = { ...A, sellIsA: false };
const TICK = -38380;
const price = (side: ZipOrderSide, tick: number) => zipPriceAtTick(side, tick).toString();

describe("zipStartTick", () => {
  it("is one spacing past the price on the sell side (edge.rs)", () => {
    expect(zipStartTick(A, TICK)).toBe(-38336);
    expect(zipStartTick(B, TICK)).toBe(-38400);
    expect(zipStartTick(A, -128)).toBe(-64);
    expect(zipStartTick(B, -128)).toBe(-128);
  });
});

describe("zipRangeFromPrices (receive per sell)", () => {
  it("selling A maps the prices straight onto the pool range", () => {
    expect(zipRangeFromPrices(A, { from: price(A, -38336), to: price(A, -37696) })).toEqual({
      lower: -38336,
      upper: -37696,
      direction: "aToB",
    });
  });

  it("selling B uses reciprocal prices", () => {
    expect(zipRangeFromPrices(B, { from: price(B, -38400), to: price(B, -39040) })).toEqual({
      lower: -39040,
      upper: -38400,
      direction: "bToA",
    });
  });

  it("snaps prices to the pool's spacing and accepts numbers", () => {
    const p = PriceMath.tickIndexToPrice(-38300, 9, 6).toNumber();
    const r = zipRangeFromPrices(A, { from: p, to: price(A, -37696) });
    expect(Math.abs(r.lower % 64)).toBe(0);
  });

  it("does not judge the market: a range across the price is a valid order", () => {
    expect(zipRangeFromPrices(A, { from: price(A, -38400), to: price(A, -37696) })).toEqual({
      lower: -38400,
      upper: -37696,
      direction: "aToB",
    });
  });

  it("only refuses unusable input, naming the unit", () => {
    expect(() => zipRangeFromPrices(A, { from: "", to: "1" })).toThrow(/both `from` and `to`/);
    expect(() => zipRangeFromPrices(A, { from: undefined, to: 1 })).toThrow(/both/);
    expect(() => zipRangeFromPrices(A, { from: "-1", to: "1" })).toThrow(/positive/);
    expect(() => zipRangeFromPrices(A, { from: "2", to: "1" })).toThrow(/below `from`/);
  });

  it("widens a range narrower than one step, keeping the From end", () => {
    const p = price(A, -38336);
    expect(zipRangeFromPrices(A, { from: p, to: p })).toEqual({
      lower: -38336,
      upper: -38272,
      direction: "aToB",
    });
    const q = price(B, -38400);
    expect(zipRangeFromPrices(B, { from: q, to: `${q}1` })).toEqual({
      lower: -38464,
      upper: -38400,
      direction: "bToA",
    });
  });

  it("cuts a range too wide to run back at the To end", () => {
    const narrow = { ...A, tickSpacing: 2 };
    expect(
      zipRangeFromPrices(narrow, { from: price(narrow, -38378), to: price(narrow, 0) }),
    ).toEqual({ lower: -38378, upper: -38378 + 199 * 176, direction: "aToB" });
  });

  it("clamps prices past what the pool can represent", () => {
    expect(zipRangeFromPrices(A, { from: "1e-40", to: "1e40" }).direction).toBe("aToB");
    const lo = zipRangeFromPrices(A, { from: "1e-60", to: "1e-59" });
    expect(lo.upper - lo.lower).toBe(64);
  });

  it("reports the fitted prices From first for either side", () => {
    const r = zipRangeFromPrices(B, { from: price(B, -38400), to: price(B, -39040) });
    const p = zipRangePrices(B, r);
    expect(Number(p.to)).toBeGreaterThan(Number(p.from));
    expect(p.from).toBe(zipPriceAtTick(B, -38400).toSignificantDigits(6).toString());
  });
});

describe("zipDefaultPrices", () => {
  it("prefills a range just above the market on either side", () => {
    for (const side of [A, B]) {
      const r = zipRangeFromPrices(side, zipDefaultPrices(side, TICK));
      expect(depositZipDirection(TICK, r.lower, r.upper)).toBe(r.direction);
    }
  });
});

describe("zipCrossedShare", () => {
  // Pinned to the live COOK/EkPa… 1% pool at tick -3587 (2026-10-30 simulation).
  const range = { lower: -4224, upper: -3200 };

  it("is the part a one-sided position would hold between From and the market", () => {
    expect(zipCrossedShare({ ...range, direction: "aToB" }, -3587).toFixed(4)).toBe("0.6281");
    expect(zipCrossedShare({ ...range, direction: "bToA" }, -3587).toFixed(4)).toBe("0.3840");
  });

  it("is 0 with the market under the whole range and 1 above it", () => {
    expect(zipCrossedShare({ ...range, direction: "aToB" }, -5000).toNumber()).toBe(0);
    expect(zipCrossedShare({ ...range, direction: "aToB" }, -3200).toNumber()).toBe(1);
    expect(zipCrossedShare({ ...range, direction: "bToA" }, -3200).toNumber()).toBe(0);
    expect(zipCrossedShare({ ...range, direction: "bToA" }, -5000).toNumber()).toBe(1);
  });
});

describe("zipRangeAbove", () => {
  const s128 = (sellIsA: boolean): ZipOrderSide => ({
    sellIsA,
    decA: 9,
    decB: 9,
    tickSpacing: 128,
  });

  it("starts one step past the market and keeps the To end", () => {
    const a = { lower: -4224, upper: -3200, direction: "aToB" as const };
    expect(zipRangeAbove(s128(true), a, -3587)).toEqual({ ...a, lower: -3584 });
    const b = { lower: -4224, upper: -3200, direction: "bToA" as const };
    expect(zipRangeAbove(s128(false), b, -3587)).toEqual({ ...b, upper: -3712 });
  });

  it("leaves a range the market hasn't reached alone, and nothing of one it passed", () => {
    const a = { lower: -4224, upper: -3200, direction: "aToB" as const };
    expect(zipRangeAbove(s128(true), a, -5000)).toEqual(a);
    expect(zipRangeAbove(s128(true), a, -3200)).toBeNull();
  });
});

describe("zipExpectedReceive", () => {
  const s = { sellIsA: true, decA: 9, decB: 9, tickSpacing: 128 };
  const r = { lower: -4224, upper: -3200, direction: "aToB" as const };
  it("with no market is the geometric mean of the two edge prices", () => {
    const mid = zipPriceAtTick(s, -4224).mul(zipPriceAtTick(s, -3200)).sqrt();
    const got = zipExpectedReceive(s, r, new Decimal(10), null);
    expect(got.sub(mid.mul(10)).abs().toNumber()).toBeLessThan(1e-5);
  });
  it("sells the crossed part at the market and the rest above it", () => {
    const all = zipExpectedReceive(s, r, new Decimal(1), -3200);
    expect(all.sub(zipPriceAtTick(s, -3200)).abs().toNumber()).toBeLessThan(1e-5);
  });
});

describe("a pool created for the order", () => {
  it("opens where the edge rule starts exactly at the From price", () => {
    for (const side of [A, B]) {
      const r = zipRangeFromPrices(side, { from: "0.5", to: "0.6" });
      const tick = zipNewPoolTick(r);
      expect(depositZipDirection(tick, r.lower, r.upper)).toBe(r.direction);
      expect(zipStartTick(side, tick)).toBe(side.sellIsA ? r.lower : r.upper);
    }
  });
});

describe("zipPriceMoveSteps", () => {
  // Pinned to Cookie Chain simulations of empty pools (2026-10-30): one transaction of these
  // swaps left the pool at exactly the tick the next step starts from.
  it("walks down three tick arrays a swap, landing one below each array start", () => {
    const steps = zipPriceMoveSteps(0, -2501, 2, true)!;
    expect(steps.map((s) => s.from)).toEqual([0, -353, -881, -1409, -1937, -2465]);
    expect(steps.at(-1)!.limit).toBe(-2501);
  });

  it("walks up to each third array's last tick", () => {
    const steps = zipPriceMoveSteps(0, 2500, 2, false)!;
    expect(steps.map((s) => s.from)).toEqual([0, 526, 1054, 1582, 2110]);
    expect(steps.at(-1)!.limit).toBe(2500);
  });

  it("takes one swap per three arrays, and none when already there", () => {
    expect(zipPriceMoveSteps(-3693, -23745, 64, true)).toEqual([
      { from: -3693, limit: -16896 },
      { from: -16897, limit: -23745 },
    ]);
    expect(zipPriceMoveSteps(5, 5, 64, false)).toEqual([]);
  });

  it("refuses a price parked too far away", () => {
    expect(zipPriceMoveSteps(0, -9001, 2, true)).toBeNull();
    expect(zipPriceMoveSteps(0, -100_001, 64, true)!.length).toBeLessThanOrEqual(
      MAX_ZIP_PRICE_MOVE_SWAPS,
    );
  });
});

describe("the market and the fee", () => {
  const pk = () => Keypair.generate().publicKey;
  const pool = (liquidity: number, tick = 7) =>
    ({ liquidity: new BN(liquidity), tickCurrentIndex: tick }) as never;
  const opt = (feeBps: number, tickSpacing: number, p: unknown): ZipFeeOption => ({
    feeBps,
    tickSpacing,
    poolPk: pk(),
    pool: p as never,
  });

  it("an empty pool's price is not a market", () => {
    expect(poolMarketTick(null)).toBeNull();
    expect(poolMarketTick(pool(0))).toBeNull();
    expect(poolMarketTick(pool(5, -12))).toBe(-12);
  });

  it("a receive-per-sell price becomes the pool's tick on either side", () => {
    const t = tickOfReceivePerSell(A, zipPriceAtTick(A, -38400))!;
    expect(Math.abs(t - -38400)).toBeLessThanOrEqual(1);
    const u = tickOfReceivePerSell(B, zipPriceAtTick(B, -38400))!;
    expect(Math.abs(u - -38400)).toBeLessThanOrEqual(1);
  });

  it("picks the asked fee, else the deepest pool, else the default tier", () => {
    const opts = [opt(25, 2, null), opt(30, 64, pool(100)), opt(100, 128, pool(900))];
    expect(pickFeeOption(opts, 25, 25).feeBps).toBe(25);
    expect(pickFeeOption(opts, undefined, 25).feeBps).toBe(100);
    expect(pickFeeOption([opt(25, 2, null), opt(30, 64, pool(0))], undefined, 25).feeBps).toBe(25);
    expect(() => pickFeeOption(opts, 77, 25)).toThrow(/unsupported/);
  });
});

describe("touchedByZip", () => {
  const zip = new PublicKey("ZiPzPbbMhmUxi6XrRGN6d9qHAKtpWRpGR6orR2y1wEC");
  it("needs the Zip program among a transaction's keys; a bare transfer is not enough", () => {
    const other = Keypair.generate().publicKey;
    expect(touchedByZip(zip, [[other], null])).toBe(false);
    expect(touchedByZip(zip, [[other], [other, zip]])).toBe(true);
    expect(touchedByZip(zip, [])).toBe(false);
  });
});
