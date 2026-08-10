// The CookOven `.cook` domain marketplace (market.cookoven.xyz) — the secondary market for names
// that are already registered. Program `Ey35mr69…`; layouts, PDAs and instruction encoding are in
// `marketplace.ts`.
//
// Everything here talks straight to the chain. There is no API and no indexer: listings are one
// `getProgramAccounts` on a fixed 125-byte account, which is on-chain truth in a single round trip
// (there are ten listings today, so the scan is cheap and stays cheap for a long while).
//
// ⚠️ A listed name is held by the marketplace's escrow PDA, not by its seller. That has consequences
// well outside this file — a listed name resolves to the escrow address, and the seller can no longer
// transfer it or set it as primary — so the registry side (`index.ts`) checks for escrow ownership
// wherever it reads a domain's owner. `escrowedNameError` in `shared.ts` is that refusal.
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";

import {
  COOKOVEN_MARKET_URL,
  COOK_DECIMALS,
  COOK_SYMBOL,
  explorerAddressUrl,
  explorerTxUrl,
} from "../config";
import { CookieMcpError } from "../errors";
import { bpsToPct, rawToUi, uiToRaw } from "../format";
import { getConnection } from "../rpc";
import { requireWallet } from "../wallet";
import { displayName } from "./names";
import { domainPda } from "./program";
import {
  buyListingIx,
  cancelListingIx,
  decodeListingAccount,
  decodeMarketConfigAccount,
  DOMAIN_MARKET_PROGRAM_ID,
  ESCROW_AUTHORITY,
  filterSortListings,
  floorPriceRaw,
  listDomainIx,
  listingPda,
  LISTING_ACCOUNT_SIZE,
  MARKET_ACCOUNT_DISCRIMINATORS,
  marketConfigPda,
  marketSimError,
  splitSalePrice,
  type DecodedListing,
  type DomainListingView,
  type MarketConfig,
} from "./marketplace";
import {
  fetchDomain,
  fetchListing,
  fetchPrimary,
  requireValidName,
  resolveWallet,
  sendDomainTx,
} from "./shared";

const cookUi = (raw: bigint): string => rawToUi(raw, COOK_DECIMALS);
const translate = (label?: string) => (logs: string[]) => marketSimError(logs, label);

// --- Reads ---------------------------------------------------------------------------------------

export async function fetchMarketConfig(conn: Connection): Promise<MarketConfig> {
  const info = await conn.getAccountInfo(marketConfigPda());
  const cfg = info && decodeMarketConfigAccount(info.data as Buffer);
  if (!cfg) {
    throw new CookieMcpError(
      "could not read the .cook marketplace config",
      `the marketplace program (${DOMAIN_MARKET_PROGRAM_ID.toBase58()}) may not be reachable on ` +
        "this RPC — check COOKIE_RPC_URL",
    );
  }
  return cfg;
}

/**
 * Every live listing. A `dataSize` filter is enough — the account is allocated at a fixed 125 bytes
 * regardless of the name's length — and the discriminator memcmp keeps the config account out.
 */
export async function fetchListings(conn: Connection): Promise<DecodedListing[]> {
  const accounts = await conn.getProgramAccounts(DOMAIN_MARKET_PROGRAM_ID, {
    filters: [
      { dataSize: LISTING_ACCOUNT_SIZE },
      {
        memcmp: {
          offset: 0,
          bytes: bs58.encode(Buffer.from(MARKET_ACCOUNT_DISCRIMINATORS.listing)),
        },
      },
    ],
  });
  return accounts
    .map(({ account }) => decodeListingAccount(account.data as Buffer))
    .filter((l): l is DecodedListing => l !== null);
}

export function toListingView(l: DecodedListing): DomainListingView {
  return {
    name: displayName(l.name),
    label: l.name,
    priceCook: cookUi(l.priceRaw),
    priceLamports: l.priceRaw.toString(),
    seller: l.seller,
    domain: l.domain,
    listing: listingPda(new PublicKey(l.domain)).toBase58(),
    createdAt: new Date(l.createdAt * 1000).toISOString(),
    length: l.name.length,
  };
}

export interface DomainListingsResult {
  count: number;
  totalListings: number;
  marketplaceFee: string;
  feeBps: number;
  floorPriceCook: string | null;
  marketUrl: string;
  listings: DomainListingView[];
  note?: string;
}

