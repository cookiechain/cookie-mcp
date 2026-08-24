import { describe, it, expect } from "vitest";

import {
  assignHopIndexes,
  routeFromJupQuote,
  requireSolanaMeta,
  assertSolanaAggregator,
  assertSolanaCookPair,
  COOK_SPL_MINT,
  type JupQuote,
  type JupRoutePlanStep,
} from "./jupiter";
import { SOL_MINT } from "./config";

const COOK_SPL = "36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const step = (
  inputMint: string,
  outputMint: string,
  inAmount: string,
  outAmount: string,
  extra: Partial<JupRoutePlanStep> = {},
): JupRoutePlanStep => ({
  swapInfo: {
    ammKey: `amm-${inputMint.slice(0, 4)}-${outputMint.slice(0, 4)}`,
    label: "Pump.fun Amm",
    inputMint,
    outputMint,
    inAmount,
    outAmount,
  },
  ...extra,
});

describe("assignHopIndexes", () => {
  it("puts a single swap at hop 0", () => {
    expect(assignHopIndexes(SOL_MINT, [step(SOL_MINT, COOK_SPL, "100", "200")])).toEqual([0]);
  });

  it("orders a multi-hop route by what each leg consumes", () => {
    const plan = [step(USDC, COOK_SPL, "50", "500"), step(SOL_MINT, USDC, "100", "50")];
    // Declared out of order on purpose — the hop comes from the mint chain, not the array position.
    expect(assignHopIndexes(SOL_MINT, plan)).toEqual([1, 0]);
  });

  it("keeps every leg of a split at the same hop", () => {
    const plan = [step(SOL_MINT, COOK_SPL, "60", "600"), step(SOL_MINT, COOK_SPL, "40", "400")];
    expect(assignHopIndexes(SOL_MINT, plan)).toEqual([0, 0]);
  });

  it("terminates on an unreachable leg instead of looping forever", () => {
    const plan = [step(USDC, COOK_SPL, "50", "500")]; // nothing produces USDC
    expect(assignHopIndexes(SOL_MINT, plan)).toEqual([0]);
  });
});

describe("routeFromJupQuote", () => {
  const base: JupQuote = {
    inputMint: SOL_MINT,
    outputMint: COOK_SPL,
    inAmount: "1000000000",
    outAmount: "423028929541",
    otherAmountThreshold: "418798640246",
    priceImpactPct: "0.038067378521854959346449807",
    platformFee: null,
    routePlan: [step(SOL_MINT, COOK_SPL, "1000000000", "423028929541")],
  };

  it("maps amounts, minOut and the venue", () => {
    const r = routeFromJupQuote(base);
    expect(r.totalInAmount).toBe("1000000000");
    expect(r.totalOutAmount).toBe("423028929541");
    expect(r.grossOutAmount).toBe("423028929541");
    expect(r.minOutAmount).toBe("418798640246");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].dex).toBe("Pump.fun Amm");
    expect(r.segments[0].percentage).toBe(100);
    expect(r.route).toEqual([SOL_MINT, COOK_SPL]);
  });

  // The crux: Jupiter reports a FRACTION (0.0380 = 3.80%). Treating it as a percent understates the
  // cost 100x, which is exactly the mistake this test exists to prevent.
  it("converts priceImpactPct from a fraction to a percent", () => {
    expect(routeFromJupQuote(base).combinedPriceImpactPct).toBeCloseTo(3.8067, 4);
  });

  it("reports NaN impact (rendered as an em dash) when Jupiter omits it", () => {
    expect(routeFromJupQuote({ ...base, priceImpactPct: null }).combinedPriceImpactPct).toBeNaN();
  });

  it("flags a split route and derives each leg's share", () => {
    const r = routeFromJupQuote({
      ...base,
      routePlan: [
        step(SOL_MINT, COOK_SPL, "600000000", "253000000000"),
        step(SOL_MINT, COOK_SPL, "400000000", "170000000000"),
      ],
    });
    expect(r.isSplit).toBe(true);
    expect(r.isMultiHop).toBe(false);
    expect(r.segments.map((s) => s.percentage)).toEqual([60, 40]);
  });

  it("flags a multi-hop route and lists the mint path in hop order", () => {
    const r = routeFromJupQuote({
      ...base,
      routePlan: [
        step(SOL_MINT, USDC, "1000000000", "95000000"),
        step(USDC, COOK_SPL, "95000000", "423028929541"),
      ],
    });
    expect(r.isMultiHop).toBe(true);
    expect(r.isSplit).toBe(false);
    expect(r.segments.map((s) => s.hopIndex)).toEqual([0, 1]);
    expect(r.route).toEqual([SOL_MINT, USDC, COOK_SPL]);
  });

  it("prefers Jupiter's own percent over the derived share", () => {
    const r = routeFromJupQuote({
      ...base,
      routePlan: [step(SOL_MINT, COOK_SPL, "600000000", "1", { percent: 55 })],
    });
    expect(r.segments[0].percentage).toBe(55);
  });

  it("surfaces a platform fee only when one is actually charged", () => {
    expect(routeFromJupQuote(base).protocolFeeBps).toBeUndefined();
    const withFee = routeFromJupQuote({
      ...base,
      platformFee: { amount: "1000", feeBps: 20 },
    });
    expect(withFee.protocolFeeBps).toBe(20);
    expect(withFee.protocolFeeAmount).toBe("1000");
  });

  it("falls back to the amm key when a leg has no label", () => {
    const plan = [step(SOL_MINT, COOK_SPL, "1", "2")];
    delete plan[0].swapInfo.label;
    expect(routeFromJupQuote({ ...base, routePlan: plan }).segments[0].dex).toBe(
      plan[0].swapInfo.ammKey,
    );
  });
});

