import { describe, it, expect } from "vitest";

import { parsePubkey, isNativeTransfer } from "./transfer";
import { COOK_MINT } from "./config";
import { CookieMcpError } from "./errors";

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
