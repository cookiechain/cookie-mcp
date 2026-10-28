import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { PROGRAM_IDS, RATCHET_KEEPER } from "../config";
import { CLMM_PROGRAM_ID } from "../liquidity/clmm";
import {
  buildDisableIx,
  buildEnableIx,
  buildPayoutAtaIxs,
  buildTickArrayInitIxs,
  decodePositionNft,
  decodeRangeOrder,
  enableTransactions,
  MAX_RANGE_TICK_ARRAYS,
  missingTickArrays,
  nativePayoutPda,
  parsePool,
  parsePosition,
  payoutAccounts,
  positionPdaForMint,
  RANGE_ORDER_DISCRIMINATOR,
  rangeOrderFilters,
  rangeOrderPda,
  rangeTickArrayCount,
  rangeTickArrays,
  RATCHET_PROGRAM_ID,
  ratchetProgram,
  sqrtAt,
  TICK_ARRAY_INITS_PER_TX,
  tickArrayFor,
} from "./program";

// --- golden fixtures: the first order ever opened on the live program (2026-10-28), read-only ------
// Owner 8kBvpMzo…, position FaRJUds9… (NFT CJoGwAhw…) in the COOK/COOKHOUSE pool 8UPUKWa8…, bToA,
// min_step 1, cranker = the Cookiebox keeper. The bytes pin the account layouts and the seed strings.
const ORDER_ADDRESS = new PublicKey("CmMXNeV49wzarZC3MmtiWyS7bLSBExRp6joZwS3DXNQe");
const ORDER_B64 =
  "cxcRF2bfXZpzEiOzmG8JcWudmdDJR2KFQRdIOO6c+qhTW9zvMHCbQtiTQuG7UKzqnBnY1y3qrOxLwsPiwXCjzzpY6ufEHi89p//AwKymntmw45a+UWXwelfk4xr+SDOW19aI76ZR62JvBeX9CiC5yV8Q08VYILNa05Jjku0ZuhdJ6rzpAOcj6wEBAAGD2pEqNzseYNNfoll59oaL5zeFm/DLzCm0hc7bAzINWP4=";
const OWNER = new PublicKey("8kBvpMzouRzb8ZhrJJFMrBh3qcEsgnf6w2EUSxU7JTGD");
const POSITION = new PublicKey("FaRJUds9diC3w8vVqoFKnXwt5CNLFJb4stXqG78tfryi");
const POSITION_MINT = new PublicKey("CJoGwAhwxL97D1QFPYimYUafkPXyWcPPUuuet1YZTpyf");
const POOL = new PublicKey("8UPUKWa8G8YvGzB9FL9aVessLUsWp626Ruh15rJmt4uY");
const COOKHOUSE = new PublicKey("C4yVWDrwXeEUapmw3BkvktHBxCSsM8MfJ3aPVuFonFi5");
const POSITION_B64 =
  "qryP5HpA99BvBeX9CiC5yV8Q08VYILNa05Jjku0ZuhdJ6rzpAOcj66f/wMCspp7ZsOOWvlFl8HpX5OMa/kgzltfWiO+mUetiR30dYpN0DAAAAAAAAAAAAIBm//9Aav//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const POOL_B64 =
  "P5XRDOGAYwljJNY0p1w1IRDIzUEIom5+tcAdYejz6Vgi+nyoNHL8aP1AAEAEiBPQBwAAAAAAAAAAAAAAAAAAAADeUqPiqcCnJQAAAAAAAAAAQGr//wAAAAAAAAAAAAAAAAAAAAAGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAWdzaJ6lmTkyv+t0Vs+TtCNDoPXUUlkjEe6L5MXGT/BcAAAAAAAAAAAAAAAAAAAAAKR1LHd2cszSZNFOvfHl6g/vaaPITGtRD8jsMKMB5kzutUYQ0+vDWxtx+AdX/PvdmLdZnE/GzU984KRoRqAQjbIAAAAAAAAAAAAAAAAAAAAAnCzhagAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8a9GTrurjdgYHI7+qAKN0PW57T30iaWf9OcV3PmgAecAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NFT_ACCOUNT = new PublicKey("8htC1PWPDdFSRu3EHz4C48U6gSyngacQUFbWvjkY4CgX");
