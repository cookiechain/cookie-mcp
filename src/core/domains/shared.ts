// Reads and helpers shared by the two halves of the `.cook` module: the registry (`index.ts`) and the
// secondary market (`market.ts`). They live here so the dependency graph stays one-directional —
// `marketplace.ts` (pure) ← `shared.ts` ← `market.ts`, with `index.ts` on top of both. `index.ts`
// needs listing reads to stay escrow-aware and `market.ts` needs the registry's reads, so without
// this file the two would import each other.
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";

import { COOK_DECIMALS, COOK_SYMBOL } from "../config";
import { confirmSent } from "../confirm";
import { CookieMcpError } from "../errors";
import { rawToUi } from "../format";
import { getConnection } from "../rpc";
import { requireWallet } from "../wallet";
import { displayName, looksLikeName, nameError, normalizeName, type DomainsConfig } from "./names";
import {
  configPda,
  decodeDomainAccount,
  decodeDomainsConfigAccount,
  decodePrimaryAccount,
  domainPda,
  DOMAINS_PROGRAM_ID,
  primaryPda,
  type DecodedDomain,
} from "./program";
import {
  decodeListingAccount,
  ESCROW_AUTHORITY,
  listingPda,
  type DecodedListing,
} from "./marketplace";

/** Reject a name locally before it can turn into a PDA seed error or a wasted round trip. */
export function requireValidName(input: string): string {
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

export async function fetchDomain(conn: Connection, label: string): Promise<DecodedDomain | null> {
  const info = await conn.getAccountInfo(domainPda(label));
  return info ? decodeDomainAccount(info.data as Buffer) : null;
}

/** The wallet's current primary name, or null when it has never set one / has cleared it. */
export async function fetchPrimary(conn: Connection, owner: PublicKey): Promise<string | null> {
  const info = await conn.getAccountInfo(primaryPda(owner));
  if (!info) return null;
  return decodePrimaryAccount(info.data as Buffer)?.name ?? null;
}

/** The marketplace listing for one name, or null when it is not for sale. One PDA read, no scan. */
export async function fetchListing(
  conn: Connection,
  label: string,
): Promise<DecodedListing | null> {
  const info = await conn.getAccountInfo(listingPda(domainPda(label)));
  return info ? decodeListingAccount(info.data as Buffer) : null;
}

/**
 * Is this domain held by the marketplace escrow, i.e. listed for sale? A constant comparison, so
 * every caller can afford to ask before deciding whether the extra listing read is worth it.
 */
export function isEscrowed(domain: DecodedDomain): boolean {
  return domain.owner === ESCROW_AUTHORITY;
}

/**
 * The refusal for "you tried to act on a name that is sitting in the marketplace escrow". Only called
 * once `isEscrowed` is true, so the listing read costs nothing on the normal path.
 *
 * Worth being specific: the registry's own error here is `NotDomainOwner`, naming the escrow PDA as
 * the owner — an address the caller has never seen and cannot act on.
 */
export async function escrowedNameError(
  conn: Connection,
  label: string,
  action: string,
  wallet?: PublicKey,
): Promise<CookieMcpError> {
  const listing = await fetchListing(conn, label);
  const name = displayName(label);
  if (!listing) {
    return new CookieMcpError(
      `${name} is held by the .cook marketplace escrow (${ESCROW_AUTHORITY}) but has no listing`,
      "this should not happen — re-check with resolve_domain before acting on it",
    );
  }
  const mine = wallet !== undefined && listing.seller === wallet.toBase58();
  return new CookieMcpError(
    `${name} is listed for sale on the .cook marketplace for ` +
      `${rawToUi(listing.priceRaw, COOK_DECIMALS)} ${COOK_SYMBOL}, so the marketplace escrow holds ` +
      `it — you cannot ${action} while it is listed`,
    mine
      ? "cancel_domain_listing takes it out of escrow and returns it to this wallet"
      : `it is listed by ${listing.seller} — buy_domain is the only way to take ownership`,
  );
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
 * Costs nothing on the happy path: a well-formed pubkey never touches the network. Only an input that
 * cannot be a pubkey (or that explicitly ends in `.cook`) triggers the PDA read.
 *
 * ⚠️ A name that is LISTED FOR SALE is refused rather than resolved. Its registry record points at
 * the marketplace escrow PDA, which is a program-owned account with no signer — paying it would put
 * the funds somewhere nobody can spend them. Resolving it "successfully" would silently turn
 * `transfer to: "bot.cook"` into a burn.
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
  const conn = getConnection();
  const domain = await fetchDomain(conn, name);
  if (!domain) {
    throw new CookieMcpError(
      `${displayName(name)} is not registered, so it does not resolve to an address`,
      `check the spelling with resolve_domain, or claim it with register_domain`,
    );
  }
  if (isEscrowed(domain)) {
    const listing = await fetchListing(conn, name);
    throw new CookieMcpError(
      `${displayName(name)} is listed for sale on the .cook marketplace, so it currently points at ` +
        "the marketplace escrow account rather than a wallet — refusing to use it as an address",
      listing
        ? `its seller is ${listing.seller}; use that address directly if you meant to pay them`
        : "use a base58 address instead",
    );
  }
  return { pubkey: new PublicKey(domain.owner), name: displayName(name) };
}

// --- Sending --------------------------------------------------------------------------------------

/**
 * Simulate → sign → send → confirm, with `.cook`-specific error translation. Same safety contract as
 * every other write in this repo: nothing is signed until the simulation passes. `translate` turns the
 * simulation logs into an actionable message — the registry and the marketplace have separate error
 * tables, so each caller passes its own.
 */
export async function sendDomainTx(
  conn: Connection,
  tx: Transaction,
  what: string,
  translate: (logs: string[]) => string | null,
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
    const translated = translate(logs);
    throw new CookieMcpError(
      `${what} failed: ${translated ?? (logs.slice(-2).join(" | ") || JSON.stringify(sim.value.err))}`,
      "nothing was signed or sent",
    );
  }

  tx.sign(keypair);
  const signature = await conn.sendRawTransaction(tx.serialize());
  return confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, what);
}
