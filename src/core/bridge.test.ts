import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  encodeTransferRemoteIxData,
  recipientTo32,
  messageIdFromLogs,
  deriveNativeCollateralPda,
  deriveEscrowPda,
} from "./bridge";

// Devnet warp program ids from hyperlane-cookies (the only committed values); the golden PDAs below
// were derived from them with the reference seed layout, so they guard the seed strings from drift.
const COOKIE_WARP = new PublicKey("5bFnGxeHSoe226K7zik97oYZKdCqL71WY1tijq63tNqS");
const SOLANA_WARP = new PublicKey("q3JZjQ89xzrFWsoo3x17zG44mRcLuPpZhxwFBpJUEDw");

describe("encodeTransferRemoteIxData", () => {
  const recipient = new PublicKey("So11111111111111111111111111111111111111112");

  it("lays out disc(8) + instruction(1) + domain u32 LE(4) + recipient(32) + amount u256 LE(32)", () => {
    const domain = 1399811149;
    const amount = 5_000_000_000n; // 5 COOK at 9 decimals
    const data = encodeTransferRemoteIxData(domain, recipient.toBytes(), amount);

    expect(data.length).toBe(77);
    // 8-byte discriminator, all ones
    expect([...data.subarray(0, 8)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // instruction tag = 1
    expect(data.readUInt8(8)).toBe(1);
    // destination domain, little-endian u32
    expect(data.readUInt32LE(9)).toBe(domain);
    // recipient, 32 bytes
    expect(Buffer.from(data.subarray(13, 45))).toEqual(Buffer.from(recipient.toBytes()));
    // amount, little-endian u256 — decode back
    let decoded = 0n;
    for (let i = 31; i >= 0; i--) decoded = (decoded << 8n) | BigInt(data[45 + i]);
    expect(decoded).toBe(amount);
  });

  it("round-trips large amounts near the u256 ceiling and rejects overflow", () => {
    const big = (1n << 200n) + 123n;
    const data = encodeTransferRemoteIxData(1, new Uint8Array(32), big);
    let decoded = 0n;
    for (let i = 31; i >= 0; i--) decoded = (decoded << 8n) | BigInt(data[45 + i]);
    expect(decoded).toBe(big);
    expect(() => encodeTransferRemoteIxData(1, new Uint8Array(32), 1n << 256n)).toThrow();
  });

  it("rejects a recipient that is not 32 bytes", () => {
    expect(() => encodeTransferRemoteIxData(1, new Uint8Array(31), 1n)).toThrow();
  });
});

describe("recipientTo32", () => {
  it("accepts a base58 pubkey", () => {
    const pk = new PublicKey("So11111111111111111111111111111111111111112");
    expect(Buffer.from(recipientTo32(pk.toBase58()))).toEqual(Buffer.from(pk.toBytes()));
  });
  it("accepts a 0x-hex 32-byte address", () => {
    const hex = "0x" + "ab".repeat(32);
    const out = recipientTo32(hex);
    expect(out.length).toBe(32);
    expect(out[0]).toBe(0xab);
  });
  it("rejects a hex address of the wrong length", () => {
    expect(() => recipientTo32("0x" + "ab".repeat(31))).toThrow();
  });
});

describe("PDA derivation (seed-string guards)", () => {
  it("derives the native collateral PDA from the reference seeds", () => {
    expect(deriveNativeCollateralPda(COOKIE_WARP).toBase58()).toBe(
      "7QEBtfrq8FCgUCiMS9oVHaRJCqaCRtur9aQW5tq9kdPF",
    );
  });
  it("derives the escrow PDA from the reference seeds", () => {
    expect(deriveEscrowPda(SOLANA_WARP).toBase58()).toBe(
      "BEsX7NyLLbCX5b5i4L2TPZ3SiKrWAMzAr7ybA6DM9DUM",
    );
  });

  // Mainnet warp program ids, cross-checked against the collateral accounts published in
  // hyperlane-cookies/defillama/README.md — an independent on-chain source of truth.
  it("reproduces the live mainnet collateral accounts (DefiLlama listing)", () => {
    const cookieMainnetWarp = new PublicKey("Aa9wq46NB7qkg1amnBuMRsV1DunmkPHuoRLWZgWiBKdn");
    const solanaMainnetWarp = new PublicKey("B1C91jLcqXYYz57bBWR8dSEjBrJDhWSeNokZ5SDEopu3");
    expect(deriveNativeCollateralPda(cookieMainnetWarp).toBase58()).toBe(
      "CL2JoQ5jdTpRNKshWhaTihuooT4qrKdLUiPsqKj3yAKz",
    );
    expect(deriveEscrowPda(solanaMainnetWarp).toBase58()).toBe(
      "88q7zoKctwAQRsoTxkMJy95sNE3tntuyEhSrhvR1eZwq",
    );
  });
});

describe("messageIdFromLogs", () => {
  it("prefers the 'ID 0x…' form and lowercases it", () => {
    const id = "0x" + "AB".repeat(32);
    expect(messageIdFromLogs([`Dispatched message ID ${id}`])).toBe(id.toLowerCase());
  });
  it("falls back to any 0x…64 hex match", () => {
    const id = "0x" + "cd".repeat(32);
    expect(messageIdFromLogs([`some log ${id} trailing`])).toBe(id);
  });
  it("returns null when no id is present", () => {
    expect(messageIdFromLogs(["no id here"])).toBeNull();
    expect(messageIdFromLogs(null)).toBeNull();
  });
});
