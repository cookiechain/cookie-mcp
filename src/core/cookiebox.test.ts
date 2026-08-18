import { describe, it, expect } from "vitest";

import { routeFromAggQuote, type AggQuote } from "./cookiebox";

const COOK = "So11111111111111111111111111111111111111112";
const MON = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";

const base: AggQuote = {
  inAmount: "10000000000",
  outAmount: "8891410470",
  feePct: 0,
  feeAmount: "0",
  netOutAmount: "8891410470",
  minOutAmount: "8429946266",
  priceImpactPct: 0.252,
  path: [COOK, MON],
  isSplit: false,
  isMultiHop: false,
  segments: [
    {
      pool: "78e15qHtzR4nXFpSy8VSzSpDxqyzbKNtrjdTo5neBorq",
      venue: "cookiebox-damm",
      inputMint: COOK,
      outputMint: MON,
      inAmount: "10000000000",
      outAmount: "8891410470",
      hopIndex: 0,
    },
  ],
};

describe("routeFromAggQuote", () => {
  it("maps a fee-free direct route with gross == net and no protocol fee fields", () => {
    const r = routeFromAggQuote(base);
    expect(r.totalInAmount).toBe("10000000000");
    expect(r.totalOutAmount).toBe("8891410470");
    expect(r.grossOutAmount).toBe("8891410470");
    expect(r.protocolFeeBps).toBeUndefined();
    expect(r.protocolFeeAmount).toBeUndefined();
    expect(r.minOutAmount).toBe("8429946266");
    expect(r.combinedPriceImpactPct).toBe(0.252);
    expect(r.segments[0]).toMatchObject({
      dex: "cookiebox-damm",
      poolAddress: "78e15qHtzR4nXFpSy8VSzSpDxqyzbKNtrjdTo5neBorq",
      percentage: 100,
      hopIndex: 0,
    });
    expect(r.isSplit).toBe(false);
    expect(r.isMultiHop).toBe(false);
  });

  it("maps a non-zero fee into protocolFeeBps/Amount and nets totalOutAmount", () => {
    const r = routeFromAggQuote({
      ...base,
      feePct: 0.2,
      feeAmount: "17782821",
      netOutAmount: "8873627649",
    });
    expect(r.protocolFeeBps).toBe(20);
    expect(r.protocolFeeAmount).toBe("17782821");
    expect(r.totalOutAmount).toBe("8873627649");
    expect(r.grossOutAmount).toBe("8891410470");
  });

  it("derives split percentages per hop when the agg omits them", () => {
    const r = routeFromAggQuote({
      ...base,
      isSplit: true,
      segments: [
        { ...base.segments[0], inAmount: "7500000000", outAmount: "6000000000" },
        {
          ...base.segments[0],
          pool: "2ndPool1111111111111111111111111111111111111",
          inAmount: "2500000000",
          outAmount: "2000000000",
        },
      ],
    });
    expect(r.segments.map((s) => s.percentage)).toEqual([75, 25]);
  });

  it("keeps agg-provided percentages and maps null price impact to NaN", () => {
    const r = routeFromAggQuote({
      ...base,
      priceImpactPct: null,
      segments: [{ ...base.segments[0], percentage: 42 }],
    });
    expect(r.segments[0].percentage).toBe(42);
    expect(Number.isNaN(r.combinedPriceImpactPct)).toBe(true);
  });
});
