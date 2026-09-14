import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import {
  decodeSecret,
  loadKeypair,
  getSigner,
  ownPublicKey,
  requireSigner,
  signerMode,
  walletInfo,
  _resetWalletCache,
} from "./wallet";
import { COOKIE_RPC_URL } from "./config";
import { runWithRequestContext } from "./context";
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

describe("getSigner — local mode", () => {
  beforeEach(() => _resetWalletCache());
  afterEach(() => {
    delete process.env.COOKIE_PRIVATE_KEY;
    delete process.env.COOKIE_SIGNER;
    _resetWalletCache();
  });

  it("returns null when COOKIE_PRIVATE_KEY is unset (read-only)", () => {
    delete process.env.COOKIE_PRIVATE_KEY;
    expect(getSigner()).toBeNull();
    expect(ownPublicKey()).toBeNull();
    expect(() => requireSigner()).toThrow(CookieMcpError);
    expect(() => requireSigner()).toThrow(/no wallet configured/);
  });

  it("loads a local keypair signer when the key is set", () => {
    process.env.COOKIE_PRIVATE_KEY = bs58.encode(kp.secretKey);
    expect(signerMode()).toBe("local");
    expect(ownPublicKey()).toBe(pk);
    const s = requireSigner();
    expect(s.kind).toBe("local");
    expect(s.publicKey.toBase58()).toBe(pk);
  });

  it("errors clearly (no secret leak) on an unparseable key", () => {
    process.env.COOKIE_PRIVATE_KEY = "not-a-valid-key!!!";
    expect(() => getSigner()).toThrow(/could not be parsed/);
  });
});

describe("getSigner — external mode", () => {
  beforeEach(() => {
    _resetWalletCache();
    process.env.COOKIE_SIGNER = "external";
  });
  afterEach(() => {
    delete process.env.COOKIE_PRIVATE_KEY;
    delete process.env.COOKIE_SIGNER;
    delete process.env.COOKIE_WALLET_ADDRESS;
    _resetWalletCache();
  });

  it("ignores COOKIE_PRIVATE_KEY and is read-only without a wallet address", () => {
    process.env.COOKIE_PRIVATE_KEY = bs58.encode(kp.secretKey);
    expect(signerMode()).toBe("external");
    expect(getSigner()).toBeNull();
    expect(() => requireSigner()).toThrow(/no wallet address for this request/);
  });

  it("uses COOKIE_WALLET_ADDRESS as the single-wallet default", () => {
    process.env.COOKIE_WALLET_ADDRESS = pk;
    const s = requireSigner();
    expect(s.kind).toBe("external");
    expect(s.publicKey.toBase58()).toBe(pk);
    expect(walletInfo()).toEqual({
      wallet: pk,
      readOnly: false,
      signer: "external",
      rpcUrl: COOKIE_RPC_URL,
    });
  });

  it("prefers the request's wallet over the env default", async () => {
    process.env.COOKIE_WALLET_ADDRESS = pk;
    const other = Keypair.generate().publicKey.toBase58();
    await runWithRequestContext({ wallet: other }, async () => {
      expect(ownPublicKey()).toBe(other);
    });
    expect(ownPublicKey()).toBe(pk);
  });

  it("rejects a malformed wallet address", () => {
    process.env.COOKIE_WALLET_ADDRESS = "not-a-pubkey";
    expect(() => requireSigner()).toThrow(/not a valid public key/);
  });
});

describe("walletInfo", () => {
  beforeEach(() => _resetWalletCache());
  afterEach(() => {
    delete process.env.COOKIE_PRIVATE_KEY;
    _resetWalletCache();
  });

  it("reports the configured wallet and the RPC, and never the secret", () => {
    const secret = bs58.encode(kp.secretKey);
    process.env.COOKIE_PRIVATE_KEY = secret;
    const info = walletInfo();
    expect(info).toEqual({ wallet: pk, readOnly: false, signer: "local", rpcUrl: COOKIE_RPC_URL });
    expect(JSON.stringify(info)).not.toContain(secret);
  });

  it("reports read-only mode with no key", () => {
    delete process.env.COOKIE_PRIVATE_KEY;
    expect(walletInfo()).toEqual({
      wallet: null,
      readOnly: true,
      signer: "local",
      rpcUrl: COOKIE_RPC_URL,
    });
  });

  it("surfaces an unparseable key as an error rather than a silent read-only", () => {
    process.env.COOKIE_PRIVATE_KEY = "not-a-valid-key!!!";
    expect(() => walletInfo()).toThrow(CookieMcpError);
  });
});
