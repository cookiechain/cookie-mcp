// MomoSwap launchpad HTTP client (api.momoswap.fun). Read endpoints return decoded on-chain state;
// the `tx/*` endpoints return a base64 **legacy** Transaction that is already partial-signed (the
// mint/vault keypairs for a launch) with the blockhash set — the caller simulates, adds the wallet
// signature and sends. Nothing here signs or holds funds.
import { MOMOSWAP_API_URL } from "../config";
import { CookieMcpError } from "../errors";
import { fetchJson } from "../http";

const LP = `${MOMOSWAP_API_URL}/v1/launchpad`;

// IPFS pinning can be slow; give uploads more room than the default HTTP timeout.
const UPLOAD_TIMEOUT_MS = 30_000;

/**
 * Pool lifecycle as the API reports it (`status`, derived from state + timestamps).
 *
 * `ended` = on-chain still `Open`/`Created` but past `end_ts`: trading is over and nothing has
 * settled the pool yet, so it is neither tradeable nor claimable. The API used to report that window
 * as `live`, which is why `poolPhase()` derives it locally too — it now agrees with the API instead
 * of correcting it, and both spellings map to the same phase.
 */
export type PoolStatus = "upcoming" | "live" | "ended" | "graduated" | "expired";
export type ExpiryMode = "dead" | "fair" | "jackpot" | "survivor";
export type ClaimKind = "fair" | "winner" | "graduated_tokens" | "creator_vest";

/** Global launchpad economics (admin-tunable; every pool snapshots these at creation). */
export interface LaunchpadConfig {
  paymentMint: string;
  tradeFeeBps: number;
  treasuryFeeBps: number;
  creatorFeeBps: number;
  referralFeeBps: number;
  buybackFeeBps: number;
  creationFeeLamports: string;
  graduationTarget: string;
  graduationFee: string;
  creatorVestBps: number;
  defaultTokenDecimals: number;
  defaultTotalSupply: string;
  defaultSaleSupply: string;
  paused: boolean;
  /** How many pre-ground `momo` mints the API has in reserve (0 → launches are unavailable). */
  momoReady?: number;
}

/** A launchpad pool (bonding curve). Raw u64 fields come back as decimal strings. */
export interface LaunchpadPool {
  pubkey: string;
  creator: string;
  poolId: string;
  name: string;
  symbol: string;
  uri: string;
  tokenMint: string;
  paymentMint: string;
  tokenVault: string;
  paymentVault: string;
  launchTs: number;
  endTs: number;
  durationSecs: number;
  expiryMode: ExpiryMode;
  migratable: boolean;
  antiSnipe: boolean;
  state: string;
  status: PoolStatus;
  minBuy: string;
  maxBuyPerWallet: string;
  maxPaymentRaise: string;
  totalTokenSupply: string;
  saleTokenSupply: string;
  virtualPaymentReserve: string;
  virtualTokenReserve: string;
  tokensSold: string;
  totalActiveShares: string;
  paymentRaisedGross: string;
  paymentRaisedNet: string;
  participantCount: string;
  expiryLiquidity: string;
  totalExpiryShares: string;
  settlementRootSet: boolean;
  graduatedAt: number;
  creatorVestAmount: string;
  creatorVestClaimed: string;
  creatorVestStart: number;
  creatorVestEnd: number;
  graduationTarget: string;
  // --- economics SNAPSHOTTED onto the pool at create_pool -----------------------------------------
  // A pool keeps the fee schedule it launched with, so a later admin `update_config` cannot re-price
  // it. Resolve these through `./fees` (never read the `/config` value for a pool) — and note they are
  // OPTIONAL: the deployed API predates the release that serializes them, so today they are absent and
  // every resolution falls back to `/config`.
  tradeFeeBps?: number;
  treasuryFeeBps?: number;
  creatorFeeBps?: number;
  referralFeeBps?: number;
  buybackFeeBps?: number;
  lpBurnBps?: number;
  creatorVestBps?: number;
  /** i64 seconds — the pool's own linear creator-vest duration. */
  creatorVestSeconds?: string;
}

