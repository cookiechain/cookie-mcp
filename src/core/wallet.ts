// Wallet loading + read-only mode. The key is read only from COOKIE_PRIVATE_KEY; when unset the
// server is read-only (money tools error, read tools work). The secret is never logged or echoed.
import fs from "node:fs";
import path from "node:path";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { CookieMcpError } from "./errors";
import { MAX_TRADE_COOK } from "./config";

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

let _loaded: { keypair: Keypair } | null | undefined;

export function getWallet(): { keypair: Keypair } | null {
  if (_loaded !== undefined) return _loaded;
  const secret = process.env.COOKIE_PRIVATE_KEY?.trim();
  if (!secret) {
    _loaded = null;
    return null;
  }
  try {
    _loaded = { keypair: loadKeypair(secret) };
  } catch {
    // Deliberately omit the underlying error — it could echo secret material.
    throw new CookieMcpError(
      "COOKIE_PRIVATE_KEY is set but could not be parsed",
      "provide a base58 secret, a solana-keygen JSON byte array, or a path to a keypair file",
    );
  }
  return _loaded;
}

export function requireWallet(): { keypair: Keypair } {
  const w = getWallet();
  if (!w) {
    throw new CookieMcpError(
      "no wallet configured — this tool needs a key",
      "set COOKIE_PRIVATE_KEY (base58 / keygen JSON / path) to enable trade, transfer, and own-wallet reads",
    );
  }
  return w;
}

export function ownPublicKey(): string | null {
  return getWallet()?.keypair.publicKey.toBase58() ?? null;
}

export function _resetWalletCache(): void {
  _loaded = undefined;
}

// Value a money-moving input in COOK and assert it's within the cap. priceCook is the input's
// COOK-denominated price (1 for COOK). Throws if unvaluable or over cap; cap 0 disables the check.
export function assertWithinSpendCap(
  amountUi: number,
  priceCook: number | null,
  cap: number = MAX_TRADE_COOK,
): number {
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive input amount");
  }
  if (cap <= 0) return NaN;
  if (priceCook == null || !Number.isFinite(priceCook) || priceCook <= 0) {
    throw new CookieMcpError(
      "cannot value the input in COOK to enforce the spend cap",
      "the input token has no known COOK price; trade a token with a price, or set COOKIE_MAX_TRADE_COOK=0 to disable the cap",
    );
  }
  const valueCook = amountUi * priceCook;
  if (valueCook > cap) {
    throw new CookieMcpError(
      `input is worth ~${valueCook.toFixed(4)} COOK, over the ${cap} COOK per-trade cap`,
      `lower the amount, or raise COOKIE_MAX_TRADE_COOK (currently ${cap})`,
    );
  }
  return valueCook;
}
