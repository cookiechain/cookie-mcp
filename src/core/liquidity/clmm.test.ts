import { TransactionBuilder } from "@orca-so/common-sdk";
import {
  ExtensionType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
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
  clmmLockConfigAddress,
  patchMetadataAuth,
  CLMM_PROGRAM_ID,
  WHIRLPOOL_TREASURY,
  ORCA_METADATA_UPDATE_AUTH,
  CLMM_FEE_TIER_TICK_SPACING,
  DEFAULT_CLMM_FEE_TIER_BPS,
  clmmBadgeReasons,
  clmmTokenBadgeAddress,
  splitOpenPositionBuilder,
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

describe("clmmLockConfigAddress", () => {
  // Pinned against a real Cookie Chain position + the PDA the program derived for it, so a wrong
  // seed or a wrong program id fails here rather than at lock time.
  it("derives the `[lock_config, position]` PDA the program expects", () => {
    const position = new PublicKey("7yjp7Ar6WZzmyvoVKGvTUxyd1hpNzLxRdqzqnMtmacNF");
    expect(clmmLockConfigAddress(position).toBase58()).toBe(
      "FAZmwBxhNzcmNft81SfJQ1DaW7quYicA14tiffHzydHn",
    );
  });

  it("derives a distinct PDA per position", () => {
    const a = clmmLockConfigAddress(Keypair.generate().publicKey);
    const b = clmmLockConfigAddress(Keypair.generate().publicKey);
    expect(a.equals(b)).toBe(false);
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

function token2022Mint(exts: { type: ExtensionType; data: Buffer }[], freeze = false): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  if (freeze) {
    base.writeUInt32LE(1, 46); // COption<Pubkey> freeze_authority tag
    Keypair.generate().publicKey.toBuffer().copy(base, 50);
  }
  base.writeUInt8(1, 45); // is_initialized
  const parts = [base, Buffer.alloc(165 - MINT_SIZE), Buffer.from([1])]; // AccountType::Mint
  for (const e of exts) {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(e.type, 0);
    head.writeUInt16LE(e.data.length, 2);
    parts.push(head, e.data);
  }
  return Buffer.concat(parts);
}

describe("clmmBadgeReasons", () => {
  const mint = Keypair.generate().publicKey;
  it("SPL mints and plain Token-2022 mints need no badge", () => {
    expect(
      clmmBadgeReasons(mint, { data: Buffer.alloc(MINT_SIZE), owner: TOKEN_PROGRAM_ID }),
    ).toEqual([]);
    expect(
      clmmBadgeReasons(mint, {
        data: token2022Mint([{ type: ExtensionType.MetadataPointer, data: Buffer.alloc(64) }]),
        owner: TOKEN_2022_PROGRAM_ID,
      }),
    ).toEqual([]);
  });
  it("names every gated extension and a freeze authority", () => {
    const data = token2022Mint(
      [
        { type: ExtensionType.TransferHook, data: Buffer.alloc(64) },
        { type: ExtensionType.PermanentDelegate, data: Buffer.alloc(32) },
      ],
      true,
    );
    expect(clmmBadgeReasons(mint, { data, owner: TOKEN_2022_PROGRAM_ID })).toEqual([
      "transfer hook",
      "permanent delegate",
      "freeze authority",
    ]);
  });
});

describe("clmmTokenBadgeAddress", () => {
  it("derives the badge issued on Cookie Chain for the HOOKIE test mint", () => {
    expect(
      clmmTokenBadgeAddress(
        new PublicKey("BgyR7wmqEPBUAZKP3egazgW22FPjjdMgkBWN6RPWtZ6g"),
      ).toBase58(),
    ).toBe("H2LgkVkz3UnnmF7NnWgkCB9DRmVZgyQQXQ9KpoCw9CeR");
  });
});

describe("splitOpenPositionBuilder", () => {
  const ix = (n: number) =>
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: Array.from({ length: n }, () => ({
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: false,
      })),
      data: Buffer.alloc(1),
    });
  const entry = (i: TransactionInstruction) => ({
    instructions: [i],
    cleanupInstructions: [] as TransactionInstruction[],
    signers: [],
  });
  const wallet = { publicKey: Keypair.generate().publicKey } as never;
  it("keeps a single-instruction builder whole", () => {
    const b = new TransactionBuilder({} as never, wallet).addInstruction(entry(ix(3)));
    expect(splitOpenPositionBuilder(b)).toHaveLength(1);
  });
  it("puts the open ix and the position-mint signer first, everything else second", () => {
    const mint = Keypair.generate();
    const open = ix(12);
    const wrap = ix(4);
    const deposit = ix(18);
    const b = new TransactionBuilder({} as never, wallet)
      .addInstruction(entry(open))
      .addInstruction(entry(wrap))
      .addInstruction(entry(deposit))
      .addSigner(mint);
    const [first, second] = splitOpenPositionBuilder(b) as [TransactionBuilder, TransactionBuilder];
    const internals = (x: TransactionBuilder) =>
      x as unknown as {
        instructions: { instructions: TransactionInstruction[] }[];
        signers: Keypair[];
      };
    expect(internals(first).instructions.map((e) => e.instructions[0])).toEqual([open]);
    expect(internals(first).signers.map((s) => s.publicKey.toBase58())).toEqual([
      mint.publicKey.toBase58(),
    ]);
    expect(internals(second).instructions.map((e) => e.instructions[0])).toEqual([wrap, deposit]);
    expect(internals(second).signers).toHaveLength(0);
  });
});
