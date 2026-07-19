import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { CookieMcpError, redact, toToolError } from "./errors";

describe("redact", () => {
  it("redacts solana-keygen JSON byte arrays", () => {
    const arr = "[" + Array.from({ length: 64 }, (_, i) => i % 256).join(",") + "]";
    expect(redact(`key=${arr} rest`)).toBe("key=[REDACTED_KEYPAIR] rest");
  });
  it("redacts long base58 secret-length runs", () => {
    const secret = "5".repeat(88);
    expect(redact(`secret ${secret} end`)).toContain("[REDACTED]");
  });
  it("leaves short base58 (pubkeys) alone", () => {
    const pk = "So11111111111111111111111111111111111111112";
    expect(redact(pk)).toBe(pk);
  });
});

describe("toToolError", () => {
  it("keeps error + hint from CookieMcpError", () => {
    expect(toToolError(new CookieMcpError("boom", "try again"))).toEqual({
      error: "boom",
      hint: "try again",
    });
  });
  it("wraps a plain Error", () => {
    expect(toToolError(new Error("nope"))).toEqual({ error: "nope" });
  });
  it("redacts secrets inside messages", () => {
    const secret = "K".repeat(90);
    const out = toToolError(new Error(`failed with ${secret}`));
    expect(out.error).not.toContain(secret);
    expect(out.error).toContain("[REDACTED]");
  });
});

// CP3 key-redaction guarantee: a real keypair's secret (either encoding) must never survive into a
// tool error, even if some upstream error message accidentally embedded it.
describe("real keypair secret never leaks through tool errors", () => {
  const kp = Keypair.generate();
  const base58Secret = bs58.encode(kp.secretKey);
  const jsonSecret = JSON.stringify([...kp.secretKey]);

  it("redacts the base58 secret", () => {
    const out = toToolError(new CookieMcpError(`boom near ${base58Secret}`));
    expect(out.error).not.toContain(base58Secret);
  });
  it("redacts the JSON byte-array secret", () => {
    const out = toToolError(new Error(`load failed: ${jsonSecret}`));
    expect(out.error).not.toContain(jsonSecret);
    expect(out.error).toContain("[REDACTED_KEYPAIR]");
  });
  it("keeps the public key visible (not a secret)", () => {
    const pk = kp.publicKey.toBase58();
    expect(redact(`wallet ${pk}`)).toContain(pk);
  });
});
