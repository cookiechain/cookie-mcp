// Pure `.cook` name rules and registration pricing. No network, no web3 — everything here is a
// function of the input string plus the on-chain `Config` account, so it is all unit-testable.
//
// The rules mirror the CookOven dApp (book.cookoven.xyz) and were verified against the deployed
// program by simulation: an empty name, `Bad_Name!` and uppercase `ABC` all revert with
// `InvalidName` (6002), while a 32-character all-lowercase name gets past validation.
import { COOK_TLD } from "../config";

/** Longest name the program can address: a PDA seed is capped at 32 bytes. */
export const MAX_NAME_LENGTH = 32;

/** Names of this length or shorter pay the "short" tier. Matches the dApp's 1–3 / 4+ split. */
export const SHORT_NAME_MAX_LENGTH = 3;

export interface DomainsConfig {
  admin: string;
  feeReceiver: string;
  /** USD price of ONE COOK, in micro-dollars (100 = $0.0001). */
  cookUsdPriceMicro: bigint;
  shortNameUsdCents: bigint;
  longNameUsdCents: bigint;
  /** Decimals of the native token the fee is paid in — 9 for COOK. */
  nativeDecimals: number;
}

/**
 * Strip the presentation suffix and case: `"Bot.cook"` → `"bot"`. The result is what goes into the
 * PDA seed and the instruction argument. A bare label passes through unchanged.
 */
export function normalizeName(input: string): string {
  const s = input.trim().toLowerCase();
  return s.endsWith(COOK_TLD) ? s.slice(0, -COOK_TLD.length) : s;
}

/** Presentation form: `"bot"` → `"bot.cook"`. */
export function displayName(label: string): string {
  return `${label}${COOK_TLD}`;
}

/**
 * Validate a normalized label. Returns the reason it is invalid, or null when it is fine. The
 * program is the final arbiter (it answers `InvalidName` for everything at once); we check locally
 * so the agent gets a specific reason before spending a round trip — and, for names over 32 bytes,
 * because `findProgramAddressSync` would throw "Max seed length exceeded" instead.
 */
export function nameError(label: string): string | null {
  if (label.length === 0) return "the name is empty";
  if (Buffer.byteLength(label, "utf8") > MAX_NAME_LENGTH) {
    return `the name is longer than ${MAX_NAME_LENGTH} characters`;
  }
  if (!/^[a-z0-9-]+$/.test(label)) return "only a-z, 0-9 and hyphens are allowed (lowercase)";
  if (label.startsWith("-") || label.endsWith("-")) return "no leading or trailing hyphen";
  return null;
}

export function isValidName(label: string): boolean {
  return nameError(label) === null;
}

/**
 * Does this string want to be read as a name rather than an address? An explicit `.cook` always
 * does; otherwise anything that isn't a well-formed base58 pubkey is treated as a name (a 32-char
 * `[a-z0-9-]` label decodes to ~23 bytes, so it can never collide with a real 32-byte pubkey).
 */
export function looksLikeName(input: string): boolean {
  const s = input.trim();
  if (s.toLowerCase().endsWith(COOK_TLD)) return true;
  return !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export type PriceTier = "short" | "long";

export function priceTier(label: string): PriceTier {
  return label.length <= SHORT_NAME_MAX_LENGTH ? "short" : "long";
}

/**
 * Registration price in native base units (lamports of COOK), as the program computes it:
 * `usd_cents → micro-dollars (×10_000) → native units (×10^decimals) ÷ the COOK price in
 * micro-dollars`. Verified by simulation against the live config (`cookUsdPriceMicro` 100,
 * 350¢ / 150¢): a 3-character name demands exactly 35_000_000_000_000 lamports and an 18-character
 * one 15_000_000_000_000 — i.e. 35,000 and 15,000 COOK.
 *
 * BigInt throughout: the intermediate is ~10^15 and the division floors, like the program's.
 */
export function registrationPriceRaw(cfg: DomainsConfig, label: string): bigint {
  if (cfg.cookUsdPriceMicro <= 0n) {
    throw new Error("cookie_domains config reports a COOK/USD price of 0");
  }
  const cents = priceTier(label) === "short" ? cfg.shortNameUsdCents : cfg.longNameUsdCents;
  return (cents * 10_000n * 10n ** BigInt(cfg.nativeDecimals)) / cfg.cookUsdPriceMicro;
}
