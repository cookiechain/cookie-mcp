import { describe, it, expect } from "vitest";

import { DEFAULT_TRADE_FEE_BPS, poolFeeShareBps, poolTradeFeeBps } from "./fees";

// The global schedule the launchpad's `/config` reports today.
const CFG = {
  tradeFeeBps: 100,
  treasuryFeeBps: 3000,
  creatorFeeBps: 3500,
  referralFeeBps: 2000,
  buybackFeeBps: 1500,
};

// A real divergence, not a hypothetical: pool SAKURA snapshotted 75 bps / 3500-2500-2500-1500 while
// `/config` reports 100 / 3000-3500-2000-1500. Quoting it off the config overstates its fee by a third.
const SAKURA = {
  tradeFeeBps: 75,
  treasuryFeeBps: 3500,
  creatorFeeBps: 2500,
  referralFeeBps: 2500,
  buybackFeeBps: 1500,
};

describe("poolTradeFeeBps", () => {
  it("prefers the pool's own snapshot over the global config", () => {
    expect(poolTradeFeeBps(SAKURA, CFG)).toBe(75);
  });

  it("falls back to the config when the pool carries no snapshot", () => {
    // The deployed API predates the release that serializes these fields, so this is the live case:
    // every pool arrives bare and must resolve exactly as it did before this module existed.
    expect(poolTradeFeeBps({ tokenMint: "x" } as never, CFG)).toBe(100);
    expect(poolTradeFeeBps(null, CFG)).toBe(100);
  });

  it("honours a zero fee instead of treating it as missing", () => {
    // The fee-free deployment EZWe5C5g… really does run at 0 bps, so `||` would be a bug here.
    expect(poolTradeFeeBps({ tradeFeeBps: 0 }, CFG)).toBe(0);
    expect(poolTradeFeeBps(null, { tradeFeeBps: 0 })).toBe(0);
  });

  it("accepts a numeric string — it is JSON off the wire", () => {
    expect(poolTradeFeeBps({ tradeFeeBps: "75" } as never, CFG)).toBe(75);
  });

  it("falls through garbage rather than poisoning a quote with NaN", () => {
    for (const bad of ["abc", -1, Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(poolTradeFeeBps({ tradeFeeBps: bad } as never, CFG)).toBe(100);
    }
  });

  // `Number([])` is 0 and `Number([75])` is 75, so a bare coercion would accept an array-valued field
  // as a real fee — and the empty case as a 0% one, understating what the chain charges. Rejected
  // before coercion instead. The frontend's equivalent helper does NOT do this; keep the divergence.
  it("rejects an array-valued field instead of coercing it to 0", () => {
    expect(poolTradeFeeBps({ tradeFeeBps: [] } as never, CFG)).toBe(100);
    expect(poolTradeFeeBps({ tradeFeeBps: [75] } as never, CFG)).toBe(100);
  });

  it("uses the launch default only when neither source states a fee", () => {
    expect(poolTradeFeeBps(null, null)).toBe(DEFAULT_TRADE_FEE_BPS);
  });

  // ⚠️ Do NOT re-tighten this bound to the program's MAX_TRADE_FEE_BPS (1000). 10000 is a mathematical
  // ceiling; 1000 is a policy constant an upgrade can raise. Bound at 1000 and the day the cap moves, a
  // pool with a legitimate 1500-bps snapshot is discarded in favour of /config and we understate the fee
  // the chain actually charges — the exact failure this module exists to prevent, from the other side.
  it("honours a snapshot above the program's current cap but below 100%", () => {
    expect(poolTradeFeeBps({ tradeFeeBps: 1500 }, CFG)).toBe(1500);
    expect(poolTradeFeeBps({ tradeFeeBps: 10_000 }, CFG)).toBe(10_000);
  });

  it("rejects anything over 100% as corrupt", () => {
    expect(poolTradeFeeBps({ tradeFeeBps: 10_001 }, CFG)).toBe(100);
  });
});

describe("poolFeeShareBps", () => {
  it("resolves each share from the pool's snapshot", () => {
    expect(poolFeeShareBps(SAKURA, CFG, "treasury")).toBe(3500);
    expect(poolFeeShareBps(SAKURA, CFG, "creator")).toBe(2500);
    expect(poolFeeShareBps(SAKURA, CFG, "referral")).toBe(2500);
    expect(poolFeeShareBps(SAKURA, CFG, "buyback")).toBe(1500);
  });

  it("falls back to the config share, then to zero", () => {
    expect(poolFeeShareBps(null, CFG, "creator")).toBe(3500);
    // Unknown means "don't claim a split" — inventing the launch default here would report a cut
    // nobody is actually taking.
    expect(poolFeeShareBps(null, null, "creator")).toBe(0);
  });
});
