// Hand-encoded `cookie_domains_market` instructions + account decoders — the CookOven domain
// marketplace (market.cookoven.xyz, program `Ey35mr69…`). Pure: PublicKey/Buffer only, no
// Connection, so every derivation and byte layout is unit-testable with golden values.
//
// Why hand-encoded: like the name registry itself, market.cookoven.xyz is a pure client-side dApp
// with no backend — it builds every instruction against the program on `rpc.cookiescan.io`, so there
// is no API to be a thin client of. There is also NO on-chain IDL account for this program (the
// registry publishes one, this one does not), so the discriminators below were read out of the dApp's
// JS bundle and then confirmed two ways: they are the standard anchor `sha256("global:<name>")[..8]`
// of the names the program logs (`Instruction: ListDomain`, …), and every one of them was replayed
// against the live deployment by simulation.
//
// ⚠️ **Listing escrows the name.** `list_domain` CPIs into `cookie_domains::transfer_domain` and
// hands the domain to the marketplace's `["escrow_authority"]` PDA, so while a name is listed the
// registry reports the ESCROW as its owner and the seller cannot transfer, re-point or set it as
// primary. `cancel_listing` and `buy_listing` transfer it back out (to the seller / to the buyer).
// That is why so much of `domains/index.ts` has to be escrow-aware: an escrowed name is not an
// address you can pay.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { PROGRAM_IDS } from "../config";
import { DOMAINS_PROGRAM_ID } from "./program";

export const DOMAIN_MARKET_PROGRAM_ID = new PublicKey(PROGRAM_IDS.cookieDomainsMarket);

export const MARKET_CONFIG_SEED = Buffer.from("config");
export const LISTING_SEED = Buffer.from("listing");
export const ESCROW_AUTHORITY_SEED = Buffer.from("escrow_authority");

export const MARKET_IX_DISCRIMINATORS = {
  listDomain: [140, 232, 109, 191, 154, 7, 181, 108],
  cancelListing: [41, 183, 50, 232, 230, 233, 157, 70],
  buyListing: [115, 149, 42, 108, 44, 49, 140, 153],
  // Admin-only, deliberately not exposed as tools — kept here so the error map and any future
  // read of the config can be checked against the same source.
  updateFeeBps: [43, 158, 104, 51, 236, 96, 178, 195],
  updateFeeWallet: [236, 164, 201, 6, 176, 37, 80, 17],
} as const;

export const MARKET_ACCOUNT_DISCRIMINATORS = {
  config: [169, 22, 247, 131, 182, 200, 81, 124],
  listing: [218, 32, 50, 73, 43, 134, 26, 58],
} as const;

/** `Config` = 8 disc + 32 admin + 32 fee_wallet + 2 fee_bps + 1 bump. */
export const MARKET_CONFIG_ACCOUNT_SIZE = 75;

/**
 * `Listing` is allocated at a fixed 125 bytes = 8 disc + 32 seller + 32 domain + (4 + 32) name +
 * 8 price + 8 created_at + 1 bump — the name field is sized for the longest possible label, so the
 * size is the same for every listing and a `dataSize: 125` filter enumerates them all.
 */
export const LISTING_ACCOUNT_SIZE = 125;

/** `update_fee_bps` rejects anything above this (error 6000) — verified by simulation. */
export const MAX_MARKET_FEE_BPS = 1000;

// --- PDAs ---------------------------------------------------------------------------------------

export function marketConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([MARKET_CONFIG_SEED], DOMAIN_MARKET_PROGRAM_ID)[0];
}

/**
 * `["escrow_authority"]` — the single PDA that holds every listed name. It is a constant, and
 * recognising it is how the rest of the domains module tells "listed" from "owned by a wallet".
 */
export function escrowAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([ESCROW_AUTHORITY_SEED], DOMAIN_MARKET_PROGRAM_ID)[0];
}

export const ESCROW_AUTHORITY = escrowAuthorityPda().toBase58();

/** `["listing", domainPda]` — one listing per name, keyed by the registry's domain account. */
export function listingPda(domain: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LISTING_SEED, domain.toBuffer()],
    DOMAIN_MARKET_PROGRAM_ID,
  )[0];
}

// --- Encoding -----------------------------------------------------------------------------------

const U64_MAX = 18_446_744_073_709_551_615n;

export function encodeListDomainData(priceRaw: bigint): Buffer {
  if (priceRaw <= 0n) throw new Error("listing price must be greater than zero");
  if (priceRaw > U64_MAX) throw new Error("listing price exceeds u64");
  const price = Buffer.alloc(8);
  price.writeBigUInt64LE(priceRaw);
  return Buffer.concat([Buffer.from(MARKET_IX_DISCRIMINATORS.listDomain), price]);
}

// --- Instructions -------------------------------------------------------------------------------

/**
 * `list_domain(price)` — creates the listing PDA (rent paid by the seller, refunded when the listing
 * ends) and moves the name into escrow via a CPI into the registry. The seller must be the current
 * domain owner (error 6004).
 */
