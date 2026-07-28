import { describe, it, expect, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  chunk,
  creatorFeeVaultPda,
  decodeTokenAmount,
  decodeUserPosition,
  fetchPoolPrograms,
  fetchPositionsForPools,
  resetPoolProgramCache,
  userPositionPda,
  USER_POSITION_DISCRIMINATOR,
} from "./positions";
import { LAUNCHPAD_PROGRAM_CURRENT } from "./program";

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

describe("program-scoped PDA derivation", () => {
  // PDAs are program-scoped: the same pool under a different deployment is a different address. This
  // is the whole reason positions.ts reads each pool's owner instead of trusting one constant — a
  // wrong program id yields addresses that simply do not exist, i.e. an empty portfolio, no error.
  it("derives a different UserPosition under a different program id", () => {
    const underCurrent = userPositionPda(
      GOLDEN_POOL,
      GOLDEN_OWNER,
      new PublicKey(LAUNCHPAD_PROGRAM_CURRENT),
    );
    expect(underCurrent.toBase58()).not.toBe(GOLDEN_PDA);
    expect(userPositionPda(GOLDEN_POOL, GOLDEN_OWNER).toBase58()).toBe(GOLDEN_PDA);
  });

  it("scopes the creator-fee vault the same way", () => {
    expect(
      creatorFeeVaultPda(GOLDEN_POOL, new PublicKey(LAUNCHPAD_PROGRAM_CURRENT)).toBase58(),
    ).not.toBe(creatorFeeVaultPda(GOLDEN_POOL).toBase58());
  });

  it("uses each pool's own program, so a mixed-deployment portfolio still resolves", async () => {
    const OTHER_POOL = "4YgzpSWSMR5gAHzDnzL6cyJH1rVZuz2SNJ9AZEPp33em";
    const current = new PublicKey(LAUNCHPAD_PROGRAM_CURRENT);
    const programs = new Map([[OTHER_POOL, current]]); // GOLDEN_POOL deliberately absent -> default
    const asked: string[] = [];
    const conn = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        asked.push(...keys.map((k) => k.toBase58()));
        return keys.map(() => null);
      },
    } as never;
    await fetchPositionsForPools(conn, GOLDEN_OWNER, [GOLDEN_POOL, OTHER_POOL], programs);
    expect(asked).toEqual([
      GOLDEN_PDA, // configured id, because this pool was not in the map
      userPositionPda(OTHER_POOL, GOLDEN_OWNER, current).toBase58(),
    ]);
  });
});

describe("fetchPoolPrograms", () => {
  const OTHER_POOL = "4YgzpSWSMR5gAHzDnzL6cyJH1rVZuz2SNJ9AZEPp33em";

  beforeEach(() => resetPoolProgramCache());

  it("maps each pool to its owning program and omits pools it cannot read", async () => {
    const conn = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) =>
        keys.map((_k, i) => (i === 0 ? { owner: new PublicKey(LAUNCHPAD_PROGRAM_CURRENT) } : null)),
    } as never;
    const out = await fetchPoolPrograms(conn, [GOLDEN_POOL, OTHER_POOL]);
    expect(out.get(GOLDEN_POOL)?.toBase58()).toBe(LAUNCHPAD_PROGRAM_CURRENT);
    expect(out.size).toBe(1);
  });

  it("caches ownership — an account's owner is immutable, so the second call costs no RPC", async () => {
    let calls = 0;
    const conn = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        calls++;
        return keys.map(() => ({ owner: new PublicKey(LAUNCHPAD_PROGRAM_CURRENT) }));
      },
    } as never;
    await fetchPoolPrograms(conn, [GOLDEN_POOL, OTHER_POOL]);
    const again = await fetchPoolPrograms(conn, [GOLDEN_POOL, OTHER_POOL]);
    expect(calls).toBe(1);
    expect(again.get(OTHER_POOL)?.toBase58()).toBe(LAUNCHPAD_PROGRAM_CURRENT);
  });

  it("only reads the pools it has not seen before", async () => {
    const asked: string[][] = [];
    const conn = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        asked.push(keys.map((k) => k.toBase58()));
        return keys.map(() => ({ owner: new PublicKey(LAUNCHPAD_PROGRAM_CURRENT) }));
      },
    } as never;
    await fetchPoolPrograms(conn, [GOLDEN_POOL]);
    await fetchPoolPrograms(conn, [GOLDEN_POOL, OTHER_POOL]);
    expect(asked).toEqual([[GOLDEN_POOL], [OTHER_POOL]]);
  });

  it("does not cache a pool it failed to read, so the next call retries it", async () => {
    let calls = 0;
    const conn = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        calls++;
        return keys.map(() =>
          calls === 1 ? null : { owner: new PublicKey(LAUNCHPAD_PROGRAM_CURRENT) },
        );
      },
    } as never;
    expect((await fetchPoolPrograms(conn, [GOLDEN_POOL])).size).toBe(0);
    expect((await fetchPoolPrograms(conn, [GOLDEN_POOL])).size).toBe(1);
    expect(calls).toBe(2);
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
