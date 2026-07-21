import { describe, it, expect } from "vitest";

import {
  encodeStakeIxData,
  decodeStakePool,
  poolRate,
  estimateBcookOut,
  estimateCookOut,
  WITHDRAW_AUTHORITY,
  IX_DEPOSIT_SOL,
  IX_WITHDRAW_SOL,
  DEPOSIT_FEE_BPS,
  WITHDRAW_FEE_BPS,
} from "./stake";

// SPL StakePool account: accountType u8 (1 = StakePool) at 0; totalLamports u64 LE at 258;
// poolTokenSupply u64 LE at 266. Enough bytes to reach the two u64s.
function poolAccount(totalLamports: bigint, poolTokenSupply: bigint, type = 1): Buffer {
  const buf = Buffer.alloc(266 + 8);
  buf[0] = type;
  buf.writeBigUInt64LE(totalLamports, 258);
  buf.writeBigUInt64LE(poolTokenSupply, 266);
  return buf;
}

describe("encodeStakeIxData", () => {
  it("lays out tag(u8) + amount(u64 LE) for DepositSol (14)", () => {
    const data = encodeStakeIxData(IX_DEPOSIT_SOL, 5_000_000_000n); // 5 COOK @ 9 decimals
    expect(data.length).toBe(9);
    expect(data[0]).toBe(14);
    expect(data.readBigUInt64LE(1)).toBe(5_000_000_000n);
  });

  it("uses tag 16 for WithdrawSol", () => {
    const data = encodeStakeIxData(IX_WITHDRAW_SOL, 1n);
    expect(data[0]).toBe(16);
    expect(data.readBigUInt64LE(1)).toBe(1n);
  });
});

describe("decodeStakePool", () => {
  it("reads the two u64s at their fixed offsets and derives the rate", () => {
    const s = decodeStakePool(poolAccount(3_000_000_000n, 2_000_000_000n));
    expect(s.totalLamports).toBe(3_000_000_000n);
    expect(s.poolTokenSupply).toBe(2_000_000_000n);
    expect(s.rate).toBeCloseTo(1.5, 12);
  });

  it("rejects a non-StakePool account type", () => {
    expect(() => decodeStakePool(poolAccount(1n, 1n, 2))).toThrow(/stake pool/i);
  });

  it("rejects a too-short buffer", () => {
    expect(() => decodeStakePool(Buffer.alloc(10))).toThrow(/stake pool/i);
  });
});

describe("poolRate", () => {
  it("is COOK per bCOOK", () => {
    expect(poolRate(10n, 8n)).toBeCloseTo(1.25, 12);
  });
  it("defaults to 1 for an empty pool (no division by zero)", () => {
    expect(poolRate(0n, 0n)).toBe(1);
  });
});

describe("stake/unstake estimates apply the fees", () => {
  it("estimateBcookOut nets the deposit fee then divides by rate", () => {
    // 100 COOK, 0.5% fee, rate 2 -> 100 * 0.995 / 2 = 49.75 bCOOK
    expect(estimateBcookOut(100, 2)).toBeCloseTo(49.75, 9);
    expect(DEPOSIT_FEE_BPS).toBe(50);
  });

  it("estimateCookOut multiplies by rate then nets the withdrawal fee", () => {
    // 50 bCOOK, rate 2, 2% fee -> 50 * 2 * 0.98 = 98 COOK
    expect(estimateCookOut(50, 2)).toBeCloseTo(98, 9);
    expect(WITHDRAW_FEE_BPS).toBe(200);
  });
});

describe("WITHDRAW_AUTHORITY", () => {
  it('is the golden PDA of the stake pool + "withdraw" seed (guards the seed/program/pool)', () => {
    expect(WITHDRAW_AUTHORITY.toBase58()).toBe("BjAja3zTTgdTQ5rvbE8qCny38LCc9scWwAm8NBszQtqg");
  });
});
