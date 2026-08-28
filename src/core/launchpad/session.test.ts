import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  launchpadSessionToken,
  loginMessage,
  resetLaunchpadSession,
  signLoginMessage,
} from "./session";

const KP = Keypair.generate();
const WALLET = KP.publicKey.toBase58();

afterEach(() => {
  resetLaunchpadSession();
  vi.unstubAllGlobals();
});

/** Stub fetch for the two-call login (nonce → session), recording every request body. */
function stubLogin(opts: { token?: string; expiresAt?: number; failSession?: boolean } = {}) {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (String(url).endsWith("/session/nonce")) {
      return new Response(JSON.stringify({ success: true, nonce: "abc123", ttlSecs: 300 }));
    }
    if (opts.failSession) {
      return new Response(JSON.stringify({ success: false, error: "Invalid signature" }), {
        status: 401,
      });
    }
    return new Response(
      JSON.stringify({
        success: true,
        token: opts.token ?? "tok-1",
        wallet: WALLET,
        expiresAt: opts.expiresAt ?? Date.now() + 30 * 86400 * 1000,
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bodies, fetchMock };
}

describe("loginMessage", () => {
  // The server re-derives this string and verifies the signature over it, so any drift here reads as
  // a FORGED signature (401), not as a version mismatch. Pin the exact bytes, including line order.
  it("is the exact domain- and nonce-bound message the API verifies", () => {
    expect(loginMessage("WALLET", 1735689600, "NONCE")).toBe(
      "MOMO Login\ndomain: momoswap.fun\nnonce: NONCE\nwallet: WALLET\nts: 1735689600",
    );
  });
});

describe("signLoginMessage", () => {
  it("produces a base58 ed25519 signature the API's verifier accepts", () => {
    const msg = loginMessage(WALLET, 1735689600, "NONCE");
    const sig = bs58.decode(signLoginMessage(msg, KP));
    // Exactly what the backend does: 64 bytes, verified against the wallet pubkey over the raw UTF-8.
    expect(sig.length).toBe(64);
    expect(ed25519.verify(sig, new TextEncoder().encode(msg), KP.publicKey.toBytes())).toBe(true);
  });
});

describe("launchpadSessionToken", () => {
  it("mints a token by signing a server-issued nonce, and sends what the API expects", async () => {
    const { bodies } = stubLogin();
    expect(await launchpadSessionToken(KP)).toBe("tok-1");
    const body = bodies[0] as Record<string, unknown>;
    expect(body.wallet).toBe(WALLET);
    expect(body.nonce).toBe("abc123");
    expect(typeof body.ts).toBe("number");
    // A signature over the nonce we were actually given — not a stale or self-invented one.
    expect(
      ed25519.verify(
        bs58.decode(String(body.signature)),
        new TextEncoder().encode(loginMessage(WALLET, Number(body.ts), "abc123")),
        KP.publicKey.toBytes(),
      ),
    ).toBe(true);
  });

  it("reuses a live token instead of signing again", async () => {
    const { fetchMock } = stubLogin();
    await launchpadSessionToken(KP);
    await launchpadSessionToken(KP);
    expect(fetchMock).toHaveBeenCalledTimes(2); // nonce + session, once — not twice
  });

  it("re-logs in rather than handing back a token that is about to expire", async () => {
    const { fetchMock } = stubLogin({ expiresAt: Date.now() + 5_000 });
    await launchpadSessionToken(KP);
    await launchpadSessionToken(KP);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("re-logs in when the server sends no usable expiry, rather than caching it forever", async () => {
    const { fetchMock } = stubLogin({ expiresAt: NaN });
    await launchpadSessionToken(KP);
    await launchpadSessionToken(KP);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failed login", async () => {
    stubLogin({ failSession: true });
    await expect(launchpadSessionToken(KP)).rejects.toThrow(/Invalid signature/);
    const { fetchMock } = stubLogin();
    expect(await launchpadSessionToken(KP)).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("does not hand one wallet's token to another", async () => {
    stubLogin({ token: "tok-a" });
    await launchpadSessionToken(KP);
    stubLogin({ token: "tok-b" });
    expect(await launchpadSessionToken(Keypair.generate())).toBe("tok-b");
  });
});
