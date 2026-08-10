// CookOven `.cook` names — Cookie Chain's name service (book.cookoven.xyz, program
// `H43Qtq4A…`, IDL in src/idl/cookie_domains.json).
//
// Everything here talks straight to the chain: the dApp is client-side only, so there is no API to
// go through and no indexer to depend on. Reads are PDA reads (`["domain", name]`,
// `["primary", owner]`) plus one `getProgramAccounts` for enumeration; writes are hand-encoded
// instructions, simulated on our RPC and signed locally.
//
// ⚠️ Registration is EXPENSIVE: the price is quoted in USD by the on-chain config and paid in COOK.
// At the live config (COOK = $0.0001) that is 35,000 COOK for a 1–3 character name and 15,000 COOK
// for anything longer. `registerDomain` therefore refuses to spend anything until the caller states
// a `maxPriceCook` it accepts.
//
// ⚠️ Names can also be LISTED FOR SALE on the domain marketplace (`market.ts`), and a listed name is
// owned by the marketplace's escrow PDA rather than by its seller. Every read and write below that
// touches a domain's owner therefore has to recognise that address — otherwise a listed name looks
// like it belongs to a stranger, and `.cook` resolution hands out an account nobody can spend from.
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";

import {
  COOKOVEN_MARKET_URL,
  COOKOVEN_SITE_URL,
  COOK_DECIMALS,
  COOK_SYMBOL,
  explorerAddressUrl,
  explorerTxUrl,
} from "../config";
import { CookieMcpError } from "../errors";
import { rawToUi, uiToRaw } from "../format";
import { getConnection } from "../rpc";
import { getWallet, requireWallet } from "../wallet";
import {
  ACCOUNT_DISCRIMINATORS,
  clearPrimaryDomainIx,
  decodeDomainAccount,
  domainPda,
  domainSimError,
  DOMAINS_PROGRAM_ID,
  registerDomainIx,
  setPrimaryDomainIx,
  transferDomainIx,
  transferNeedsPrimaryCleanup,
  updateDomainPointerIx,
  type DecodedDomain,
} from "./program";
import { listingPda, type DecodedListing } from "./marketplace";
import {
  escrowedNameError,
  fetchDomain,
  fetchDomainsConfig,
  fetchListing,
  fetchPrimary,
  isEscrowed,
  requireValidName,
  resolveWallet,
  sendDomainTx,
} from "./shared";
import { fetchListings } from "./market";
import {
  displayName,
  priceTier,
  registrationPriceRaw,
  type DomainsConfig,
  type PriceTier,
} from "./names";

export {
  displayName,
  isValidName,
  looksLikeName,
  MAX_NAME_LENGTH,
  nameError,
  normalizeName,
  priceTier,
  registrationPriceRaw,
  SHORT_NAME_MAX_LENGTH,
  type DomainsConfig,
  type PriceTier,
} from "./names";

export {
  escrowedNameError,
  fetchDomainsConfig,
  fetchListing,
  isEscrowed,
  resolveWallet,
  type ResolvedWallet,
} from "./shared";

export {
  buyDomain,
  buyPriceGuardError,
  cancelDomainListing,
  fetchListings,
  fetchMarketConfig,
  getDomainListings,
  listDomain,
  toListingView,
  type BuyDomainResult,
  type CancelDomainListingResult,
  type DomainListingsResult,
  type ListDomainResult,
} from "./market";

export {
  DOMAIN_MARKET_PROGRAM_ID,
  ESCROW_AUTHORITY,
  filterSortListings,
  floorPriceRaw,
  MARKET_ERRORS,
  marketSimError,
  MAX_MARKET_FEE_BPS,
  splitSalePrice,
  type DecodedListing,
  type DomainListingView,
  type MarketConfig,
} from "./marketplace";

export interface PriceView {
  tier: PriceTier;
  priceCook: string;
  priceUsd: number;
  priceRaw: string;
}

/** The registration price of a name in both denominations, straight from the live config. */
export function priceView(cfg: DomainsConfig, label: string): PriceView {
  const raw = registrationPriceRaw(cfg, label);
  const tier = priceTier(label);
  const cents = tier === "short" ? cfg.shortNameUsdCents : cfg.longNameUsdCents;
  return {
    tier,
    priceCook: rawToUi(raw, COOK_DECIMALS),
    priceUsd: Number(cents) / 100,
    priceRaw: raw.toString(),
  };
}

