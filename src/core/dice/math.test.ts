import { describe, expect, it } from "vitest";

import {
  chanceToTarget,
  checkBet,
  clientSeedFrom,
  deriveRoll,
  formatRoll,
  freeBankroll,
  maxStakeForTarget,
  maxTargetForEdge,
  multiplier,
  payoutLamports,
  sha256,
  targetToChance,
  verifyRoll,
  type HouseRules,
} from "./math";

const COOK = 1_000_000_000n;
const rules: HouseRules = { edgeBps: 100n, minBetLamports: COOK, maxPayoutBps: 100n };
const open = { paused: false, pending: 0n, free: 10_000n * COOK };

describe("deriveRoll", () => {
  it("matches the vector pinned on both sides of cookiedice (fairness.rs + fairness.test.ts)", () => {
    expect(deriveRoll(Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), 0n)).toBe(3909);
  });

  it("depends on the nonce", () => {
    expect(deriveRoll(Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), 1n)).not.toBe(3909);
  });
});

describe("payout math (math.rs)", () => {
  it("pays stake × (10000 − edge) / target, floored", () => {
    expect(payoutLamports(COOK, 5000, 100n)).toBe(1_980_000_000n);
    expect(payoutLamports(3n, 3333, 100n)).toBe(8n); // 3 × 9900 / 3333 = 8.91 → 8
  });

  it("caps the target where a win stops beating the stake", () => {
    expect(maxTargetForEdge(100n)).toBe(9899);
    expect(payoutLamports(COOK, 9899, 100n)).toBeGreaterThan(COOK);
  });

  it("free bankroll excludes what pending bets are owed and the rent, never negative", () => {
    expect(freeBankroll(100n, 30n, 10n)).toBe(60n);
    expect(freeBankroll(10n, 30n, 10n)).toBe(0n);
  });

  it("max stake inverts the 1% profit cap, so long shots cap lower", () => {
    const even = maxStakeForTarget(rules, 10_000n * COOK, 5000);
    const longShot = maxStakeForTarget(rules, 10_000n * COOK, 1000);
    // 1% of 10,000 COOK = 100 COOK profit; at 50% profit = 0.98 × stake → ~102 COOK
    expect(even).toBe((100n * COOK * 5000n) / 4900n);
    expect(longShot).toBeLessThan(even);
    expect(maxStakeForTarget(rules, 10n * COOK, 100)).toBe(0n); // below the minimum → 0
  });
});

describe("checkBet — place_bet's order of refusals", () => {
  it("accepts a bet inside every limit", () => {
    const c = checkBet(rules, open, COOK, 5000);
    expect(c).toMatchObject({ ok: true, payout: 1_980_000_000n, profit: 980_000_000n });
  });

  it.each([
    [{ ...open, paused: true }, COOK, 5000, "paused"],
    [{ ...open, pending: 10n }, COOK, 5000, "table-stalled"],
    [open, COOK - 1n, 5000, "stake-below-minimum"],
    [open, COOK, 9900, "target-out-of-range"],
    [open, COOK, 0, "target-out-of-range"],
    [open, 1_000n * COOK, 5000, "exceeds-bankroll"],
  ] as const)("refuses %#", (state, stake, target, reason) => {
    expect(checkBet(rules, state, stake, target)).toMatchObject({ ok: false, reason });
  });
});

describe("chance ⇄ target", () => {
  it.each([
    [50, 5000],
    ["12.5", 1250],
    ["44.33%", 4433],
    ["0.01", 1],
    ["98,99", 9899],
  ] as const)("%s → %i", (chance, target) => {
    expect(chanceToTarget(chance)).toBe(target);
  });

  it("refuses more than two decimals instead of rounding", () => {
    expect(() => chanceToTarget("33.333")).toThrow(/two decimals/);
    expect(() => chanceToTarget("-5")).toThrow();
  });

  it("formats back", () => {
    expect(targetToChance(5000)).toBe("50");
    expect(targetToChance(1250)).toBe("12.5");
    expect(targetToChance(4433)).toBe("44.33");
    expect(formatRoll(5406)).toBe("54.06");
    expect(formatRoll(7)).toBe("0.07");
    expect(multiplier(5000, 100n)).toBe(1.98);
  });
});

describe("clientSeedFrom", () => {
  it("uses 64 hex chars as-is, hashes other text, randomises when omitted", () => {
    const hex = "ab".repeat(32);
    expect(clientSeedFrom(hex).toString("hex")).toBe(hex);
    expect(clientSeedFrom(`0x${hex}`).toString("hex")).toBe(hex);
    expect(clientSeedFrom("lucky")).toEqual(sha256(new TextEncoder().encode("lucky")));
    const a = clientSeedFrom();
    expect(a).toHaveLength(32);
    expect(a.equals(clientSeedFrom())).toBe(false);
  });
});

describe("verifyRoll", () => {
  const serverSeed = Buffer.alloc(32, 0x11);
  const clientSeed = Buffer.alloc(32, 0x22);
  const proof = {
    serverSeed,
    clientSeed,
    commitment: sha256(serverSeed),
    nonce: 0n,
    target: 5000,
    roll: 3909,
    won: true,
    paid: 1_980_000_000n,
    winPayout: 1_980_000_000n,
  };

  it("passes an honest settle", () => {
    expect(verifyRoll(proof)).toEqual({
      revealValid: true,
      roll: 3909,
      won: true,
      matchesChain: true,
    });
  });

  it("catches a seed that does not open the commitment", () => {
    expect(verifyRoll({ ...proof, commitment: Buffer.alloc(32) }).revealValid).toBe(false);
  });

  it("catches a published roll, outcome or payout that the seed does not derive", () => {
    expect(verifyRoll({ ...proof, roll: 6000 }).matchesChain).toBe(false);
    expect(verifyRoll({ ...proof, won: false, paid: 0n }).matchesChain).toBe(false);
    expect(verifyRoll({ ...proof, paid: COOK }).matchesChain).toBe(false);
  });
});
