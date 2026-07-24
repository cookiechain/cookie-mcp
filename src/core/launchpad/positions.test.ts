import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  chunk,
  creatorFeeVaultPda,
  decodeTokenAmount,
  decodeUserPosition,
  userPositionPda,
  USER_POSITION_DISCRIMINATOR,
} from "./positions";

// Golden: the real on-chain UserPosition `7c4j8hud…` — wallet 9rj5GEEy… on pool 4pZSDRbe… (the MOMO
// test launch). Its decoded values match what GET /pools/:pool/position/:owner reports for the same
// wallet, so this fixture pins BOTH the PDA seeds and the field offsets against silent drift.
const GOLDEN_POOL = "4pZSDRbeimD86umZM9RGLT3mzcSQxbnohicMQcccn8gy";
const GOLDEN_OWNER = "9rj5GEEypdCbJ1W9is4LHeQxg86h9vxSny6pmsxmakni";
const GOLDEN_PDA = "7c4j8hudvNyuhTef4AoCmK4LECnqBfe1SgnBgWsEcobB";
const GOLDEN_ACCOUNT = Buffer.from(
  "+/jR9VPqERs4wghqHNZGk8ljQZ3R3ufSQRJW7rbycnI2vxfKFdauYoOahxesQupI8fIOxPn9sjEWdgRcpHRK7uaWI7VT" +
    "wpIv3vnYswAAAAAAypo7AAAAAGZnWx0AAAAAAAAA/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "base64",
);

describe("userPositionPda", () => {
  it('derives the on-chain UserPosition address from ["user", pool, owner]', () => {
    expect(userPositionPda(GOLDEN_POOL, GOLDEN_OWNER).toBase58()).toBe(GOLDEN_PDA);
  });

  it("accepts PublicKey inputs and is owner-specific", () => {
    expect(
      userPositionPda(new PublicKey(GOLDEN_POOL), new PublicKey(GOLDEN_OWNER)).toBase58(),
    ).toBe(GOLDEN_PDA);
    expect(
      userPositionPda(GOLDEN_POOL, "FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ").toBase58(),
    ).not.toBe(GOLDEN_PDA);
  });
});

describe("creatorFeeVaultPda", () => {
  it('derives from ["creator_fee_vault", pool] — the vault the API reports fees from', () => {
    // Matches GET /v1/launchpad/creator-fees/4pZSDRbe… → vault 2aNvdPhyxYJSDXyZeBHrjvK51EKhaY7J5mK2EJxapE8Q
    expect(creatorFeeVaultPda(GOLDEN_POOL).toBase58()).toBe(
      "2aNvdPhyxYJSDXyZeBHrjvK51EKhaY7J5mK2EJxapE8Q",
    );
  });
});

describe("decodeUserPosition", () => {
  it("decodes the golden account exactly as the launchpad API reports it", () => {
    const p = decodeUserPosition(GOLDEN_ACCOUNT);
    expect(p).toEqual({
      pool: GOLDEN_POOL,
      owner: GOLDEN_OWNER,
      shares: "3017341406",
      totalPaymentIn: "1000000000",
      totalPaymentOut: "492529510",
      claimed: false,
      winnerClaimed: false,
      graduatedTokensClaimed: false,
    });
  });

  it("rejects an account with a different discriminator instead of decoding garbage", () => {
    const wrong = Buffer.from(GOLDEN_ACCOUNT);
    wrong[0] = 0;
    expect(decodeUserPosition(wrong)).toBeNull();
    expect(USER_POSITION_DISCRIMINATOR.length).toBe(8);
  });

  it("rejects a truncated account", () => {
    expect(decodeUserPosition(GOLDEN_ACCOUNT.subarray(0, 64))).toBeNull();
    expect(decodeUserPosition(Buffer.alloc(0))).toBeNull();
  });

  it("reads the three claim flags independently", () => {
    const flagged = Buffer.from(GOLDEN_ACCOUNT);
    flagged[96] = 1; // claimed
    flagged[98] = 1; // graduatedTokensClaimed
    const p = decodeUserPosition(flagged)!;
    expect(p.claimed).toBe(true);
    expect(p.winnerClaimed).toBe(false);
    expect(p.graduatedTokensClaimed).toBe(true);
  });
});

describe("decodeTokenAmount", () => {
  it("reads the u64 amount at the SPL token-account offset", () => {
    const acct = Buffer.alloc(165);
    acct.writeBigUInt64LE(1_234_567_890n, 64);
    expect(decodeTokenAmount(acct)).toBe(1_234_567_890n);
  });

  it("treats a missing or truncated account as an empty vault", () => {
    expect(decodeTokenAmount(null)).toBe(0n);
    expect(decodeTokenAmount(undefined)).toBe(0n);
    expect(decodeTokenAmount(Buffer.alloc(32))).toBe(0n);
  });
});

describe("chunk", () => {
  it("splits into getMultipleAccounts-sized batches, keeping order", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const batches = chunk(items);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(items);
  });

  it("returns nothing for an empty list and honors a custom size", () => {
    expect(chunk([])).toEqual([]);
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});
