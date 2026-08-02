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
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";

import {
  COOKOVEN_SITE_URL,
  COOK_DECIMALS,
  COOK_SYMBOL,
  explorerAddressUrl,
  explorerTxUrl,
} from "../config";
import { confirmSent } from "../confirm";
import { CookieMcpError } from "../errors";
import { rawToUi, uiToRaw } from "../format";
import { getConnection } from "../rpc";
import { getWallet, requireWallet } from "../wallet";
import {
  ACCOUNT_DISCRIMINATORS,
  clearPrimaryDomainIx,
  configPda,
  decodeDomainAccount,
  decodeDomainsConfigAccount,
  decodePrimaryAccount,
  domainPda,
  domainSimError,
  DOMAINS_PROGRAM_ID,
  primaryPda,
  registerDomainIx,
  setPrimaryDomainIx,
  transferDomainIx,
  transferNeedsPrimaryCleanup,
  updateDomainPointerIx,
  type DecodedDomain,
} from "./program";
import {
  displayName,
  looksLikeName,
  nameError,
  normalizeName,
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

/** Reject a name locally before it can turn into a PDA seed error or a wasted round trip. */
function requireValidName(input: string): string {
  const label = normalizeName(input);
  const err = nameError(label);
  if (err) {
    throw new CookieMcpError(
      `"${input}" is not a valid .cook name — ${err}`,
      "names are 1–32 characters of a-z, 0-9 and hyphens, with no leading or trailing hyphen; " +
        "the .cook suffix is optional and case is ignored",
    );
  }
  return label;
}

export async function fetchDomainsConfig(conn: Connection): Promise<DomainsConfig> {
  const info = await conn.getAccountInfo(configPda());
  const cfg = info && decodeDomainsConfigAccount(info.data as Buffer);
  if (!cfg) {
    throw new CookieMcpError(
      "could not read the .cook name registry config",
      `the cookie_domains program (${DOMAINS_PROGRAM_ID.toBase58()}) may not be reachable on this ` +
        "RPC — check COOKIE_RPC_URL",
    );
  }
  return cfg;
}

async function fetchDomain(conn: Connection, label: string): Promise<DecodedDomain | null> {
  const info = await conn.getAccountInfo(domainPda(label));
  return info ? decodeDomainAccount(info.data as Buffer) : null;
}

/** The wallet's current primary name, or null when it has never set one / has cleared it. */
async function fetchPrimary(conn: Connection, owner: PublicKey): Promise<string | null> {
  const info = await conn.getAccountInfo(primaryPda(owner));
  if (!info) return null;
  return decodePrimaryAccount(info.data as Buffer)?.name ?? null;
}

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
  note?: string;
}

/**
 * Forward lookup: `bot.cook` → who owns it. When the name is free it returns the live registration
 * price instead of an owner, so an agent can answer "is X available and what does it cost?" in one
 * call.
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
      note: `${base.name} is available — register_domain claims it, or register it at ${COOKOVEN_SITE_URL}`,
    };
  }

  const owner = new PublicKey(domain.owner);
  const primary = await fetchPrimary(conn, owner);
  return {
    ...base,
    registered: true,
    owner: domain.owner,
    ownerUrl: explorerAddressUrl(domain.owner),
    isOwnersPrimary: primary === label,
    resolver: domain.resolver,
    metadata: domain.metadata,
    createdAt: domain.createdAt ? new Date(domain.createdAt * 1000).toISOString() : null,
    price: null,
    ...(domain.legacy
      ? {
          note:
            "this domain uses a pre-resolver account layout the current program can no longer " +
            "deserialize — it can be read but not transferred or updated",
        }
      : {}),
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

export interface OwnedDomainsResult {
  wallet: string;
  primary: string | null;
  count: number;
  domains: OwnedDomain[];
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
 */
export async function getOwnedDomains(walletInput?: string): Promise<OwnedDomainsResult> {
  const wallet = walletInput
    ? await resolveWallet(walletInput, "wallet")
    : { pubkey: parseOwnPubkey(), name: null };
  const conn = getConnection();

  const [accounts, primary] = await Promise.all([
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

  return {
    wallet: owner,
    primary: primary ? displayName(primary) : null,
    count: domains.length,
    domains,
    ...(domains.length === 0
      ? { note: `this wallet owns no .cook names — register one at ${COOKOVEN_SITE_URL}` }
      : primary === null
        ? {
            note: "no primary name is set — set_primary_domain makes one the wallet's default label",
          }
        : {}),
  };
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

// --- Name-aware address resolution ----------------------------------------------------------------

export interface ResolvedWallet {
  pubkey: PublicKey;
  /** The `.cook` name the address came from, when the caller passed one. */
  name: string | null;
}

/**
 * Accept either a base58 address or a `.cook` name anywhere a Cookie Chain wallet is expected.
 *
 * Costs nothing on the happy path: a well-formed pubkey never touches the network. Only an input
 * that cannot be a pubkey (or that explicitly ends in `.cook`) triggers the PDA read.
 */
export async function resolveWallet(input: string, label: string): Promise<ResolvedWallet> {
  const s = input.trim();
  if (!looksLikeName(s)) {
    try {
      return { pubkey: new PublicKey(s), name: null };
    } catch {
      throw new CookieMcpError(
        `invalid ${label}: ${input}`,
        "pass a base58 address or a .cook name",
      );
    }
  }

  const name = requireValidName(s);
  const domain = await fetchDomain(getConnection(), name);
  if (!domain) {
    throw new CookieMcpError(
      `${displayName(name)} is not registered, so it does not resolve to an address`,
      `check the spelling with resolve_domain, or claim it with register_domain`,
    );
  }
  return { pubkey: new PublicKey(domain.owner), name: displayName(name) };
}

// --- Writes ----------------------------------------------------------------------------------------

/**
 * Simulate → sign → send → confirm, with `.cook`-specific error translation. Same safety contract as
 * every other write in this repo: nothing is signed until the simulation passes.
 */
async function sendDomainTx(
  conn: Connection,
  tx: Transaction,
  what: string,
  label?: string,
): Promise<string> {
  const { keypair } = requireWallet();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;

  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    if (/BlockhashNotFound|blockhash/i.test(blob)) {
      throw new CookieMcpError(
        `${what} simulation failed: blockhash not found`,
        "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
      );
    }
    const translated = domainSimError(logs, label);
    throw new CookieMcpError(
      `${what} failed: ${translated ?? (logs.slice(-2).join(" | ") || JSON.stringify(sim.value.err))}`,
      "nothing was signed or sent",
    );
  }

  tx.sign(keypair);
  const signature = await conn.sendRawTransaction(tx.serialize());
  return confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, what);
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

  const signature = await sendDomainTx(conn, tx, "domain registration", label);
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
    const signature = await sendDomainTx(conn, tx, "clearing the primary domain");
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
  if (domain.owner !== owner.toBase58()) {
    throw new CookieMcpError(
      `${displayName(label)} is owned by ${domain.owner}, not this wallet`,
      "get_owned_domains lists the names this wallet can set as primary",
    );
  }

  const tx = new Transaction().add(setPrimaryDomainIx({ label, owner }));
  const signature = await sendDomainTx(conn, tx, "setting the primary domain", label);
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
  const signature = await sendDomainTx(conn, tx, "domain transfer", label);
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

  const signature = await sendDomainTx(conn, tx, "domain update", label);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    name: displayName(label),
    resolver,
    metadata,
    note: "the program stores these pointers without interpreting them",
  };
}