/**
 * The whole spend guard for `register_domain`, as a pure function so it can be tested without a
 * chain: no `maxPriceCook` at all is a refusal that quotes the live price, an unparseable one is a
 * refusal, and a price above the stated cap is a refusal. Returns null when the spend is authorized.
 *
 * There is no on-chain slippage protection here — the instruction takes no amount, the program reads
 * its own config — so this client-side check is the ONLY thing standing between an agent and an
 * admin-set price that changed since the quote.
 */
export function priceGuardError(args: {
  label: string;
  price: PriceView;
  maxPriceCook?: string | number;
}): CookieMcpError | null {
  const { label, price } = args;
  if (args.maxPriceCook === undefined) {
    return new CookieMcpError(
      `registering ${displayName(label)} costs ${price.priceCook} ${COOK_SYMBOL} ` +
        `(${price.tier} name, $${price.priceUsd.toFixed(2)}) — no maxPriceCook was given, so ` +
        "nothing was spent",
      `confirm with maxPriceCook: ${price.priceCook} (or higher) to go ahead. The price is set in ` +
        "USD by the registry admin and converted at the configured COOK price, so it can change " +
        "between calls.",
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
  if (BigInt(price.priceRaw) > cap) {
    return new CookieMcpError(
      `registering ${displayName(label)} costs ${price.priceCook} ${COOK_SYMBOL}, above the ` +
        `maxPriceCook of ${rawToUi(cap, COOK_DECIMALS)} — nothing was spent`,
      "raise maxPriceCook to proceed, or choose a longer name (4+ characters are the cheaper tier)",
    );
  }
  return null;
}

/**
 * Decode a `getProgramAccounts` page into the names a wallet owns. Pure so the offset arithmetic —
 * which depends on each name's length — is tested against golden bytes rather than a live scan.
 */
export function mapOwnedDomains(
  accounts: Array<{ pubkey: string; data: Buffer }>,
  owner: string,
  primary: string | null,
): OwnedDomain[] {
  return accounts
    .map(({ pubkey, data }) => ({ pubkey, decoded: decodeDomainAccount(data) }))
    .filter((a): a is { pubkey: string; decoded: DecodedDomain } => a.decoded?.owner === owner)
    .map(({ pubkey, decoded }) => ({
      name: displayName(decoded.name),
      label: decoded.name,
      account: pubkey,
      isPrimary: decoded.name === primary,
      resolver: decoded.resolver,
      metadata: decoded.metadata,
      createdAt: decoded.createdAt ? new Date(decoded.createdAt * 1000).toISOString() : null,
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.label.localeCompare(b.label));
}

// --- Reads ---------------------------------------------------------------------------------------

export interface ResolveDomainResult {
  name: string;
  label: string;
  registered: boolean;
  account: string;
  accountUrl: string;
  owner: string | null;
  ownerUrl: string | null;
  isOwnersPrimary: boolean | null;
  resolver: string | null;
  metadata: string | null;
  createdAt: string | null;
  price: { tier: PriceTier; priceCook: string; priceUsd: number; priceRaw: string } | null;
  /**
   * Set when the name is on the marketplace. `owner` is then the escrow PDA, NOT a wallet — the
   * person to deal with is `forSale.seller`.
   */
  forSale: {
    priceCook: string;
    priceLamports: string;
    seller: string;
    listing: string;
    listedAt: string;
    marketUrl: string;
  } | null;
  note?: string;
}

/**
 * Forward lookup: `bot.cook` → who owns it. When the name is free it returns the live registration
 * price instead of an owner, so an agent can answer "is X available and what does it cost?" in one
 * call.
 *
 * A name that is listed for sale reports the marketplace escrow as its `owner`, because that is the
 * on-chain truth — reporting the seller there would be a lie an agent could act on. The listing is
 * surfaced in `forSale` instead, and the extra read only happens when the owner IS the escrow, so a
 * normal lookup costs exactly what it did before.
 */
export async function resolveDomain(input: string): Promise<ResolveDomainResult> {
  const label = requireValidName(input);
  const conn = getConnection();
  const pda = domainPda(label);
  const [domain, cfg] = await Promise.all([fetchDomain(conn, label), fetchDomainsConfig(conn)]);

  const base = {
    name: displayName(label),
    label,
    account: pda.toBase58(),
    accountUrl: explorerAddressUrl(pda.toBase58()),
  };

  if (!domain) {
    return {
      ...base,
      registered: false,
      owner: null,
      ownerUrl: null,
      isOwnersPrimary: null,
      resolver: null,
      metadata: null,
      createdAt: null,
      price: priceView(cfg, label),
      forSale: null,
      note: `${base.name} is available — register_domain claims it, or register it at ${COOKOVEN_SITE_URL}`,
    };
  }

  const escrowed = isEscrowed(domain);
  const [primary, listing] = await Promise.all([
    escrowed ? Promise.resolve(null) : fetchPrimary(conn, new PublicKey(domain.owner)),
    escrowed ? fetchListing(conn, label) : Promise.resolve(null),
  ]);

  return {
    ...base,
    registered: true,
    owner: domain.owner,
    ownerUrl: explorerAddressUrl(domain.owner),
    // Meaningless for an escrowed name: the escrow PDA has no primary of its own.
    isOwnersPrimary: escrowed ? null : primary === label,
    resolver: domain.resolver,
    metadata: domain.metadata,
    createdAt: domain.createdAt ? new Date(domain.createdAt * 1000).toISOString() : null,
    price: null,
    forSale: listing ? forSaleView(listing) : null,
    ...(domain.legacy
      ? {
          note:
            "this domain uses a pre-resolver account layout the current program can no longer " +
            "deserialize — it can be read but not transferred or updated",
        }
      : listing
        ? {
            note:
              `${base.name} is FOR SALE at ${rawToUi(listing.priceRaw, COOK_DECIMALS)} ` +
              `${COOK_SYMBOL} — buy_domain claims it. \`owner\` above is the marketplace escrow ` +
              `account, not a wallet: do not send funds to it, the seller is ${listing.seller}.`,
          }
        : escrowed
          ? {
              note:
                "this name is held by the marketplace escrow but has no listing — treat `owner` as " +
                "a program account, not a wallet",
            }
          : {}),
  };
}

/** Shared shape for "this name is on the market", used by resolve_domain and get_owned_domains. */
function forSaleView(l: DecodedListing): NonNullable<ResolveDomainResult["forSale"]> {
  return {
    priceCook: rawToUi(l.priceRaw, COOK_DECIMALS),
    priceLamports: l.priceRaw.toString(),
    seller: l.seller,
    listing: listingPda(new PublicKey(l.domain)).toBase58(),
    listedAt: new Date(l.createdAt * 1000).toISOString(),
    marketUrl: COOKOVEN_MARKET_URL,
  };
}

export interface OwnedDomain {
  name: string;
  label: string;
  account: string;
  isPrimary: boolean;
  resolver: string | null;
  metadata: string | null;
  createdAt: string | null;
}

export interface ListedDomain {
  name: string;
  label: string;
  priceCook: string;
  priceLamports: string;
  listing: string;
  listedAt: string;
}

export interface OwnedDomainsResult {
  wallet: string;
  primary: string | null;
  count: number;
  domains: OwnedDomain[];
  /**
   * Names this wallet has put up for sale. They are NOT in `domains`, because the registry no longer
   * records this wallet as their owner — the marketplace escrow does — but the wallet still controls
   * them: it is the only one that can cancel the listing.
   */
  listedForSale: ListedDomain[];
  listedCount: number;
  note?: string;
}

/**
 * Reverse lookup: every `.cook` name a wallet owns, plus which one is its primary.
 *
 * Enumeration is a full `getProgramAccounts` scan filtered client-side, NOT a memcmp on the owner:
 * `DomainAccount` starts with a borsh string, so `owner` sits at a different offset for every name
 * length. The registry is small (~100 accounts, one round trip) and this is on-chain truth with no
 * indexer in the path. `primary` comes from the `["primary", owner]` PDA, which is authoritative and
 * independent of the scan.
 *
 * The marketplace scan runs in the SAME round trip (it is one more `getProgramAccounts` on ~10
 * accounts, issued in parallel), because without it a wallet that has listed everything it owns would
 * be told it owns nothing at all.
 */
export async function getOwnedDomains(walletInput?: string): Promise<OwnedDomainsResult> {
  const wallet = walletInput
    ? await resolveWallet(walletInput, "wallet")
    : { pubkey: parseOwnPubkey(), name: null };
  const conn = getConnection();

  const [accounts, primary, listings] = await Promise.all([
    conn.getProgramAccounts(DOMAINS_PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: bs58Discriminator(ACCOUNT_DISCRIMINATORS.domain),
          },
        },
      ],
    }),
    fetchPrimary(conn, wallet.pubkey),
    fetchListings(conn),
  ]);

  const owner = wallet.pubkey.toBase58();
  const domains = mapOwnedDomains(
    accounts.map(({ pubkey, account }) => ({
      pubkey: pubkey.toBase58(),
      data: account.data as Buffer,
    })),
    owner,
    primary,
  );
  const listedForSale = mapListedDomains(listings, owner);

  return {
    wallet: owner,
    primary: primary ? displayName(primary) : null,
    count: domains.length,
    domains,
    listedForSale,
    listedCount: listedForSale.length,
    ...(domains.length === 0 && listedForSale.length === 0
      ? { note: `this wallet owns no .cook names — register one at ${COOKOVEN_SITE_URL}` }
      : domains.length === 0
        ? {
            note:
              `every .cook name this wallet controls is listed for sale, so the registry reports the ` +
              `marketplace escrow as their owner — cancel_domain_listing takes one back`,
          }
        : primary === null
          ? {
              note: "no primary name is set — set_primary_domain makes one the wallet's default label",
            }
          : primary !== null && listedForSale.some((l) => l.label === primary)
            ? {
                note:
                  `⚠️ this wallet's primary name (${displayName(primary)}) is listed for sale, so the ` +
                  "primary record points at a name the registry no longer says it owns — clear it with " +
                  "set_primary_domain { clear: true }, or cancel the listing",
              }
            : {}),
  };
}