/**
 * Browse the market. Newest-first by default; `sort: "price"` is the one an agent hunting for a name
 * usually wants. The fee is reported alongside because it is admin-mutable and comes out of the
 * seller's proceeds, so "what will I actually receive" is not derivable from the price alone.
 */
export async function getDomainListings(args: {
  name?: string;
  seller?: string;
  maxPriceCook?: string | number;
  maxLength?: number;
  sort?: "price" | "recent" | "length";
  limit?: number;
}): Promise<DomainListingsResult> {
  const conn = getConnection();
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);

  let maxPriceRaw: bigint | undefined;
  if (args.maxPriceCook !== undefined) {
    try {
      maxPriceRaw = uiToRaw(args.maxPriceCook, COOK_DECIMALS);
    } catch {
      throw new CookieMcpError(
        `invalid maxPriceCook "${args.maxPriceCook}"`,
        `${COOK_SYMBOL} has up to ${COOK_DECIMALS} decimals`,
      );
    }
  }

  // A `.cook` seller name has to resolve before the scan can be filtered by it; a plain address costs
  // nothing.
  const seller = args.seller
    ? (await resolveWallet(args.seller, "seller")).pubkey.toBase58()
    : undefined;

  const [all, cfg] = await Promise.all([fetchListings(conn), fetchMarketConfig(conn)]);
  const matched = filterSortListings(all, { ...args, seller, maxPriceRaw });
  const floor = floorPriceRaw(matched);

  return {
    count: matched.length,
    totalListings: all.length,
    marketplaceFee: bpsToPct(cfg.feeBps),
    feeBps: cfg.feeBps,
    floorPriceCook: floor === null ? null : cookUi(floor),
    marketUrl: COOKOVEN_MARKET_URL,
    listings: matched.slice(0, limit).map(toListingView),
    ...(matched.length === 0
      ? {
          note: all.length
            ? `no listing matches those filters — ${all.length} name(s) are for sale in total`
            : `no .cook names are listed for sale right now — see ${COOKOVEN_MARKET_URL}`,
        }
      : {}),
  };
}

// --- Writes ----------------------------------------------------------------------------------------

export interface ListDomainResult {
  signature: string;
  explorerUrl: string;
  name: string;
  priceCook: string;
  priceLamports: string;
  listing: string;
  domain: string;
  escrowedTo: string;
  marketplaceFee: string;
  youReceiveOnSale: string;
  marketUrl: string;
  note: string;
}

/**
 * Put a name up for sale. The name moves into the marketplace's escrow PDA in the same instruction,
 * which is the part that surprises people: until the listing is cancelled or bought, the registry
 * reports the escrow as the owner, `.cook` resolution points at the escrow, and this wallet cannot
 * transfer the name, re-point it or set it as primary.
 *
 * No spend guard: listing costs only the listing account's rent (~0.00176 COOK, refunded when the
 * listing ends) and `cancel_domain_listing` undoes it. The price is validated against u64 and zero.
 */