const NFT_ACCOUNT_B64 =
  "p//AwKymntmw45a+UWXwelfk4xr+SDOW19aI76ZR62JzEiOzmG8JcWudmdDJR2KFQRdIOO6c+qhTW9zvMHCbQgEAAAAAAAAAAQAAAK7NUWdg78c9jjjq8nvMyrJ2J6FawBitbGqzAJy8IJE/AQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const acct = (b64: string, owner: PublicKey) => ({
  data: Buffer.from(b64, "base64"),
  owner,
  lamports: 0,
  executable: false,
  rentEpoch: 0,
});

const conn = new Connection("http://localhost:8899"); // never contacted: builders only

describe("Ratchet program binding", () => {
  it("pins the program id and the IDL address together", () => {
    expect(RATCHET_PROGRAM_ID.toBase58()).toBe("RTCHidURfYbbig1xAiXq39gyNYuBBLs3QQUL4mpqYRX");
    expect(PROGRAM_IDS.ratchet).toBe(RATCHET_PROGRAM_ID.toBase58());
  });

  it("derives the live order's PDA from its position (golden: seed string + program id)", () => {
    expect(rangeOrderPda(POSITION).toBase58()).toBe(ORDER_ADDRESS.toBase58());
    expect(positionPdaForMint(POSITION_MINT).toBase58()).toBe(POSITION.toBase58());
    expect(nativePayoutPda(ORDER_ADDRESS).toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from("native_payout"), ORDER_ADDRESS.toBuffer()],
        RATCHET_PROGRAM_ID,
      )[0].toBase58(),
    );
  });

  it("decodes the live RangeOrder (golden bytes)", () => {
    const data = Buffer.from(ORDER_B64, "base64");
    expect(data.length).toBe(173);
    expect([...data.subarray(0, 8)]).toEqual([...RANGE_ORDER_DISCRIMINATOR]);
    const o = decodeRangeOrder(data);
    expect(o.owner.toBase58()).toBe(OWNER.toBase58());
    expect(o.position.toBase58()).toBe(POSITION.toBase58());
    expect(o.positionMint.toBase58()).toBe(POSITION_MINT.toBase58());
    expect(o.whirlpool.toBase58()).toBe(POOL.toBase58());
    expect(o.direction).toBe("bToA");
    expect(o.minStep).toBe(1);
    expect(o.cranker?.toBase58()).toBe(RATCHET_KEEPER);
    expect(o.bump).toBe(254);
  });

  it("refuses to decode an account that is not a RangeOrder", () => {
    expect(() => decodeRangeOrder(Buffer.from(POOL_B64, "base64"))).toThrow(/not a Ratchet/);
  });

  it("filters program reads by discriminator, then owner at offset 8", () => {
    const [disc, owner] = rangeOrderFilters(OWNER);
    expect(disc).toMatchObject({ memcmp: { offset: 0 } });
    expect(owner).toMatchObject({ memcmp: { offset: 8, bytes: OWNER.toBase58() } });
    expect(rangeOrderFilters(null)).toHaveLength(1);
  });

  it("parses the live position and pool (golden bytes, as the vault records them)", () => {
    const pos = parsePosition(POSITION, acct(POSITION_B64, CLMM_PROGRAM_ID));
    expect(pos.whirlpool.toBase58()).toBe(POOL.toBase58());
    expect(pos.positionMint.toBase58()).toBe(POSITION_MINT.toBase58());
    expect(pos.liquidity.toString()).toBe("3505876075642183");
    expect([pos.tickLowerIndex, pos.tickUpperIndex]).toEqual([-39296, -38336]);

    const pool = parsePool(POOL, acct(POOL_B64, CLMM_PROGRAM_ID));
    expect(pool.tickSpacing).toBe(64);
    expect(pool.tickCurrentIndex).toBe(-38336); // parked on the upper edge: holds only COOKHOUSE
    expect(pool.sqrtPrice.toString()).toBe("2713349136398373598");
    expect(pool.tokenMintA.toBase58()).toBe(NATIVE_MINT.toBase58());
    expect(pool.tokenMintB.toBase58()).toBe(COOKHOUSE.toBase58());
    expect(pool.tokenVaultA.toBase58()).toBe("7xq4XoyrEziRHLY2Py3fpEB3Kmg2aCXBxdmrXJNTMxC3");
    expect(pool.tokenVaultB.toBase58()).toBe("DCcm4v8uBfyTpHbCCvBMmDsfmFpmop4eRdgrKpqCWBwP");
  });

  it("refuses a pool or position account owned by another program", () => {
    const other = Keypair.generate().publicKey;
    expect(() => parsePool(POOL, acct(POOL_B64, other))).toThrow(/no Cookiebox CLMM pool/);
    expect(() => parsePosition(POSITION, null)).toThrow(/no Cookiebox CLMM position/);
  });

  it("reads the NFT token account: holder, delegate (= the order), token program", () => {
    const nft = decodePositionNft(NFT_ACCOUNT, acct(NFT_ACCOUNT_B64, TOKEN_PROGRAM_ID));
    expect(nft.holder.toBase58()).toBe(OWNER.toBase58());
    expect(nft.delegate?.toBase58()).toBe(ORDER_ADDRESS.toBase58());
    expect(nft.tokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("sqrtAt agrees with the pool's sqrt price at the current tick", () => {
    // The pool sits exactly on tick -38336, so the two must match.
    expect(sqrtAt(-38336)).toBe(2713349136398373598n);
  });
});

describe("enable / disable instructions", () => {
  const program = ratchetProgram(conn);
  const owner = Keypair.generate().publicKey;
  const nft = Keypair.generate().publicKey;
  const base = {
    program,
    owner,
    whirlpool: POOL,
    position: POSITION,
    nft,
    nftTokenProgram: TOKEN_PROGRAM_ID,
    minStep: 1,
  };

  it("enable encodes disc + direction enum + min_step u16 + Option<cranker> (golden bytes)", async () => {
    const cranker = new PublicKey(RATCHET_KEEPER);
    const ix = await buildEnableIx({ ...base, direction: "bToA", cranker });
    expect(ix.programId.equals(RATCHET_PROGRAM_ID)).toBe(true);
    expect(ix.data.length).toBe(8 + 1 + 2 + 1 + 32);
    expect([...ix.data.subarray(0, 8)]).toEqual([159, 34, 127, 41, 193, 53, 124, 27]);
    expect(ix.data[8]).toBe(1); // Direction::BToA
    expect(ix.data.readUInt16LE(9)).toBe(1);
    expect(ix.data[11]).toBe(1); // Some
    expect(new PublicKey(ix.data.subarray(12, 44)).equals(cranker)).toBe(true);

    const aToB = await buildEnableIx({ ...base, direction: "aToB", minStep: 300, cranker: null });
    expect(aToB.data.length).toBe(8 + 1 + 2 + 1);
    expect(aToB.data[8]).toBe(0); // Direction::AToB
    expect(aToB.data.readUInt16LE(9)).toBe(300);
    expect(aToB.data[11]).toBe(0); // None

    // Accounts in the IDL's order; owner signs, the order PDA is derived from the position.
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      owner.toBase58(),
      POOL.toBase58(),
      POSITION.toBase58(),
      nft.toBase58(),
      ORDER_ADDRESS.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      "11111111111111111111111111111111",
    ]);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[4]).toMatchObject({ isSigner: false, isWritable: true });
  });

  it("disable is the bare discriminator; without the NFT the optional slots carry the program id", async () => {
    const withNft = await buildDisableIx({
      program,
      signer: owner,
      owner,
      position: POSITION,
      nft: { address: nft, tokenProgram: TOKEN_PROGRAM_ID },
    });
    expect([...withNft.data]).toEqual([185, 173, 187, 90, 216, 15, 238, 233]);
    expect(withNft.keys.map((k) => k.pubkey.toBase58())).toEqual([
      owner.toBase58(),
      owner.toBase58(),
      ORDER_ADDRESS.toBase58(),
      nft.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
    const without = await buildDisableIx({
      program,
      signer: owner,
      owner,
      position: POSITION,
      nft: null,
    });
    expect(without.keys.slice(3).map((k) => k.pubkey.toBase58())).toEqual([
      RATCHET_PROGRAM_ID.toBase58(),
      RATCHET_PROGRAM_ID.toBase58(),
    ]);
  });
});