/** The wallet's own listings, cheapest-first. Pure, so the seller filter is unit-tested. */
export function mapListedDomains(listings: DecodedListing[], seller: string): ListedDomain[] {
  return listings
    .filter((l) => l.seller === seller)
    .sort((a, b) =>
      a.priceRaw === b.priceRaw ? a.name.localeCompare(b.name) : a.priceRaw < b.priceRaw ? -1 : 1,
    )
    .map((l) => ({
      name: displayName(l.name),
      label: l.name,
      priceCook: rawToUi(l.priceRaw, COOK_DECIMALS),
      priceLamports: l.priceRaw.toString(),
      listing: listingPda(new PublicKey(l.domain)).toBase58(),
      listedAt: new Date(l.createdAt * 1000).toISOString(),
    }));
}

/** base58 of an 8-byte account discriminator, for a getProgramAccounts memcmp filter. */
function bs58Discriminator(disc: readonly number[]): string {
  return bs58.encode(Buffer.from(disc));
}

function parseOwnPubkey(): PublicKey {
  const w = getWallet();
  if (!w) {
    throw new CookieMcpError(
      "no wallet address provided and no wallet configured",
      "pass a `wallet` address or .cook name, or set COOKIE_PRIVATE_KEY",
    );
  }
  return w.keypair.publicKey;
}

