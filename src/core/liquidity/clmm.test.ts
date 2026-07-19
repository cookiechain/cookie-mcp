import { describe, it, expect } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  buildClmmClient,
  patchMetadataAuth,
  CLMM_PROGRAM_ID,
  WHIRLPOOL_TREASURY,
  ORCA_METADATA_UPDATE_AUTH,
  CLMM_FEE_TIER_TICK_SPACING,
  DEFAULT_CLMM_FEE_TIER_BPS,
} from "./clmm";

// Constructing a Connection/Program does no network I/O, so these run offline.
const conn = new Connection("http://127.0.0.1:8899", "confirmed");

describe("clmm client retarget", () => {
  it("builds a whirlpool client whose program id is Cookie's CLMM program", () => {
    const client = buildClmmClient(conn, Keypair.generate());
    expect(client.getContext().program.programId.equals(CLMM_PROGRAM_ID)).toBe(true);
  });

  it("CLMM program id is the Cookie deployment", () => {
    expect(CLMM_PROGRAM_ID.toBase58()).toBe("CLMMmWqTtyNSomqXP3kETJy2SGKPdr31USsm4GfbLyKs");
  });
});

describe("patchMetadataAuth", () => {
  function ix(keys: PublicKey[]): TransactionInstruction {
    return new TransactionInstruction({
      programId: CLMM_PROGRAM_ID,
      keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      data: Buffer.alloc(0),
    });
  }

  it("rewrites the Orca mainnet metadata-update-auth to the Cookie treasury", () => {
    const other = Keypair.generate().publicKey;
    const tx = new Transaction().add(ix([other, ORCA_METADATA_UPDATE_AUTH, other]));
    patchMetadataAuth(tx);
    const patched = tx.instructions[0]!.keys.map((k) => k.pubkey.toBase58());
    expect(patched).toEqual([other.toBase58(), WHIRLPOOL_TREASURY.toBase58(), other.toBase58()]);
  });

  it("leaves transactions without the Orca auth untouched", () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const tx = new Transaction().add(ix([a, b]));
    patchMetadataAuth(tx);
    expect(tx.instructions[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual([
      a.toBase58(),
      b.toBase58(),
    ]);
  });

  it("does not confuse the treasury with the Orca auth (no-op when already patched)", () => {
    const tx = new Transaction().add(ix([WHIRLPOOL_TREASURY]));
    patchMetadataAuth(tx);
    expect(tx.instructions[0]!.keys[0]!.pubkey.equals(WHIRLPOOL_TREASURY)).toBe(true);
  });
});

describe("fee tiers", () => {
  it("maps each supported display bps to its Cookie tick spacing", () => {
    expect(CLMM_FEE_TIER_TICK_SPACING).toEqual({ 25: 2, 30: 64, 100: 128, 200: 256, 400: 96 });
  });

  it("defaults to the 0.25% tier (tick spacing 2)", () => {
    expect(DEFAULT_CLMM_FEE_TIER_BPS).toBe(25);
    expect(CLMM_FEE_TIER_TICK_SPACING[DEFAULT_CLMM_FEE_TIER_BPS]).toBe(2);
  });
});
