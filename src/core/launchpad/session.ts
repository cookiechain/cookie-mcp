// Launchpad session tokens — the wallet-signature login the launch path now requires.
//
// `POST /v1/launchpad/tx/create-pool` is session-gated (401 `{"error":"session"}` without one) and
// additionally checks `creator === session wallet`, so a launch cannot be built anonymously any more.
// Every other endpoint MCP uses (buy/sell/claim/creator-fees builds, all reads, the image and metadata
// pins) is still public — do NOT attach a session to those, it buys nothing and spends a signature.
//
// The signature is over a message, not a transaction: nothing is submitted to the chain, no fee is
// paid, and the token only proves the wallet consented. With a local signer the whole exchange is
// headless; with an external signer the first call stops with the exact message to sign, and the
// second call (carrying `loginSignature`) completes the login — see `launchpadSessionToken`.
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

import { requestContext } from "../context";
import { LocalKeypairSigner, type TxSigner } from "../signer";
import { createSession, fetchLoginNonce } from "./api";

/**
 * The domain the login message is bound to. It must match the backend's `LOGIN_DOMAIN` **byte for
 * byte** — the server re-derives the string and verifies the signature over it, so a mismatch reads
 * as a forged signature (401), not as a protocol version error. Pinned by a test for that reason.
 */
const LOGIN_DOMAIN = "momoswap.fun";

/** Re-login this many seconds before the token actually expires, so a slow launch can't straddle it. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * The V3 login message: domain- and nonce-bound. The nonce is server-issued and single-use, so a
 * captured signature cannot be replayed even inside the timestamp window. Line order is part of the
 * contract.
 */
export function loginMessage(wallet: string, ts: number, nonce: string): string {
  return `MOMO Login\ndomain: ${LOGIN_DOMAIN}\nnonce: ${nonce}\nwallet: ${wallet}\nts: ${ts}`;
}

/**
 * Sign a login message with the wallet key. `Keypair.secretKey` is the 64-byte expanded form
 * (seed ‖ pubkey) and ed25519 signing takes the 32-byte seed, hence the slice. Returns base58 — the
 * encoding the API verifies with `bs58.decode`.
 */
export function signLoginMessage(message: string, keypair: Keypair): string {
  const sig = ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.subarray(0, 32));
  return bs58.encode(sig);
}

/** Inverse of `loginMessage`; null when the text is not one of ours. */
export function parseLoginMessage(
  message: string,
): { wallet: string; ts: number; nonce: string } | null {
  const m = /^MOMO Login\ndomain: ([^\n]+)\nnonce: ([^\n]+)\nwallet: ([^\n]+)\nts: (\d+)$/.exec(
    message,
  );
  if (!m || m[1] !== LOGIN_DOMAIN) return null;
  return { nonce: m[2]!, wallet: m[3]!, ts: Number(m[4]) };
}

// Keyed by wallet: a hosted server logs many wallets in, and one wallet's token must never be handed
// to another's launch.
const cached = new Map<string, { token: string; expiresAt: number }>();

/** Drop the cached tokens — after a 401, and between tests. */
export function resetLaunchpadSession(wallet?: string): void {
  if (wallet) cached.delete(wallet);
  else cached.clear();
}

/**
 * A session token for this wallet, minting one only when there isn't a usable one already. The token
 * lives 30 days server-side, so in practice one login covers a whole MCP process.
 *
 * External signer: if the request carries a signature over one of OUR login messages for this wallet
 * (`loginSignature`), the login completes with the ts/nonce embedded in that message — the nonce came
 * from us on the previous call and is still unused server-side. Otherwise a fresh nonce is fetched
 * and the signer stops the flow with the exact message to sign.
 */
export async function launchpadSessionToken(signerOrKeypair: TxSigner | Keypair): Promise<string> {
  const signer =
    signerOrKeypair instanceof Keypair ? new LocalKeypairSigner(signerOrKeypair) : signerOrKeypair;
  const wallet = signer.publicKey.toBase58();
  const hit = cached.get(wallet);
  if (hit && hit.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return hit.token;
  }

  let ts: number;
  let nonce: string;
  let message: string;
  const provided = (requestContext()?.providedSignatures ?? []).find(
    (p) => parseLoginMessage(p.message)?.wallet === wallet,
  );
  if (signer.kind === "external" && provided) {
    ({ ts, nonce } = parseLoginMessage(provided.message)!);
    message = provided.message;
  } else {
    ({ nonce } = await fetchLoginNonce());
    ts = Math.floor(Date.now() / 1000);
    message = loginMessage(wallet, ts, nonce);
  }
  const signature = await signer.signMessage(message, "launchpad login");
  const session = await createSession({ wallet, ts, nonce, signature });
  cached.set(wallet, {
    token: session.token,
    // `expiresAt` is epoch ms from the server. Treat a missing/garbage value as "expires now" rather
    // than trusting it: the cost of re-logging in is one signature, the cost of a stale token is a
    // failed launch.
    expiresAt: Number.isFinite(session.expiresAt) ? session.expiresAt : 0,
  });
  return session.token;
}