export async function listDomain(args: {
  name: string;
  priceCook: string | number;
}): Promise<ListDomainResult> {
  const { keypair } = requireWallet();
  const label = requireValidName(args.name);
  const conn = getConnection();
  const owner = keypair.publicKey;

  let priceRaw: bigint;
  try {
    priceRaw = uiToRaw(args.priceCook, COOK_DECIMALS);
  } catch {
    throw new CookieMcpError(
      `invalid priceCook "${args.priceCook}"`,
      `${COOK_SYMBOL} has up to ${COOK_DECIMALS} decimals`,
    );
  }
  if (priceRaw <= 0n) {
    throw new CookieMcpError(
      "the listing price must be greater than zero",
      "pass the asking price in COOK, e.g. priceCook: 25000",
    );
  }

  const [domain, cfg, existing] = await Promise.all([
    fetchDomain(conn, label),
    fetchMarketConfig(conn),
    fetchListing(conn, label),
  ]);
  if (!domain) {
    throw new CookieMcpError(
      `${displayName(label)} is not registered, so there is nothing to list`,
      "register_domain claims an unregistered name; resolve_domain checks availability for free",
    );
  }
  if (existing) {
    throw new CookieMcpError(
      `${displayName(label)} is already listed for ${cookUi(existing.priceRaw)} ${COOK_SYMBOL}` +
        (existing.seller === owner.toBase58() ? " by this wallet" : ` by ${existing.seller}`),
      existing.seller === owner.toBase58()
        ? "there is no re-price instruction — cancel_domain_listing, then list_domain at the new price"
        : "get_domain_listings shows the live market",
    );
  }
  if (domain.legacy) {
    throw new CookieMcpError(
      `${displayName(label)} uses a pre-resolver account layout the registry can no longer deserialize`,
      "this name can be read but not transferred, so it cannot be escrowed for sale",
    );
  }
  if (domain.owner !== owner.toBase58()) {
    throw new CookieMcpError(
      `${displayName(label)} is owned by ${domain.owner}, not this wallet`,
      "only the owner can list a name — get_owned_domains shows what this wallet can sell",
    );
  }

  const { feeRaw, sellerReceivesRaw } = splitSalePrice(priceRaw, cfg.feeBps);
  const primary = await fetchPrimary(conn, owner);

  const tx = new Transaction().add(
    listDomainIx({ seller: owner, domain: domainPda(label), priceRaw }),
  );
  const signature = await sendDomainTx(conn, tx, "domain listing", translate(label));

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    name: displayName(label),
    priceCook: cookUi(priceRaw),
    priceLamports: priceRaw.toString(),
    listing: listingPda(domainPda(label)).toBase58(),
    domain: domainPda(label).toBase58(),
    escrowedTo: ESCROW_AUTHORITY,
    marketplaceFee: `${cookUi(feeRaw)} ${COOK_SYMBOL} (${bpsToPct(cfg.feeBps)})`,
    youReceiveOnSale: `${cookUi(sellerReceivesRaw)} ${COOK_SYMBOL}`,
    marketUrl: COOKOVEN_MARKET_URL,
    note:
      "the name is now held by the marketplace escrow, so this wallet cannot transfer it, update " +
      "its pointers or set it as primary until the listing ends. cancel_domain_listing returns it " +
      "at any time (and refunds the listing rent)." +
      (primary === label
        ? ` ⚠️ ${displayName(label)} is still this wallet's primary name, and the registry does not ` +
          "clear that on a transfer — reverse lookups will keep showing a name the wallet no longer " +
          "owns until the listing ends or you call set_primary_domain with clear: true."
        : ""),
  };
}

export interface BuyDomainResult {
  signature: string;
  explorerUrl: string;
  name: string;
  paid: string;
  marketplaceFee: string;
  sellerReceived: string;
  seller: string;
  owner: string;
  domain: string;
  domainUrl: string;
  note: string;
}

/**
 * Buy a listed name. `buy_listing` takes no price argument — it reads the listing account — so
 * `maxPriceCook` is a client-side cap and the only thing standing between an agent and a name listed
 * at ten million COOK. It is required for the same reason `register_domain` requires it: the spend is
 * large, irreversible, and not implied by the request. Called without it, this quotes the price and
 * spends nothing.
 */
export async function buyDomain(args: {
  name: string;
  maxPriceCook?: string | number;
}): Promise<BuyDomainResult> {
  const { keypair } = requireWallet();
  const label = requireValidName(args.name);
  const conn = getConnection();
  const buyer = keypair.publicKey;

  const [listing, cfg] = await Promise.all([fetchListing(conn, label), fetchMarketConfig(conn)]);
  if (!listing) {
    throw new CookieMcpError(
      `${displayName(label)} is not listed for sale`,
      "get_domain_listings shows what is on the market; resolve_domain shows who owns a name",
    );
  }
  if (listing.seller === buyer.toBase58()) {
    throw new CookieMcpError(
      `${displayName(label)} is listed by this wallet — you cannot buy your own listing`,
      "cancel_domain_listing takes it back out of escrow for free",
    );
  }

  const refusal = buyPriceGuardError({ label, priceRaw: listing.priceRaw, ...args });
  if (refusal) throw refusal;

  const { feeRaw, sellerReceivesRaw } = splitSalePrice(listing.priceRaw, cfg.feeBps);
  const tx = new Transaction().add(
    buyListingIx({
      buyer,
      seller: new PublicKey(listing.seller),
      domain: new PublicKey(listing.domain),
      feeWallet: new PublicKey(cfg.feeWallet),
    }),
  );
  const signature = await sendDomainTx(conn, tx, "domain purchase", translate(label));

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    name: displayName(label),
    paid: `${cookUi(listing.priceRaw)} ${COOK_SYMBOL}`,
    marketplaceFee: `${cookUi(feeRaw)} ${COOK_SYMBOL} (${bpsToPct(cfg.feeBps)})`,
    sellerReceived: `${cookUi(sellerReceivesRaw)} ${COOK_SYMBOL}`,
    seller: listing.seller,
    owner: buyer.toBase58(),
    domain: listing.domain,
    domainUrl: explorerAddressUrl(listing.domain),
    note:
      "the name left escrow and is now owned by this wallet, permanently and with no expiry. " +
      "set_primary_domain makes it this wallet's default label.",
  };
}