// --- Writes ----------------------------------------------------------------------------------------

/** Registry-flavoured `sendDomainTx`: every write below translates errors through `domainSimError`. */
function sendRegistryTx(
  conn: Connection,
  tx: Transaction,
  what: string,
  label?: string,
): Promise<string> {
  return sendDomainTx(conn, tx, what, (logs) => domainSimError(logs, label));
}

export interface RegisterDomainResult {
  signature: string;
  explorerUrl: string;
  name: string;
  account: string;
  owner: string;
  paid: string;
  tier: PriceTier;
  primarySet: boolean;
  note: string;
}

/**
 * Register a `.cook` name. The price is read live from the registry config and paid to its
 * `fee_receiver` inside the instruction — we never pass an amount, so `maxPriceCook` is a client-side
 * guard, not a program one. It is required because the price is admin-mutable and large: an agent
 * must state the number it is willing to spend before anything is signed.
 */
export async function registerDomain(args: {
  name: string;
  maxPriceCook?: string | number;
  setPrimary?: boolean;
}): Promise<RegisterDomainResult> {
  const { keypair } = requireWallet();
  const label = requireValidName(args.name);
  const conn = getConnection();

  const [cfg, existing] = await Promise.all([fetchDomainsConfig(conn), fetchDomain(conn, label)]);
  if (existing) {
    throw new CookieMcpError(
      `${displayName(label)} is already registered (owner ${existing.owner})`,
      "pick a different name — resolve_domain reports availability without spending anything",
    );
  }

  const price = priceView(cfg, label);
  const refusal = priceGuardError({ label, price, maxPriceCook: args.maxPriceCook });
  if (refusal) throw refusal;

  const tx = new Transaction().add(
    registerDomainIx({
      label,
      payer: keypair.publicKey,
      feeReceiver: new PublicKey(cfg.feeReceiver),
    }),
  );
  if (args.setPrimary) {
    tx.add(setPrimaryDomainIx({ label, owner: keypair.publicKey }));
  }

  const signature = await sendRegistryTx(conn, tx, "domain registration", label);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    name: displayName(label),
    account: domainPda(label).toBase58(),
    owner: keypair.publicKey.toBase58(),
    paid: `${price.priceCook} ${COOK_SYMBOL}`,
    tier: price.tier,
    primarySet: Boolean(args.setPrimary),
    note:
      "registration is permanent and non-refundable; the name has no expiry. " +
      (args.setPrimary
        ? "It is now this wallet's primary name."
        : "Use set_primary_domain to make it this wallet's default label."),
  };
}

