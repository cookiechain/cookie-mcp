// Baked Bazaar backend client (bakedbazaar.art/api). This is the marketplace's own indexer and the
// only viable source of active listings/offers/collections on Cookie Chain (no getProgramAccounts on
// the AH program; the DAS API indexes no listings). Reads only — every state change goes on-chain via
// the auction-house instructions; after we send one we POST /log-transaction so the indexer reflects
// it promptly (best-effort).
import { BAKED_BAZAAR_API_URL } from "../config";
import { fetchJson } from "../http";

export interface BazaarCreator {
  address: string;
  verified?: boolean;
  share?: number;
}
export interface BazaarNftMetadata {
  name?: string;
  symbol?: string;
  image?: string;
  description?: string;
  attributes?: Array<{ trait_type?: string; value?: unknown }>;
  creators?: BazaarCreator[];
  collection?: { key?: string; verified?: boolean };
  verified?: boolean;
}
// A listing (seller trade state). `price` is COOK lamports as a decimal string.
export interface BazaarListing {
  publicKey: string; // seller trade state PDA
  seller: string;
  nftMint: string;
  vault?: string;
  price: string;
  status: string; // "Active" | ...
  createdAt?: number;
  buyer?: string | null;
  sellerTokenAccount: string;
  metadata?: BazaarNftMetadata;
}
export interface BazaarOffer {
  id?: number;
  tradeState: string; // public-bid trade state PDA
  auctionHouse?: string;
  buyer: string;
  nftMint: string;
  price: string;
  tokenSize?: string;
  status: string; // "active" | "expired" | ...
  expiresAt?: string | null;
  txSignature?: string;
  createdAt?: string;
}
export interface BazaarNft {
  mint: string;
  listing: BazaarListing | null;
  metadata: BazaarNftMetadata | null;
  lastSale?: unknown;
  topOffer?: BazaarOffer | null;
  floorPrice?: string | null;
  collectionListings?: number;
  shareUrl?: string;
}
export interface BazaarStats {
  listingsCount?: number;
  floorPrice?: string;
  totalVolume?: string;
  volume24h?: string;
  salesCount?: number;
  salesCount24h?: number;
}
export interface BazaarCollectionStats {
  totalSupply?: number;
  holderCount?: number;
}
export interface BazaarUserNft {
  mint: string;
  metadata?: BazaarNftMetadata | null;
  listing?: BazaarListing | null;
  tokenAccount?: string;
  topOffer?: BazaarOffer | null;
}

const base = () => BAKED_BAZAAR_API_URL;
// The backend returns { error } with a 404 for "not found"; fetchJson turns non-2xx into a thrown
// CookieMcpError. Callers that treat "missing" as a normal empty result use `orNull`.
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function fetchListings(): Promise<BazaarListing[]> {
  const json = await fetchJson<BazaarListing[]>(`${base()}/listings`);
  return Array.isArray(json) ? json : [];
}
export async function fetchNft(mint: string): Promise<BazaarNft | null> {
  return orNull(fetchJson<BazaarNft>(`${base()}/nft/${encodeURIComponent(mint)}`));
}
export async function fetchUserNfts(wallet: string): Promise<BazaarUserNft[]> {
  const json = await orNull(fetchJson<BazaarUserNft[]>(`${base()}/user-nfts/${wallet}`));
  return Array.isArray(json) ? json : [];
}
export async function fetchOffersBy(wallet: string): Promise<BazaarOffer[]> {
  const json = await orNull(fetchJson<BazaarOffer[]>(`${base()}/offers/by/${wallet}`));
  return Array.isArray(json) ? json : [];
}
export async function fetchOffersReceived(wallet: string): Promise<BazaarOffer[]> {
  const json = await orNull(fetchJson<BazaarOffer[]>(`${base()}/offers/received/${wallet}`));
  return Array.isArray(json) ? json : [];
}
export async function fetchStats(): Promise<BazaarStats | null> {
  return orNull(fetchJson<BazaarStats>(`${base()}/stats`));
}
export async function fetchCollectionStats(symbol: string): Promise<BazaarCollectionStats | null> {
  return orNull(
    fetchJson<BazaarCollectionStats>(`${base()}/collection-stats/${encodeURIComponent(symbol)}`),
  );
}

// Best-effort: tell the indexer about a signed+confirmed tx so listings/offers update without waiting
// for its own tx scan. Never throws — indexing lag must not fail a successful on-chain action.
export async function logTransaction(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetchJson(`${base()}/log-transaction`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    /* indexing is best-effort */
  }
}
