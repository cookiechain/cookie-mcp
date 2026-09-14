// Wallet resolution + read-only mode.
//
// Two signer modes (`COOKIE_SIGNER`):
//   local    (default) — the key is read from COOKIE_PRIVATE_KEY and the process signs. When the key
//                        is unset the server is read-only (money tools error, read tools work).
//   external           — the process holds NO key. The wallet's public key comes from the request
//                        (`x-cookie-wallet` header over HTTP) or COOKIE_WALLET_ADDRESS; money tools
//                        run every check and stop at the signing step with `needs_signature`.
// The secret is never logged or echoed in either mode.
import fs from "node:fs";
import path from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { COOKIE_RPC_URL } from "./config";
import { requestContext } from "./context";
import { CookieMcpError } from "./errors";
import { ExternalSigner, LocalKeypairSigner, type TxSigner } from "./signer";

// Accepts a keygen JSON byte array, a { secretKey: [...] } object, or a base58 secret.
export function decodeSecret(raw: string): Uint8Array {
  const s = raw.trim();
  if (!s) throw new Error("wallet secret is empty");
  if (s.startsWith("[") || s.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw new Error("secret looks like JSON but failed to parse");
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed as { secretKey?: number[] }).secretKey;
    if (!Array.isArray(arr) || arr.length < 64) {
      throw new Error("keypair JSON must be [..] or { secretKey: [..] } of >=64 bytes");
    }
    return Uint8Array.from(arr);
  }
  return bs58.decode(s);
}

// Accepts a path to a keypair file, inline JSON, or an inline base58 secret.
export function loadKeypair(input: string): Keypair {
  const s = input.trim();
  let raw = s;
  if (!s.startsWith("[") && !s.startsWith("{")) {
    const abs = s.startsWith("~")
      ? path.join(process.env.HOME ?? "", s.slice(1))
      : path.isAbsolute(s)
        ? s
        : path.resolve(process.cwd(), s);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) raw = fs.readFileSync(abs, "utf8");
    } catch {
      /* not a readable file → treat `s` as an inline secret */
    }
  }
  return Keypair.fromSecretKey(decodeSecret(raw));
}

export type SignerMode = "local" | "external";

/** `COOKIE_SIGNER`: "external" for wallet-signed (hosted) mode; anything else is local. */
export function signerMode(): SignerMode {
  return process.env.COOKIE_SIGNER?.trim().toLowerCase() === "external" ? "external" : "local";
}

let _local: LocalKeypairSigner | null | undefined;

function localSigner(): LocalKeypairSigner | null {
  if (_local !== undefined) return _local;
  const secret = process.env.COOKIE_PRIVATE_KEY?.trim();
  if (!secret) {
    _local = null;
    return null;
  }
  try {
    _local = new LocalKeypairSigner(loadKeypair(secret));
  } catch {
    // Deliberately omit the underlying error — it could echo secret material.
    throw new CookieMcpError(
      "COOKIE_PRIVATE_KEY is set but could not be parsed",
      "provide a base58 secret, a solana-keygen JSON byte array, or a path to a keypair file",
    );
  }
  return _local;
}

/** The wallet an external signer acts for: the request's, else the process default. */
function externalWalletAddress(): string | null {
  const fromRequest = requestContext()?.wallet?.trim();
  const addr = fromRequest || process.env.COOKIE_WALLET_ADDRESS?.trim() || "";
  return addr || null;
}

function externalSigner(): ExternalSigner | null {
  const addr = externalWalletAddress();
  if (!addr) return null;
  let pk: PublicKey;
  try {
    pk = new PublicKey(addr);
  } catch {
    throw new CookieMcpError(
      "the wallet address for external signing is not a valid public key",
      "pass a base58 Solana public key in the x-cookie-wallet header (HTTP) or COOKIE_WALLET_ADDRESS",
    );
  }
  return new ExternalSigner(pk, requestContext()?.providedSignatures ?? []);
}

/** The signer for this request, or null in read-only mode. */
export function getSigner(): TxSigner | null {
  return signerMode() === "external" ? externalSigner() : localSigner();
}

export function requireSigner(): TxSigner {
  const s = getSigner();
  if (s) return s;
  if (signerMode() === "external") {
    throw new CookieMcpError(
      "no wallet address for this request — this tool needs to know which wallet it acts for",
      "external signer mode: send the wallet's public key in the x-cookie-wallet header (HTTP), or " +
        "set COOKIE_WALLET_ADDRESS for a single-wallet setup",
    );
  }
  throw new CookieMcpError(
    "no wallet configured — this tool needs a key",
    "set COOKIE_PRIVATE_KEY (base58 / keygen JSON / path) to enable trade, transfer, and own-wallet reads",
  );
}

export function ownPublicKey(): string | null {
  return getSigner()?.publicKey.toBase58() ?? null;
}

/**
 * Who is this server, right now. Deliberately makes NO RPC call, so it still answers when the chain
 * or the RPC host is down — and it reports the key the *running process* booted with, which is the
 * only thing that matters and is not always what `.env` or a config file on disk now says.
 */
export function walletInfo(): {
  wallet: string | null;
  readOnly: boolean;
  signer: SignerMode;
  rpcUrl: string;
} {
  const wallet = ownPublicKey();
  return { wallet, readOnly: wallet === null, signer: signerMode(), rpcUrl: COOKIE_RPC_URL };
}

export function _resetWalletCache(): void {
  _local = undefined;
}