/**
 * The whole spend guard for `buy_domain`, pure so the boundary cases are unit-tested: no
 * `maxPriceCook` quotes the price and refuses, an unparseable one refuses (never treated as
 * unlimited), and a price above the cap refuses. Returns null when the spend is authorized.
 */
export function buyPriceGuardError(args: {
  label: string;
  priceRaw: bigint;
  maxPriceCook?: string | number;
}): CookieMcpError | null {
  const priceCook = cookUi(args.priceRaw);
  if (args.maxPriceCook === undefined) {
    return new CookieMcpError(
      `${displayName(args.label)} is listed for ${priceCook} ${COOK_SYMBOL} — no maxPriceCook was ` +
        "given, so nothing was spent",
      `confirm with maxPriceCook: ${priceCook} (or higher) to buy it. The purchase is final and the ` +
        "seller can cancel and relist at a different price at any time, so the cap is checked " +
        "against the live listing.",
    );
  }
  let cap: bigint;
  try {
    cap = uiToRaw(args.maxPriceCook, COOK_DECIMALS);
  } catch {
    return new CookieMcpError(
      `invalid maxPriceCook "${args.maxPriceCook}"`,
      `${COOK_SYMBOL} has up to ${COOK_DECIMALS} decimals`,
    );
  }
  if (args.priceRaw > cap) {
    return new CookieMcpError(
      `${displayName(args.label)} is listed for ${priceCook} ${COOK_SYMBOL}, above the maxPriceCook ` +
        `of ${rawToUi(cap, COOK_DECIMALS)} — nothing was spent`,
      "raise maxPriceCook to proceed, or use get_domain_listings with maxPriceCook to find one in budget",
    );
  }
  return null;
}

export interface CancelDomainListingResult {
  signature: string;
  explorerUrl: string;
  name: string;
  owner: string;
  wasListedFor: string;
  note: string;
}

/** Take a name off the market. The escrow returns it to the seller and the listing rent is refunded. */
export async function cancelDomainListing(args: {
  name: string;
}): Promise<CancelDomainListingResult> {
  const { keypair } = requireWallet();
  const label = requireValidName(args.name);
  const conn = getConnection();
  const owner = keypair.publicKey;

  const listing = await fetchListing(conn, label);
  if (!listing) {
    throw new CookieMcpError(
      `${displayName(label)} is not listed for sale`,
      "get_owned_domains shows which of this wallet's names are listed",
    );
  }
  if (listing.seller !== owner.toBase58()) {
    throw new CookieMcpError(
      `${displayName(label)} was listed by ${listing.seller}, not this wallet`,
      "only the seller can cancel a listing — buy_domain is how another wallet takes the name",
    );
  }

  const tx = new Transaction().add(
    cancelListingIx({ seller: owner, domain: new PublicKey(listing.domain) }),
  );
  const signature = await sendDomainTx(conn, tx, "listing cancellation", translate(label));

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    name: displayName(label),
    owner: owner.toBase58(),
    wasListedFor: `${cookUi(listing.priceRaw)} ${COOK_SYMBOL}`,
    note:
      "the name is out of escrow and owned by this wallet again (the listing rent was refunded), so " +
      "transfer_domain, update_domain and set_primary_domain work on it once more",
  };
}
