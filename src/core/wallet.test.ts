import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import {
  decodeSecret,
  loadKeypair,
  getWallet,
  ownPublicKey,
  requireWallet,
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