/** A wallet's bonding-curve position. `shares` are program-tracked, NOT SPL tokens. */
export interface LaunchpadPosition {
  pool: string;
  owner: string;
  shares: string;
  totalPaymentIn: string;
  totalPaymentOut: string;
  claimed: boolean;
  winnerClaimed: boolean;
  graduatedTokensClaimed: boolean;
}

/** Off-chain token metadata JSON — the API pins it to IPFS and writes the CID as the on-chain uri. */
export interface LaunchpadMetadata {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  extensions?: Record<string, string>;
}

/** On-chain `PoolParams`, minus `pool_id` (the API mints a random one) — snake_case per the IDL. */
export interface CreatePoolParams {
  name: string;
  symbol: string;
  launch_ts: number;
  duration_secs: number;
  expiry_mode: ExpiryMode;
  migratable: boolean;
  anti_snipe: boolean;
  min_buy: string;
  max_buy_per_wallet: string;
  max_payment_raise: string;
}

/** A built, partial-signed transaction plus the blockhash window to confirm it against. */
export interface BuiltTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** create-pool only: the leased `momo` mint the token will be created at. */
  mint?: string;
}

type Envelope<T> = T & { success?: boolean; error?: string };

function unwrap<T>(res: Envelope<T>, what: string): T {
  if (res.success === false) {
    throw new CookieMcpError(res.error ?? `${what} failed`, "check the inputs and retry");
  }
  return res;
}

async function get<T>(path: string, what: string): Promise<T> {
  return unwrap(await fetchJson<Envelope<T>>(`${LP}${path}`), what);
}

