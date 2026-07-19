import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import {
  decodeSecret,
  loadKeypair,
  getWallet,
  ownPublicKey,
  requireWallet,
  assertWithinSpendCap,
  _resetWalletCache,
} from "./wallet";
import { CookieMcpError } from "./errors";

const kp = Keypair.generate();
const pk = kp.publicKey.toBase58();

describe("loadKeypair / decodeSecret", () => {
  it("loads a base58 secret", () => {
    expect(loadKeypair(bs58.encode(kp.secretKey)).publicKey.toBase58()).toBe(pk);
  });
  it("loads a solana-keygen JSON byte array", () => {
    expect(loadKeypair(JSON.stringify([...kp.secretKey])).publicKey.toBase58()).toBe(pk);
  });
  it("loads a { secretKey: [...] } object", () => {
    expect(loadKeypair(JSON.stringify({ secretKey: [...kp.secretKey] })).publicKey.toBase58()).toBe(
      pk,
    );
  });
  it("throws on empty / too-short secret", () => {
    expect(() => decodeSecret("")).toThrow();
    expect(() => decodeSecret("[1,2,3]")).toThrow(/>=64/);
  });
});

describe("getWallet read-only mode", () => {
  beforeEach(() => _resetWalletCache());
  afterEach(() => {
    delete process.env.COOKIE_PRIVATE_KEY;
    _resetWalletCache();
  });

  it("returns null when COOKIE_PRIVATE_KEY is unset (read-only)", () => {
    delete process.env.COOKIE_PRIVATE_KEY;
    expect(getWallet()).toBeNull();
    expect(ownPublicKey()).toBeNull();
    expect(() => requireWallet()).toThrow(CookieMcpError);
    expect(() => requireWallet()).toThrow(/no wallet configured/);
  });

  it("loads the wallet when the key is set", () => {
    process.env.COOKIE_PRIVATE_KEY = bs58.encode(kp.secretKey);
    expect(ownPublicKey()).toBe(pk);
    expect(requireWallet().keypair.publicKey.toBase58()).toBe(pk);
  });

  it("errors clearly (no secret leak) on an unparseable key", () => {
    process.env.COOKIE_PRIVATE_KEY = "not-a-valid-key!!!";
    expect(() => getWallet()).toThrow(/could not be parsed/);
  });
});

describe("assertWithinSpendCap", () => {
  it("passes when value is under the cap", () => {
    expect(assertWithinSpendCap(10, 1, 100)).toBeCloseTo(10);
    expect(assertWithinSpendCap(50, 0.5, 100)).toBeCloseTo(25);
  });
  it("throws when value exceeds the cap", () => {
    expect(() => assertWithinSpendCap(200, 1, 100)).toThrow(/spend cap|cap/);
    expect(() => assertWithinSpendCap(300, 0.5, 100)).toThrow(/cap/);
  });
  it("throws when the input can't be valued in COOK", () => {
    expect(() => assertWithinSpendCap(10, null, 100)).toThrow(/cannot value/);
    expect(() => assertWithinSpendCap(10, 0, 100)).toThrow(/cannot value/);
  });
  it("throws on non-positive amount", () => {
    expect(() => assertWithinSpendCap(0, 1, 100)).toThrow(/greater than 0/);
    expect(() => assertWithinSpendCap(-5, 1, 100)).toThrow(/greater than 0/);
  });
  it("skips the check when the cap is disabled (0)", () => {
    expect(assertWithinSpendCap(999999, null, 0)).toBeNaN();
  });
});
