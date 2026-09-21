import { describe, it, expect } from "vitest";

import {
  assertAggNativeFlagsHonoured,
  nativeFlagsBody,
  withNativeFlags,
  routeFromAggQuote,
  type AggQuote,
} from "./cookiebox";

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

describe("assertAggNativeFlagsHonoured", () => {
  it("a default request is fine against any build, echo or not", () => {
    expect(() => assertAggNativeFlagsHonoured({}, {})).not.toThrow();
    expect(() =>
      assertAggNativeFlagsHonoured(
        { wrapSol: true, unwrapSol: true },
        { wrapSol: true, unwrapSol: true },
      ),
    ).not.toThrow();
  });

  it("a wCOOK request the server didn't echo is refused", () => {
    expect(() => assertAggNativeFlagsHonoured({ unwrapSol: false }, {})).toThrow(/did not honour/);
    expect(() =>
      assertAggNativeFlagsHonoured({ wrapSol: false }, { wrapSol: true, unwrapSol: true }),
    ).toThrow(/did not honour/);
  });

  it("a wCOOK request the server honoured passes", () => {
    expect(() =>
      assertAggNativeFlagsHonoured({ unwrapSol: false }, { wrapSol: true, unwrapSol: false }),
    ).not.toThrow();
  });

  it("reads the canonical wrapCook/unwrapCook echo, and the alias from an older agg", () => {
    expect(() =>
      assertAggNativeFlagsHonoured({ unwrapSol: false }, { wrapCook: true, unwrapCook: false }),
    ).not.toThrow();
    expect(() =>
      assertAggNativeFlagsHonoured({ unwrapSol: false }, { unwrapSol: false }),
    ).not.toThrow();
    // Canonical wins over the alias when a build echoes both.
    expect(() =>
      assertAggNativeFlagsHonoured({ unwrapSol: false }, { unwrapCook: true, unwrapSol: false }),
    ).toThrow(/did not honour/);
  });
});

describe("withNativeFlags — the tools' COOK params and their SOL aliases", () => {
  it("takes the COOK names and drops both spellings from the args", () => {
    expect(withNativeFlags({ order: "x", unwrapCook: false })).toEqual({
      order: "x",
      unwrapSol: false,
    });
  });

  it("still takes the deprecated SOL names", () => {
    expect(withNativeFlags({ wrapSol: false, unwrapSol: true })).toEqual({
      wrapSol: false,
      unwrapSol: true,
    });
  });

  it("leaves an unset flag unset, so the server's default applies", () => {
    expect(withNativeFlags({ amount: 1 })).toEqual({ amount: 1 });
  });

  it("accepts both names when they agree, refuses them when they don't", () => {
    expect(withNativeFlags({ wrapCook: false, wrapSol: false })).toEqual({ wrapSol: false });
    expect(() => withNativeFlags({ wrapCook: false, wrapSol: true })).toThrow(
      /wrapCook: false and wrapSol: true contradict/,
    );
  });
});

describe("nativeFlagsBody", () => {
  it("sends the COOK names only, and omits what the caller omitted", () => {
    expect(nativeFlagsBody({})).toEqual({});
    expect(nativeFlagsBody({ wrapSol: false })).toEqual({ wrapCook: false });
    expect(nativeFlagsBody({ wrapSol: true, unwrapSol: false })).toEqual({
      wrapCook: true,
      unwrapCook: false,
    });
  });
});

describe("routeFromAggQuote — transfer-hook warnings", () => {
  const warning = {
    type: "transferHook" as const,
    mint: MON,
    hookProgram: "4EShEanJPxFwcnovSXyznU5tLB9iMpVAdXzbrWtH5suR",
    reviewed: true,
    title: "Transfer hook · Counter (test)",
    detail: "Counts transfers; never blocks one.",
  };
  it("passes the aggregator's warnings through untouched", () => {
    expect(routeFromAggQuote({ ...base, warnings: [warning] }).warnings).toEqual([warning]);
  });
  it("omits the field when the agg sends none or predates it", () => {
    expect(routeFromAggQuote(base).warnings).toBeUndefined();
    expect(routeFromAggQuote({ ...base, warnings: [] }).warnings).toBeUndefined();
  });
});