describe("payout accounts", () => {
  const owner = Keypair.generate().publicKey;
  const order = Keypair.generate().publicKey;
  const token = Keypair.generate().publicKey;
  const programs = { tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID };

  it("wrapped COOK pays through the order's transient account, never the owner's wCOOK ATA", () => {
    const p = payoutAccounts({ order, owner, mintA: NATIVE_MINT, mintB: token, ...programs });
    expect(p.payoutA.equals(nativePayoutPda(order))).toBe(true);
    expect(p.payoutA.equals(getAssociatedTokenAddressSync(NATIVE_MINT, owner, true))).toBe(false);
    expect(p.payoutB.equals(getAssociatedTokenAddressSync(token, owner, true))).toBe(true);
    expect(p.ownerAtas.map((a) => a.address.toBase58())).toEqual([p.payoutB.toBase58()]);
    expect(p.ownerAtas[0]!.mint.equals(token)).toBe(true);
  });

  it("start creates no wCOOK account, and both accounts for a pool without COOK", () => {
    const ixs = buildPayoutAtaIxs({ owner, mintA: NATIVE_MINT, mintB: token, ...programs });
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.keys.some((k) => k.pubkey.equals(NATIVE_MINT))).toBe(false);
    expect(ixs[0]!.keys[0]!.pubkey.equals(owner)).toBe(true); // owner pays
    const other = Keypair.generate().publicKey;
    expect(buildPayoutAtaIxs({ owner, mintA: other, mintB: token, ...programs })).toHaveLength(2);
  });
});