export interface PrimaryDomainResult {
  signature: string;
  explorerUrl: string;
  wallet: string;
  primary: string | null;
  note: string;
}

/**
 * Point the wallet's `["primary", owner]` record at one of its names, or clear it. Clearing leaves
 * the account in place with an empty name — which is why a wallet can have the account and still
 * have no primary.
 */
export async function setPrimaryDomain(args: {
  name?: string;
  clear?: boolean;
}): Promise<PrimaryDomainResult> {
  const { keypair } = requireWallet();
  const conn = getConnection();
  const owner = keypair.publicKey;

  if (args.clear) {
    const current = await fetchPrimary(conn, owner);
    if (current === null) {
      throw new CookieMcpError(
        "this wallet has no primary .cook name to clear",
        "nothing to do — get_owned_domains shows the current primary",
      );
    }
    const tx = new Transaction().add(clearPrimaryDomainIx({ owner }));
    const signature = await sendRegistryTx(conn, tx, "clearing the primary domain");
    return {
      signature,
      explorerUrl: explorerTxUrl(signature),
      wallet: owner.toBase58(),
      primary: null,
      note: `${displayName(current)} is no longer this wallet's primary name; the wallet still owns it`,
    };
  }

  if (!args.name) {
    throw new CookieMcpError(
      "no name given",
      "pass `name` to set a primary .cook name, or `clear: true` to unset the current one",
    );
  }
  const label = requireValidName(args.name);
  const domain = await fetchDomain(conn, label);
  if (!domain) {
    throw new CookieMcpError(
      `${displayName(label)} is not registered`,
      "you can only make a name your primary if you own it — register_domain claims a free one",
    );
  }
  if (isEscrowed(domain)) {
    throw await escrowedNameError(conn, label, "set it as this wallet's primary", owner);
  }
  if (domain.owner !== owner.toBase58()) {
    throw new CookieMcpError(
      `${displayName(label)} is owned by ${domain.owner}, not this wallet`,
      "get_owned_domains lists the names this wallet can set as primary",
    );
  }

  const tx = new Transaction().add(setPrimaryDomainIx({ label, owner }));
  const signature = await sendRegistryTx(conn, tx, "setting the primary domain", label);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    wallet: owner.toBase58(),
    primary: displayName(label),
    note: "wallets that do a reverse lookup will now show this name instead of the raw address",
  };
}

export interface TransferDomainResult {
  signature: string;
  explorerUrl: string;
  name: string;
  from: string;
  to: string;
  toName: string | null;
  primaryCleared: boolean;
  note: string;
}

/**
 * Hand a name to another wallet. When the name is the sender's primary we use
 * `transfer_domain_with_primary_cleanup`, otherwise the sender would keep a primary record pointing
 * at a name they no longer own. The recipient may itself be given as a `.cook` name.
 */
