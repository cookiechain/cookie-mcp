import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";

import { base58Encode, isGrindableSuffix, grindVanityMint } from "./vanity";

describe("base58Encode", () => {
  it("matches PublicKey.toBase58 for random keys", () => {
    for (let i = 0; i < 20; i++) {
      const pk = Keypair.generate().publicKey;
      expect(base58Encode(pk.toBytes())).toBe(pk.toBase58());
    }
  });
});

describe("isGrindableSuffix", () => {
  it("accepts base58 suffixes and rejects non-base58", () => {
    expect(isGrindableSuffix("box")).toBe(true);
    expect(isGrindableSuffix("0")).toBe(false); // 0 not in base58
    expect(isGrindableSuffix("l")).toBe(false); // l not in base58
    expect(isGrindableSuffix("")).toBe(false);
  });
});

describe("grindVanityMint", () => {
  it("finds an address ending in a 1-char suffix and reconstructs a usable keypair", () => {
    const r = grindVanityMint("a", 200_000);
    expect(r.vanity).toBe(true);
    expect(r.address.endsWith("a")).toBe(true);
    // the reconstructed keypair's public key equals the ground address
    expect(r.keypair.publicKey.toBase58()).toBe(r.address);
  });
  it("falls back to a random mint for a non-grindable suffix", () => {
    const r = grindVanityMint("0", 10);
    expect(r.vanity).toBe(false);
    expect(r.keypair.publicKey.toBase58()).toBe(r.address);
  });
});