describe("tick arrays", () => {
  it("the live range sits inside one array", () => {
    const arrays = rangeTickArrays(POOL, -39296, -38336, 64);
    expect(arrays.map((a) => a.startTick)).toEqual([-39424]);
    expect(arrays[0]!.address.equals(tickArrayFor(POOL, -39296, 64).address)).toBe(true);
    expect(arrays[0]!.address.equals(tickArrayFor(POOL, -38336, 64).address)).toBe(true);
    // Golden: ["tick_array", whirlpool, "-39424"] under the CLMM program.
    expect(arrays[0]!.address.toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from("tick_array"), POOL.toBuffer(), Buffer.from("-39424")],
        CLMM_PROGRAM_ID,
      )[0].toBase58(),
    );
  });

  it("lists every array a wide range spans, lowest first", () => {
    // 88 * 64 = 5632 ticks per array; [-6000, 6000] touches -11264, -5632, 0, 5632.
    expect(rangeTickArrays(POOL, -6000, 6000, 64).map((a) => a.startTick)).toEqual([
      -11264, -5632, 0, 5632,
    ]);
  });

  it("counts without deriving, and caps a full range on the narrow tiers", () => {
    for (const [lower, upper, spacing] of [
      [-39296, -38336, 64],
      [-6000, 6000, 64],
      [-443584, 443584, 64],
    ] as const) {
      expect(rangeTickArrayCount(lower, upper, spacing)).toBe(
        rangeTickArrays(POOL, lower, upper, spacing).length,
      );
    }
    expect(rangeTickArrayCount(-443584, 443584, 64)).toBe(158);
    expect(rangeTickArrayCount(-443584, 443584, 64)).toBeLessThanOrEqual(MAX_RANGE_TICK_ARRAYS);
    expect(rangeTickArrayCount(-443636, 443636, 2)).toBeGreaterThan(MAX_RANGE_TICK_ARRAYS);
  });

  it("reads missing arrays 100 keys at a time and keeps their order", async () => {
    const arrays = rangeTickArrays(POOL, -443584, 443584, 64);
    const exists = new Set(arrays.filter((_, i) => i % 2 === 0).map((a) => a.address.toBase58()));
    const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) =>
      keys.map((k) => (exists.has(k.toBase58()) ? { data: Buffer.alloc(0) } : null)),
    );
    const missing = await missingTickArrays(
      { getMultipleAccountsInfo } as unknown as Connection,
      arrays,
    );
    expect(getMultipleAccountsInfo.mock.calls.map(([keys]) => keys.length)).toEqual([100, 58]);
    expect(missing.map((m) => m.startTick)).toEqual(
      arrays.filter((_, i) => i % 2 === 1).map((a) => a.startTick),
    );
  });

  it("the enable instructions ride in the last transaction, after the inits", () => {
    const ix = (n: number) =>
      new TransactionInstruction({ programId: POOL, keys: [], data: Buffer.from([n]) });
    const inits = Array.from({ length: TICK_ARRAY_INITS_PER_TX + 1 }, (_, i) => ix(i));
    const enable = [ix(100), ix(101)];
    const txs = enableTransactions(inits, enable);
    expect(txs.map((t) => t.length)).toEqual([TICK_ARRAY_INITS_PER_TX, 3]);
    expect(txs[1]!.slice(1)).toEqual(enable);
    expect(enableTransactions([], enable)).toEqual([enable]);
  });

  it.each([
    ["classic", TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID],
    ["Token-2022", TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
    // The worst case: both token programs in the key list.
    ["mixed", TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
  ])(
    "a full batch of inits plus enable and both payout creates leaves wallets 128 bytes (%s)",
    async (_, programA, programB, nftProgram) => {
      const funder = Keypair.generate().publicKey;
      const arrays = rangeTickArrays(POOL, 0, 5632 * (TICK_ARRAY_INITS_PER_TX - 1), 64);
      expect(arrays).toHaveLength(TICK_ARRAY_INITS_PER_TX);
      const inits = buildTickArrayInitIxs(conn, { whirlpool: POOL, arrays, funder });
      expect(inits).toHaveLength(TICK_ARRAY_INITS_PER_TX);
      // The dynamic (idempotent) variant, funder pays: the CLMM's `initialize_dynamic_tick_array`.
      expect(inits[0]!.programId.equals(CLMM_PROGRAM_ID)).toBe(true);
      expect(inits[0]!.keys.some((k) => k.pubkey.equals(funder) && k.isSigner)).toBe(true);
      const other = Keypair.generate().publicKey;
      const enable = await buildEnableIx({
        program: ratchetProgram(conn),
        owner: funder,
        whirlpool: POOL,
        position: Keypair.generate().publicKey,
        nft: Keypair.generate().publicKey,
        nftTokenProgram: nftProgram,
        direction: "bToA",
        minStep: 1,
        cranker: Keypair.generate().publicKey,
      });
      const [batch] = enableTransactions(inits, [
        ...buildPayoutAtaIxs({
          owner: funder,
          mintA: other,
          mintB: COOKHOUSE,
          tokenProgramA: programA,
          tokenProgramB: programB,
        }),
        enable,
      ]);
      const tx = new Transaction().add(...batch!);
      tx.feePayer = funder;
      tx.recentBlockhash = PublicKey.default.toBase58();
      const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
      expect(size).toBeLessThanOrEqual(1232 - 128);
    },
  );
});
