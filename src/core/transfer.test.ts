import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { parsePubkey, isNativeTransfer, memoInstruction, MAX_MEMO_BYTES } from "./transfer";
import { COOK_MINT, MEMO_PROGRAM_ID } from "./config";
import { CookieMcpError } from "./errors";

describe("memoInstruction", () => {
  const signer = new PublicKey("B8AB9R9J98yggrwdnZhoHuGJBc8RzTpHsqDnRkTnMuV");

  it("targets the SPL Memo program with the signer as its only, signing, read-only key", () => {
    const ix = memoInstruction("cookiejar:1|INV-1|hello", signer);
    expect(ix.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(ix.keys).toEqual([{ pubkey: signer, isSigner: true, isWritable: false }]);
  });

  it("carries the memo as its UTF-8 bytes, unchanged", () => {
    const ix = memoInstruction("cookiejar:1|INV-1|héllo", signer);
    expect(Buffer.from(ix.data).toString("utf8")).toBe("cookiejar:1|INV-1|héllo");
    expect(ix.data.length).toBe(Buffer.byteLength("cookiejar:1|INV-1|héllo", "utf8"));
  });

  it("refuses an empty or whitespace-only memo", () => {
    for (const memo of ["", "   "]) {
      expect(() => memoInstruction(memo, signer)).toThrow(CookieMcpError);
      expect(() => memoInstruction(memo, signer)).toThrow(/empty/);
    }
  });

  it("refuses a memo over the byte limit, counting bytes not characters", () => {
    expect(() => memoInstruction("a".repeat(MAX_MEMO_BYTES), signer)).not.toThrow();
    expect(() => memoInstruction("a".repeat(MAX_MEMO_BYTES + 1), signer)).toThrow(/bytes/);
    // 283 two-byte characters = 566 bytes fits; one more does not.
    expect(() => memoInstruction("é".repeat(283), signer)).not.toThrow();
    expect(() => memoInstruction("é".repeat(284), signer)).toThrow(/bytes/);
  });
});

describe("isNativeTransfer", () => {
  it("is native when no mint is given (defaults to COOK)", () => {
    expect(isNativeTransfer(undefined)).toBe(true);
    expect(isNativeTransfer("")).toBe(true);
  });

  it("is native for the COOK mint explicitly", () => {
    expect(isNativeTransfer(COOK_MINT)).toBe(true);
  });

  it("is an SPL transfer for any other mint", () => {
    expect(isNativeTransfer("6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL")).toBe(false);
  });
});

describe("parsePubkey", () => {
  it("accepts a valid base58 pubkey", () => {
    expect(parsePubkey(COOK_MINT, "recipient").toBase58()).toBe(COOK_MINT);
  });

  it("throws a labeled, hinted CookieMcpError on a bad address", () => {
    try {
      parsePubkey("not-a-key", "recipient");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CookieMcpError);
      expect((e as CookieMcpError).message).toMatch(/invalid recipient address/i);
      expect((e as CookieMcpError).hint).toMatch(/base58/i);
    }
  });
});