async function post<T>(path: string, body: unknown, what: string, timeoutMs?: number): Promise<T> {
  return unwrap(
    await fetchJson<Envelope<T>>(`${LP}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
    what,
  );
}

export async function fetchLaunchpadConfig(): Promise<LaunchpadConfig> {
  const { config } = await get<{ config: LaunchpadConfig }>("/config", "launchpad config");
  return config;
}

/** One page of `GET /pools`. Every pagination field is absent on deployments that predate paging. */
export interface PoolPage {
  pools?: LaunchpadPool[];
  /** Rows in THIS response. */
  count?: number;
  /** Rows matching the filter across all pages. */
  total?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
}

// Backstop on the page walk. 500 is the server's own `limit` ceiling, so this covers 20k pools —
// orders of magnitude past anything real, and it bounds a server that reports `hasMore` forever.
const MAX_POOL_PAGES = 40;

/**
 * Where the next `/pools` page starts, or null when the walk is done (pure).
 *
 * A `hasMore` with no usable, strictly-advancing cursor would loop forever, so it stops instead: a
 * short list is recoverable, a hung stdio server is not.
 */
export function nextPoolOffset(
  page: Pick<PoolPage, "hasMore" | "nextOffset">,
  requestedOffset: number,
): number | null {
  if (page.hasMore !== true) return null;
  const next = page.nextOffset;
  if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= requestedOffset)
    return null;
  return next;
}

/**
 * Every pool matching `status`, following pagination when the API pages.
 *
 * `limit` is deliberately NOT sent: it is opt-in server-side and omitting it returns the whole
 * filtered set in one round trip, which is what every caller here needs (both callers sort by
 * graduation progress, a key the server does not offer, so a server-side page would be the wrong
 * rows). The walk exists because a *default* page size would otherwise silently truncate the list —
 * `get_launchpad_positions` scans this list to discover which pools to check, so a missing page means
 * a position reported as absent, with no error. Offset paging is safe here only because the server
 * breaks every sort tie on `pubkey`; do not add a `sort` param without re-reading that guarantee.
 */
export async function fetchPools(status: PoolStatus | "all" = "all"): Promise<LaunchpadPool[]> {
  const all: LaunchpadPool[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_POOL_PAGES; page++) {
    const query = new URLSearchParams({ status });
    if (offset > 0) query.set("offset", String(offset));
    const res = await get<PoolPage>(`/pools?${query.toString()}`, "launchpad pools");
    all.push(...(res.pools ?? []));
    const next = nextPoolOffset(res, offset);
    if (next === null) return all;
    offset = next;
  }
  return all;
}

export async function fetchPoolByAddress(pool: string): Promise<LaunchpadPool> {
  const res = await get<{ pool: LaunchpadPool }>(`/pools/${pool}`, "launchpad pool");
  return res.pool;
}

/** Resolve a token mint to its pool (the API keeps a mint→pool index, falling back to a scan). */
export async function fetchPoolByMint(
  mint: string,
): Promise<{ poolAddress: string; pool: LaunchpadPool }> {
  return get<{ poolAddress: string; pool: LaunchpadPool }>(`/token/${mint}`, "launchpad token");
}

/** A wallet's curve position, or null when it never bought on this pool. */
export async function fetchPosition(
  pool: string,
  owner: string,
): Promise<LaunchpadPosition | null> {
  const res = await get<{ position: LaunchpadPosition | null }>(
    `/pools/${pool}/position/${owner}`,
    "launchpad position",
  );
  return res.position ?? null;
}

/** Unclaimed creator fees (the pool's creator_fee_vault balance), in UI COOK. */
export async function fetchPendingCreatorFees(pool: string): Promise<number> {
  const res = await get<{ pendingCook?: number }>(`/creator-fees/${pool}`, "pending creator fees");
  return res.pendingCook ?? 0;
}

/** Merkle payout + proof for a Jackpot/Survivor settlement, or null when this wallet didn't win. */
export async function fetchWinnerProof(
  pool: string,
  owner: string,
): Promise<{ amount: string; proof: number[][] } | null> {
  try {
    const res = await get<{ amount?: string; proof?: number[][] }>(
      `/pools/${pool}/winner/${owner}`,
      "winner proof",
    );
    return res.amount && res.proof ? { amount: res.amount, proof: res.proof } : null;
  } catch {
    return null;
  }
}

/** Pin a token image to IPFS; returns the https gateway URL to reference from the metadata JSON. */
export async function uploadImage(imageBase64: string, contentType: string): Promise<string> {
  const res = await post<{ url?: string }>(
    "/image",
    { imageBase64, contentType },
    "token image upload",
    UPLOAD_TIMEOUT_MS,
  );
  if (!res.url) {
    throw new CookieMcpError(
      "the launchpad did not return an image URL",
      "retry, or pass imageUrl with an already-hosted image instead",
    );
  }
  return res.url;
}

export async function buildCreatePoolTx(body: {
  creator: string;
  params: CreatePoolParams;
  metadata: LaunchpadMetadata;
  devBuyCook?: string;
}): Promise<BuiltTx> {
  return post<BuiltTx>("/tx/create-pool", body, "launch build", UPLOAD_TIMEOUT_MS);
}

export async function buildBuyTx(body: {
  buyer: string;
  pool: string;
  paymentAmount: string;
  referrer?: string | null;
}): Promise<BuiltTx> {
  return post<BuiltTx>("/tx/buy", body, "buy build");
}

export async function buildSellTx(body: {
  seller: string;
  pool: string;
  tokenShares: string;
  unwrap?: boolean;
}): Promise<BuiltTx> {
  return post<BuiltTx>("/tx/sell", body, "sell build");
}

export async function buildClaimTx(body: {
  kind: ClaimKind;
  claimant: string;
  pool: string;
  amount?: string;
  proof?: number[][];
}): Promise<BuiltTx> {
  return post<BuiltTx>("/tx/claim", body, "claim build");
}

export async function buildClaimCreatorFeesTx(body: {
  creator: string;
  pool: string;
  unwrap?: boolean;
}): Promise<BuiltTx> {
  return post<BuiltTx>("/tx/claim-creator-fees", body, "creator-fee claim build");
}