export async function transferDomain(args: {
  name: string;
  to: string;
}): Promise<TransferDomainResult> {
  const { keypair } = requireWallet();
  const label = requireValidName(args.name);
  const conn = getConnection();
  const owner = keypair.publicKey;

  const [domain, recipient] = await Promise.all([
    fetchDomain(conn, label),
    resolveWallet(args.to, "recipient"),
  ]);
  if (!domain) {
    throw new CookieMcpError(
      `${displayName(label)} is not registered, so there is nothing to transfer`,
      "check the name with resolve_domain",
    );
  }
  if (isEscrowed(domain)) {
    throw await escrowedNameError(conn, label, "transfer it", owner);
  }
  if (domain.owner !== owner.toBase58()) {
    throw new CookieMcpError(
      `${displayName(label)} is owned by ${domain.owner}, not this wallet`,
      "only the owner can transfer a name",
    );
  }
  if (domain.legacy) {
    throw new CookieMcpError(
      `${displayName(label)} uses a pre-resolver account layout the program can no longer deserialize`,
      "this name can be read but not transferred or updated",
    );
  }

  const primary = await fetchPrimary(conn, owner);
  const withCleanup = transferNeedsPrimaryCleanup(label, primary);

  const tx = new Transaction().add(
    transferDomainIx({ label, currentOwner: owner, newOwner: recipient.pubkey, withCleanup }),
  );
  const signature = await sendRegistryTx(conn, tx, "domain transfer", label);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    name: displayName(label),
    from: owner.toBase58(),
    to: recipient.pubkey.toBase58(),
    toName: recipient.name,
    primaryCleared: withCleanup,
    note:
      "the transfer is final — only the new owner can move it again." +
      (withCleanup ? " It was this wallet's primary name, so that record was cleared too." : ""),
  };
}

export interface UpdateDomainResult {
  signature: string;
  explorerUrl: string;
  name: string;
  resolver: string | null;
  metadata: string | null;
  note: string;
}

/**
 * Set (or unset) the domain's `resolver` / `metadata` pointers — two free-form pubkey fields the
 * program stores and never interprets. Pass `"none"` to clear one. Both are unused across the whole
 * live registry today; they exist for apps that want to hang their own account off a name.
 */
export async function updateDomain(args: {
  name: string;
  resolver?: string;
  metadata?: string;
}): Promise<UpdateDomainResult> {
  const { keypair } = requireWallet();
  const label = requireValidName(args.name);
  if (args.resolver === undefined && args.metadata === undefined) {
    throw new CookieMcpError(
      "nothing to update",
      'pass `resolver` and/or `metadata` — a base58 address, or "none" to clear the pointer',
    );
  }
  const conn = getConnection();
  const owner = keypair.publicKey;

  const domain = await fetchDomain(conn, label);
  if (!domain) {
    throw new CookieMcpError(`${displayName(label)} is not registered`, "check the name first");
  }
  if (isEscrowed(domain)) {
    throw await escrowedNameError(conn, label, "update its pointers", owner);
  }
  if (domain.owner !== owner.toBase58()) {
    throw new CookieMcpError(
      `${displayName(label)} is owned by ${domain.owner}, not this wallet`,
      "only the owner can update a name",
    );
  }
  if (domain.legacy) {
    throw new CookieMcpError(
      `${displayName(label)} uses a pre-resolver account layout the program can no longer deserialize`,
      "this name can be read but not transferred or updated",
    );
  }

  const parsePointer = (value: string, field: string): PublicKey => {
    if (value.trim().toLowerCase() === "none") return PublicKey.default;
    try {
      return new PublicKey(value.trim());
    } catch {
      throw new CookieMcpError(
        `invalid ${field} "${value}"`,
        'pass a base58 address, or "none" to clear it',
      );
    }
  };

  const tx = new Transaction();
  let resolver = domain.resolver;
  let metadata = domain.metadata;
  if (args.resolver !== undefined) {
    const value = parsePointer(args.resolver, "resolver");
    tx.add(updateDomainPointerIx({ label, owner, field: "resolver", value }));
    resolver = value.equals(PublicKey.default) ? null : value.toBase58();
  }
  if (args.metadata !== undefined) {
    const value = parsePointer(args.metadata, "metadata");
    tx.add(updateDomainPointerIx({ label, owner, field: "metadata", value }));
    metadata = value.equals(PublicKey.default) ? null : value.toBase58();
  }

  const signature = await sendRegistryTx(conn, tx, "domain update", label);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    name: displayName(label),
    resolver,
    metadata,
    note: "the program stores these pointers without interpreting them",
  };
}