export function listDomainIx(args: {
  seller: PublicKey;
  domain: PublicKey;
  priceRaw: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DOMAIN_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: listingPda(args.domain), isSigner: false, isWritable: true },
      { pubkey: args.seller, isSigner: true, isWritable: true },
      { pubkey: args.domain, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: DOMAINS_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeListDomainData(args.priceRaw),
  });
}

/**
 * `cancel_listing` — closes the listing (rent back to the seller) and returns the name from escrow.
 * Only the original seller can call it (error 6006). No system program: nothing is allocated.
 */
export function cancelListingIx(args: {
  seller: PublicKey;
  domain: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DOMAIN_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: listingPda(args.domain), isSigner: false, isWritable: true },
      { pubkey: args.seller, isSigner: true, isWritable: true },
      { pubkey: args.domain, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: DOMAINS_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(MARKET_IX_DISCRIMINATORS.cancelListing),
  });
}

/**
 * `buy_listing` — pays the seller, pays the marketplace fee, moves the name out of escrow to the
 * buyer and closes the listing. `feeWallet` must be the one named in the on-chain config (error
 * 6001), so it is always read live rather than hardcoded, and `seller` must match the listing
 * (6009). The instruction takes NO price argument — it reads the listing — so a client-side cap is
 * the only guard against buying at a price the caller did not mean to pay.
 */
export function buyListingIx(args: {
  buyer: PublicKey;
  seller: PublicKey;
  domain: PublicKey;
  feeWallet: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: DOMAIN_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: marketConfigPda(), isSigner: false, isWritable: false },
      { pubkey: listingPda(args.domain), isSigner: false, isWritable: true },
      { pubkey: args.buyer, isSigner: true, isWritable: true },
      { pubkey: args.seller, isSigner: false, isWritable: true },
      { pubkey: args.domain, isSigner: false, isWritable: true },
      { pubkey: args.feeWallet, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: DOMAINS_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(MARKET_IX_DISCRIMINATORS.buyListing),
  });
}

// --- Decoding -----------------------------------------------------------------------------------

function hasDiscriminator(data: Buffer, disc: readonly number[]): boolean {
  return data.length >= 8 && Buffer.from(disc).equals(data.subarray(0, 8));
}

export interface DecodedListing {
  seller: string;
  /** The registry's `["domain", label]` account — the listing's key. */
  domain: string;
  /** Bare label, no `.cook` suffix, exactly as the registry stores it. */
  name: string;
  priceRaw: bigint;
  /** Unix seconds. */
  createdAt: number;
}

/**
 * Decode a `Listing`. The name is a borsh string in the MIDDLE of the struct, so `price` and
 * `created_at` sit at offsets that depend on the label's length — the same trap as `DomainAccount`.
 * The allocation is a fixed 125 bytes either way, so the tail is zero padding.
 */
export function decodeListingAccount(data: Buffer): DecodedListing | null {
  if (!hasDiscriminator(data, MARKET_ACCOUNT_DISCRIMINATORS.listing)) return null;
  if (data.length < 77) return null;
  const seller = new PublicKey(data.subarray(8, 40)).toBase58();
  const domain = new PublicKey(data.subarray(40, 72)).toBase58();
  const nameLen = data.readUInt32LE(72);
  const end = 76 + nameLen;
  if (nameLen === 0 || end + 16 > data.length) return null;
  return {
    seller,
    domain,
    name: data.subarray(76, end).toString("utf8"),
    priceRaw: data.readBigUInt64LE(end),
    createdAt: Number(data.readBigInt64LE(end + 8)),
  };
}

export interface MarketConfig {
  admin: string;
  /** Where the marketplace cut goes. `buy_listing` requires exactly this account. */
  feeWallet: string;
  /** Marketplace cut in basis points — 100 = 1%. Admin-mutable, capped at 1000. */
  feeBps: number;
}

export function decodeMarketConfigAccount(data: Buffer): MarketConfig | null {
  if (!hasDiscriminator(data, MARKET_ACCOUNT_DISCRIMINATORS.config)) return null;
  if (data.length < MARKET_CONFIG_ACCOUNT_SIZE) return null;
  return {
    admin: new PublicKey(data.subarray(8, 40)).toBase58(),
    feeWallet: new PublicKey(data.subarray(40, 72)).toBase58(),
    feeBps: data.readUInt16LE(72),
  };
}

// --- Fee math -----------------------------------------------------------------------------------

/**
 * How a sale splits. The program floors the fee (integer math), so the seller keeps the remainder —
 * confirmed against the only completed sale on the deployment (1,000 COOK at 100 bps: 10 COOK to the
 * fee wallet, 990 to the seller, plus the listing rent refunded on close).
 */
export function splitSalePrice(
  priceRaw: bigint,
  feeBps: number,
): { feeRaw: bigint; sellerReceivesRaw: bigint } {
  const feeRaw = (priceRaw * BigInt(feeBps)) / 10_000n;
  return { feeRaw, sellerReceivesRaw: priceRaw - feeRaw };
}

