import { describe, it, expect } from "vitest";

import { formatQuote } from "./quote";
import type { CandyShopMultiRoute } from "./candyshop";

const COOK = "So11111111111111111111111111111111111111112";
const MON = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";

const route: CandyShopMultiRoute = {
  segments: [
    {
      dex: "cpamm",
      poolAddress: "78e15qHtzR4nXFpSy8VSzSpDxqyzbKNtrjdTo5neBorq",
      inAmount: "10000000000",
      outAmount: "8891410470",
      priceImpactPct: 0,
      programName: "Cookiebox DAMM",
      inputMint: COOK,
      outputMint: MON,
    },
  ],
  totalInAmount: "10000000000",
  totalOutAmount: "8873627649",
  grossOutAmount: "8891410470",
  protocolFeeAmount: "17782821",
  protocolFeeBps: 20,
  combinedPriceImpactPct: 0.252,
  minOutAmount: "8429946266",
  route: [COOK, MON],
  isSplit: false,
  isMultiHop: false,
};

const ctx = {
  inputMint: COOK,
  outputMint: MON,
  inSym: "COOK",
  outSym: "MON",
  inDec: 9,
  outDec: 6,
  slippageBps: 500,
};

describe("formatQuote", () => {
  it("reports gross expected out and net-of-fee separately", () => {
    const q = formatQuote(route, ctx);
    expect(q.input.amount).toBe("10");
    expect(q.output.expectedOut).toBe("8891.41047"); // gross
    expect(q.output.outAfterCandyShopFee).toBe("8873.627649"); // net of 20 bps
    expect(q.output.minOut).toBe("8429.946266");
  });

  it("surfaces the Candy Shop fee and price impact", () => {
    const q = formatQuote(route, ctx);
    expect(q.candyShopFee).toEqual({ bps: 20, amount: "17.782821" });
    expect(q.priceImpactPct).toBe("0.252%");
    expect(q.slippageBps).toBe(500);
  });

  it("exposes route hops as raw amounts with venue labels", () => {
    const q = formatQuote(route, ctx);
    expect(q.route.split).toBe(false);
    expect(q.route.hops).toHaveLength(1);
    expect(q.route.hops[0]).toMatchObject({
      venue: "Cookiebox DAMM",
      inAmountRaw: "10000000000",
      outAmountRaw: "8891410470",
    });
  });

  it("falls back to totalOutAmount when grossOutAmount is absent", () => {
    const q = formatQuote({ ...route, grossOutAmount: undefined }, ctx);
    expect(q.output.expectedOut).toBe("8873.627649");
  });
});