describe("requireSolanaMeta", () => {
  it("returns known metadata", () => {
    const m = new Map([[COOK_SPL, { dec: 6, sym: "COOK" }]]);
    expect(requireSolanaMeta(m, COOK_SPL)).toEqual({ dec: 6, sym: "COOK" });
  });

  // Defaulting to 9 decimals would misscale the amount by 1000x on this 6-decimal mint.
  it("throws rather than guessing decimals for an unindexed mint", () => {
    expect(() => requireSolanaMeta(new Map(), COOK_SPL)).toThrow(/unknown Solana mint/);
  });
});

describe("assertSolanaAggregator", () => {
  it("accepts an omitted aggregator or an explicit jupiter", () => {
    expect(() => assertSolanaAggregator(undefined)).not.toThrow();
    expect(() => assertSolanaAggregator("jupiter")).not.toThrow();
  });

  it("rejects a Cookie Chain aggregator instead of silently ignoring it", () => {
    expect(() => assertSolanaAggregator("cookiebox")).toThrow(/only routes Cookie Chain/);
    expect(() => assertSolanaAggregator("cookiescan")).toThrow(/only routes Cookie Chain/);
  });
});

describe("assertSolanaCookPair", () => {
  it("agrees with the bridge's SPL COOK mint", () => {
    // If these ever diverge, the Solana path would gate on a mint the bridge does not move.
    expect(COOK_SPL_MINT).toBe(COOK_SPL);
  });

  it("allows buying COOK and selling COOK, with any counter-asset", () => {
    expect(() => assertSolanaCookPair(SOL_MINT, COOK_SPL)).not.toThrow();
    expect(() => assertSolanaCookPair(COOK_SPL, SOL_MINT)).not.toThrow();
    expect(() => assertSolanaCookPair(USDC, COOK_SPL)).not.toThrow();
    expect(() => assertSolanaCookPair(COOK_SPL, USDC)).not.toThrow();
  });

  it("refuses a pair with no COOK leg, however liquid", () => {
    expect(() => assertSolanaCookPair(SOL_MINT, USDC)).toThrow(/only trades COOK/);
  });
});