// --- Errors -------------------------------------------------------------------------------------

/**
 * Anchor errors from `cookie_domains_market`. There is no IDL account and no source repo, so every
 * entry below was produced by simulating the failure against the live deployment rather than copied
 * from a table — the gaps (6002, 6007, 6008, 6011) are conditions we could not reach, and are
 * deliberately left out instead of guessed at.
 *
 * The program compiles with anchor's error messages included, so the raw logs already carry
 * `Error Message: …`. `marketSimError` prefers the map for the cases where we have something more
 * actionable to say and falls back to that log line otherwise — which means an unmapped code still
 * surfaces the program's own wording instead of a number.
 */
export const MARKET_ERRORS: Record<number, string> = {
  6000: `the marketplace fee is above the ${MAX_MARKET_FEE_BPS} bps cap`,
  6001: "wrong marketplace fee wallet — the on-chain config names a different one",
  6003: "the listing price must be greater than zero",
  6004: "you do not own this domain, so you cannot list it",
  6005: "wrong name-registry program passed to the marketplace",
  6006: "only the wallet that created the listing can do that",
  6009: "the listing's seller does not match the account passed for it",
  6010: "you cannot buy your own listing — cancel_domain_listing instead",
  6012: "that domain is not registered, or the marketplace does not hold it",
};

/**
 * Turn a failed marketplace simulation into something an agent can act on. Three non-anchor cases
 * matter as much as the error table:
 *   - the SYSTEM program's `custom program error: 0x0` on `list_domain` means the listing PDA already
 *     exists, i.e. the name is already listed — the most likely failure and unreadable as-is;
 *   - `0x1` is "insufficient lamports", which for a purchase means the wallet cannot cover the price;
 *   - anchor's own `Error Message:` line, used verbatim for any code we have not mapped.
 */
export function marketSimError(logs: string[], label?: string): string | null {
  const blob = logs.join(" ");
  const anchor = /Error Number: (\d+)/.exec(blob);
  if (anchor) {
    const mapped = MARKET_ERRORS[Number(anchor[1])];
    if (mapped) return mapped;
  }
  if (/Program 11111111111111111111111111111111 failed: custom program error: 0x0/.test(blob)) {
    return label
      ? `${label}.cook is already listed for sale`
      : "that domain is already listed for sale";
  }
  const insufficient = /insufficient lamports (\d+), need (\d+)/.exec(blob);
  if (insufficient) {
    return `insufficient COOK: the wallet holds ${insufficient[1]} lamports, the purchase needs ${insufficient[2]}`;
  }
  const message = /Error Message: ([^\n]+?)\.?$/m.exec(logs.join("\n"));
  if (message) return message[1].replace(/\.$/, "");
  return null;
}

// --- Listing views ------------------------------------------------------------------------------

export interface DomainListingView {
  name: string;
  label: string;
  priceCook: string;
  priceLamports: string;
  seller: string;
  domain: string;
  listing: string;
  createdAt: string;
  /** Characters in the label — short names are the scarce ones, so it is worth surfacing. */
  length: number;
}

/**
 * Filter and sort listings. Pure, so the price/length/seller predicates are unit-tested rather than
 * inferred from a live scan. `name` matches a substring of the label, case-insensitively and with a
 * `.cook` suffix tolerated; `maxPriceRaw` is inclusive.
 */
export function filterSortListings(
  all: DecodedListing[],
  args: {
    name?: string;
    seller?: string;
    maxPriceRaw?: bigint;
    maxLength?: number;
    sort?: "price" | "recent" | "length";
  },
): DecodedListing[] {
  let out = [...all];
  if (args.name) {
    const q = args.name
      .trim()
      .toLowerCase()
      .replace(/\.cook$/, "");
    if (q) out = out.filter((l) => l.name.includes(q));
  }
  if (args.seller) out = out.filter((l) => l.seller === args.seller);
  if (args.maxPriceRaw !== undefined) {
    const cap = args.maxPriceRaw;
    out = out.filter((l) => l.priceRaw <= cap);
  }
  if (args.maxLength !== undefined) {
    const max = args.maxLength;
    out = out.filter((l) => l.name.length <= max);
  }
  const byName = (a: DecodedListing, b: DecodedListing) => a.name.localeCompare(b.name);
  if (args.sort === "price") {
    out.sort((a, b) =>
      a.priceRaw === b.priceRaw ? byName(a, b) : a.priceRaw < b.priceRaw ? -1 : 1,
    );
  } else if (args.sort === "length") {
    out.sort((a, b) => a.name.length - b.name.length || byName(a, b));
  } else {
    out.sort((a, b) => b.createdAt - a.createdAt || byName(a, b));
  }
  return out;
}

/** Cheapest listing price, or null when there are none. */
export function floorPriceRaw(listings: DecodedListing[]): bigint | null {
  return listings.reduce<bigint | null>(
    (min, l) => (min === null || l.priceRaw < min ? l.priceRaw : min),
    null,
  );
}
