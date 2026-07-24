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

/** Pool lifecycle as the API reports it (`status`, derived from state + timestamps). */
export type PoolStatus = "upcoming" | "live" | "graduated" | "expired";
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

export async function fetchPools(status: PoolStatus | "all" = "all"): Promise<LaunchpadPool[]> {
  const { pools } = await get<{ pools: LaunchpadPool[] }>(
    `/pools?status=${encodeURIComponent(status)}`,
    "launchpad pools",
  );
  return pools ?? [];
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
