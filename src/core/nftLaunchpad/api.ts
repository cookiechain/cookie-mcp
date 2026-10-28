// HTTP client for MomoSwap's NFT launchpad API (`/v1/nft/*` on the same host as the token launchpad).
//
// Same "Architecture B" as the token launchpad: reads serve chain state and quotes, and every write
// comes back as a finished, possibly partial-signed LEGACY transaction (`transactionBase64` plus the
// blockhash window). The API never submits anything; `index.ts` verifies, simulates, signs and sends.
//
// Launching a drop is session-gated: `/art`, `/drops`, `/tx/create` and `/tx/reveal` take the same
// wallet-signed login as the token launchpad's create-pool (one SocialStore), but as a Bearer header
// rather than a body field. Every other route is public; never attach a session to those.
import { MOMOSWAP_API_URL } from "../config";
import { CookieMcpError } from "../errors";
import { fetchJson } from "../http";

const NFT = `${MOMOSWAP_API_URL}/v1/nft`;

/** Art and the sealed drop are uploads; the API pins them to IPFS before it answers. */
const UPLOAD_TIMEOUT_MS = 90_000;

/** API lifecycle: `active` = on-chain Created or Live; `closed` = ended short and closed. */
export type NftDropState = "active" | "graduated" | "closed";
export type NftDropFilter = "live" | "upcoming" | "minting" | "graduated" | "ended" | "all";

export interface NftGraduation {
  /** `sellout`: graduates when every unit is minted. `target`: at a raise below that (anchor #92). */
  model: "sellout" | "target";
  targetRaw: string;
  selloutRaiseRaw: string;
  targetBps: number | null;
  raisedRaw: string;
  progressBps: number;
  unitsToTarget: number | null;
  graduated: boolean;
  graduatedAt: number | null;
}

export interface NftPostGraduation {
  /** Whether units are still mintable at random through `request_mint`. */
  open: boolean;
  remaining?: string;
  requestPriceRaw?: string | null;
  pending?: number;
  [k: string]: unknown;
}

export interface NftCollection {
  /** The collection PDA. */
  address: string;
  collectionMint: string;
  creator: string;
  paymentMint: string;
  name: string;
  symbol: string;
  baseUri: string;
  collectionUri: string;
  state: NftDropState;
  totalSupply: string;
  minted: string;
  inventory: string;
  burned: string;
  circulating: string;
  remaining: string;
  available: string;
  launchTs: number;
  endTs: number;
  maxPerWallet: string;
  allowlistEndTs: number;
  hasAllowlist: boolean;
  /** "The art is out" (published folder or on-chain reveal), not the raw chain flag. */
  revealed: boolean;
  revealedOnChain: boolean;
  antiSnipe: boolean;
  floorLockBps: number;
  floorReserve: string;
  floorRedeemable: string;
  floorPriceRaw: string;
  sellerFeeBps: number;
  royaltyPartner: string;
  partnerShareBps: number;
  windDown: { available: boolean; needsClose: boolean; priceRaw: string };
  graduation?: NftGraduation;
  postGraduation: NftPostGraduation | null;
  /** Detail only: the creator vault balance `claim_creator_proceeds` would pay out. */
  creatorProceedsRaw?: string | null;
  profile?: {
    image?: string | null;
    banner?: string | null;
    description?: string | null;
    website?: string | null;
    x?: string | null;
    telegram?: string | null;
    discord?: string | null;
  };
}

export interface NftStatus {
  deployed: boolean;
  /** Launches and mints open. Exits (sell, redeem, claim) are built regardless — see `exits`. */
  writable: boolean;
  exits: boolean;
  paused?: boolean;
  tradeFeeBps?: number | null;
  platformShareBps?: number | null;
  platformRoyaltyBps?: number | null;
  maxSellerFeeBps?: number | null;
  /** Highest creator royalty a new drop can carry, or null when none fits. */
  maxCreatorRoyaltyBps?: number | null;
  royaltyHardCapBps?: number;
  maxStartAheadSeconds?: number;
  /** Longest mint window (`end_ts - launch_ts`) a new drop may have; the program's cap is 30 days (#113). */
  maxSaleWindowSeconds?: number;
  /** Whose ATA holds a new drop's collection NFT: the creator's (live binary) or the program's (#111). */
  collectionNftHolder?: "creator" | "program";
  targetGraduation?: boolean;
  targetGraduationLimits?: { minBps: number; maxBps: number; maxSupply: number };
  storage?: { provider: string; configured: boolean; reachable: boolean | null };
}

export interface NftBuyQuote {
  side: "buy";
  units: number;
  costRaw: string;
  feeRaw: string;
  totalRaw: string;
  maxCostRaw: string;
  available: string;
  unitCostsRaw?: string[];
  nextCostRaw?: string;
  notStarted?: boolean;
  opensAt?: number;
}

export interface NftSellQuote {
  side: "sell";
  units: number;
  grossRaw: string;
  feeRaw: string;
  netRaw: string;
  minProceedsRaw: string;
  available: string;
}

export interface NftOwnerItems {
  deployed?: boolean;
  items: string[];
  details?: { mint: string; name: string; uri: string }[];
}

/** One NFT build: a legacy transaction, partial-signed by the API where it introduces a fresh mint. */
export interface NftBuiltTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface NftBuiltBuy extends NftBuiltTx {
  /** The item this buy mints (a fresh keypair the API signed with), or the pool unit it sells. */
  nftMint: string;
  returned?: true;
  totalRaw: string;
  costRaw: string;
  feeRaw: string;
  /** The cost-leg cap, as the quote states it. Not what the instruction carries. */
  maxCostRaw: string;
  /** The `max_cost` the instruction carries: the cap plus its fee (momoswap-backend#333), ≤ `maxSpendRaw`. */
  maxCostAllInRaw?: string;
  maxSpendRaw: string;
  slippageClamped?: true;
  graduatesDrop?: true;
}

export interface NftBuiltRequest extends NftBuiltTx {
  /** The buyer's `MintRequest` PDA, reused for every request this wallet makes on this drop. */
  request: string;
  /** The nonce this request gets is at least this; it picks the request out of the PDA's history. */
  minNonce: string;
  costRaw: string;
  feeRaw: string;
  totalRaw: string;
  /** The cost-leg cap, as the quote states it. Not what the instruction carries. */
  maxCostRaw: string;
  /** The `max_cost` the instruction carries: the cap plus its fee (momoswap-backend#333), ≤ `maxSpendRaw`. */
  maxCostAllInRaw?: string;
  maxSpendRaw: string;
  /** Requests already waiting ahead of this one. */
  queueAhead: string;
  remaining: string;
  deposits?: {
    itemDepositLamports: string;
    requestRentLamports: string;
    queueRentLamports: string;
  };
}

export interface NftBuiltSell extends NftBuiltTx {
  grossRaw: string;
  feeRaw: string;
  netRaw: string;
  minProceedsRaw: string;
}

export interface NftBuiltWindDown extends NftBuiltTx {
  priceRaw: string;
  closesDrop: boolean;
  closeRace?: { instructionIndex: number; programError: number; retryWith: { skipClose: true } };
}

export interface NftBuiltClaim extends NftBuiltTx {
  unwrapped: boolean;
}

export interface NftBuiltCreate extends NftBuiltTx {
  mint: string;
  collection: string;
  graduationTarget: { targetRaw: string; bps: number; selloutRaiseRaw: string } | null;
}

/** The queue head a settle build acts on, and the item drawn for it. */
export interface NftBuiltSettle extends NftBuiltTx {
  request: string;
  buyer: string;
  nonce: string;
  index: number;
  itemMint: string;
}

/** The queue head a refund build acts on, and what goes back to its buyer (price plus fee). */
export interface NftBuiltRefund extends NftBuiltTx {
  request: string;
  buyer: string;
  nonce: string;
  amountRaw: string;
}

/** `GET /request/:pda`: one post-graduation mint request, by how far it got. */
export interface NftMintRequestView {
  request: string;
  status: "none" | "pending" | "settled" | "refunded";
  nonce?: string;
  /** Settled: the item drawn for it. */
  itemMint?: string;
  index?: number;
  /** Refunded: what went back to the buyer. */
  amountRaw?: string;
  /** Pending: its place in the queue (0 = next) and whether it can still settle. */
  queuePosition?: number | null;
  ready?: boolean;
  expired?: boolean;
}

/** `CollectionParams` as the API takes it: snake_case, u64s as decimal strings. */
export interface NftCollectionParams {
  name: string;
  symbol: string;
  base_uri: string;
  collection_uri: string;
  total_supply: string;
  virtual_payment_reserve: string;
  virtual_nft_reserve: string;
  launch_ts: number;
  end_ts: number;
  max_per_wallet: string;
  anti_snipe: boolean;
  allowlist_end_ts: number;
  commitment: string;
  seller_fee_bps: number;
  royalty_partner: string | null;
  partner_share_bps: number;
  floor_lock_bps: number;
}

export interface SealDropRequest {
  creator: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  banner: string | null;
  placeholder: string;
  extensions: Record<string, string>;
  items: {
    image: string;
    type: string | null;
    name: string | null;
    attributes: { trait_type: string; value: string }[];
  }[];
  sellerFeeBps: number;
  graduationTargetBps?: number;
}

export interface SealedDrop {
  dropId: string;
  /** The collection mint, fixed at seal: the create is signed with its key, held by the API. */
  mint: string;
  baseUri: string;
  collectionUri: string;
  commitment: string;
  graduationTargetBps?: number | null;
}

type Envelope<T> = T & { success?: boolean; error?: string; message?: string };

function unwrap<T>(res: Envelope<T>, what: string): T {
  if (res.success === false) {
    throw new CookieMcpError(
      res.message ?? res.error ?? `${what} failed`,
      "check the inputs and retry",
    );
  }
  return res;
}

async function get<T>(path: string, what: string): Promise<T> {
  return unwrap(await fetchJson<Envelope<T>>(`${NFT}${path}`), what);
}

async function post<T>(
  path: string,
  body: unknown,
  what: string,
  opts: { session?: string; timeoutMs?: number } = {},
): Promise<T> {
  return unwrap(
    await fetchJson<Envelope<T>>(`${NFT}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      ...(opts.session ? { headers: { Authorization: `Bearer ${opts.session}` } } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    }),
    what,
  );
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function fetchNftStatus(): Promise<NftStatus> {
  return get<NftStatus>("/status", "NFT launchpad status");
}

export async function fetchNftCollections(
  status: NftDropFilter = "all",
  limit = 60,
): Promise<NftCollection[]> {
  const q = new URLSearchParams({ status, limit: String(limit) });
  const res = await get<{ collections?: NftCollection[] }>(`/collections?${q}`, "NFT drop list");
  return res.collections ?? [];
}

export async function fetchNftCollection(collectionMint: string): Promise<NftCollection> {
  const res = await get<{ collection?: NftCollection }>(
    `/collection/${encodeURIComponent(collectionMint)}`,
    "NFT drop",
  );
  if (!res.collection) {
    throw new CookieMcpError(
      `no MomoSwap NFT drop for collection ${collectionMint}`,
      "pass the drop's collection mint (get_nft_drops lists them)",
    );
  }
  return res.collection;
}

export async function fetchNftBuyQuote(
  collectionMint: string,
  count: number,
  slippageBps?: number,
): Promise<NftBuyQuote> {
  const q = new URLSearchParams({ side: "buy", count: String(count) });
  if (slippageBps !== undefined) q.set("slippageBps", String(slippageBps));
  return get<NftBuyQuote>(
    `/collection/${encodeURIComponent(collectionMint)}/quote?${q}`,
    "NFT buy quote",
  );
}

export async function fetchNftSellQuote(
  collectionMint: string,
  slippageBps?: number,
): Promise<NftSellQuote> {
  const q = new URLSearchParams({ side: "sell" });
  if (slippageBps !== undefined) q.set("slippageBps", String(slippageBps));
  return get<NftSellQuote>(
    `/collection/${encodeURIComponent(collectionMint)}/quote?${q}`,
    "NFT sell quote",
  );
}

/** After a target graduation: what one `request_mint` charges now (curve, floor and lock bounds). */
export interface NftRequestQuote {
  side: "request";
  units: 1;
  costRaw: string;
  feeRaw: string;
  totalRaw: string;
  maxCostRaw: string;
  remaining: string;
  pending: string;
  itemDepositLamports: string;
}

export async function fetchNftRequestQuote(
  collectionMint: string,
  slippageBps?: number,
): Promise<NftRequestQuote> {
  const q = new URLSearchParams({ side: "request" });
  if (slippageBps !== undefined) q.set("slippageBps", String(slippageBps));
  return get<NftRequestQuote>(
    `/collection/${encodeURIComponent(collectionMint)}/quote?${q}`,
    "NFT mint request quote",
  );
}

export async function fetchNftOwnerItems(
  collectionMint: string,
  owner: string,
): Promise<NftOwnerItems> {
  return get<NftOwnerItems>(
    `/collection/${encodeURIComponent(collectionMint)}/items/${encodeURIComponent(owner)}`,
    "NFT holdings",
  );
}

/** One item's drop, by the item mint. Null when the API does not know it as a launchpad item. */
export async function fetchNftItemCollection(itemMint: string): Promise<string | null> {
  try {
    const res = await get<{ collection?: { mint?: string } }>(
      `/item/${encodeURIComponent(itemMint)}`,
      "NFT item",
    );
    return res.collection?.mint ?? null;
  } catch {
    return null;
  }
}

export async function fetchNftMintRequest(
  requestPda: string,
  minNonce?: string,
): Promise<NftMintRequestView> {
  const q = minNonce ? `?minNonce=${encodeURIComponent(minNonce)}` : "";
  return get<NftMintRequestView>(`/request/${encodeURIComponent(requestPda)}${q}`, "mint request");
}

// ── public builds ────────────────────────────────────────────────────────────

export async function buildNftBuyTx(body: {
  buyer: string;
  collectionMint: string;
  maxSpendRaw: string;
  slippageBps?: number;
}): Promise<NftBuiltBuy> {
  return post<NftBuiltBuy>("/tx/buy", body, "NFT mint build");
}

export async function buildNftRequestMintTx(body: {
  buyer: string;
  collectionMint: string;
  maxSpendRaw: string;
  slippageBps?: number;
}): Promise<NftBuiltRequest> {
  return post<NftBuiltRequest>("/tx/request-mint", body, "NFT mint request build");
}

export async function buildNftSellTx(body: {
  seller: string;
  collectionMint: string;
  nftMint: string;
  slippageBps?: number;
}): Promise<NftBuiltSell> {
  return post<NftBuiltSell>("/tx/sell", body, "NFT sell-back build");
}

export async function buildNftRedeemTx(body: {
  holder: string;
  collectionMint: string;
  nftMint: string;
}): Promise<NftBuiltTx> {
  return post<NftBuiltTx>("/tx/redeem", body, "NFT floor redemption build");
}

export async function buildNftWindDownTx(body: {
  holder: string;
  collectionMint: string;
  nftMint: string;
  skipClose?: boolean;
}): Promise<NftBuiltWindDown> {
  return post<NftBuiltWindDown>("/tx/redeem-wind-down", body, "NFT wind-down refund build");
}

export async function buildNftClaimTx(body: {
  creator: string;
  collectionMint: string;
}): Promise<NftBuiltClaim> {
  return post<NftBuiltClaim>("/tx/claim", body, "NFT creator claim build");
}

// ── upkeep: anyone may send these ────────────────────────────────────────────

/** Settle the drop's mint-queue head with its drawn item. Refused unless its randomness is ready. */
export async function buildNftSettleTx(body: {
  signer: string;
  collectionMint: string;
}): Promise<NftBuiltSettle> {
  return post<NftBuiltSettle>("/tx/settle-mint", body, "NFT mint settle build");
}

/** Refund the drop's mint-queue head to its buyer. Refused unless its randomness has expired. */
export async function buildNftRefundTx(body: {
  signer: string;
  collectionMint: string;
}): Promise<NftBuiltRefund> {
  return post<NftBuiltRefund>("/tx/refund-mint", body, "NFT mint refund build");
}

/** Graduate a drop that qualifies (sold out). Refused while it does not. */
export async function buildNftGraduateTx(body: {
  signer: string;
  collectionMint: string;
}): Promise<NftBuiltTx> {
  return post<NftBuiltTx>("/tx/graduate", body, "NFT drop graduation build");
}

// ── session-gated: launching a drop ──────────────────────────────────────────

/** Pin one piece of art. Returns its gateway URL; the type travels with it (the URL has no extension). */
export async function uploadNftArt(
  bytes: Buffer,
  mimeType: string,
  fileName: string,
  session: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), fileName);
  const res = unwrap(
    await fetchJson<Envelope<{ url?: string }>>(`${NFT}/art`, {
      method: "POST",
      body: form,
      headers: { Authorization: `Bearer ${session}` },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }),
    "art upload",
  );
  if (!res.url) {
    throw new CookieMcpError(`the launchpad returned no URL for ${fileName}`, "retry the launch");
  }
  return res.url;
}

export async function sealNftDrop(body: SealDropRequest, session: string): Promise<SealedDrop> {
  const res = await post<Partial<SealedDrop>>("/drops", body, "drop seal", {
    session,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  if (!res.dropId || !res.mint || !res.baseUri || !res.collectionUri || !res.commitment) {
    throw new CookieMcpError(
      "the launchpad sealed the drop but did not return its addresses",
      "retry the launch; nothing was signed",
    );
  }
  return res as SealedDrop;
}

export async function buildNftCreateTx(
  body: {
    creator: string;
    dropId: string;
    params: NftCollectionParams;
    allowlist?: string[];
    graduationTargetBps?: number;
  },
  session: string,
): Promise<NftBuiltCreate> {
  return post<NftBuiltCreate>("/tx/create", body, "drop create build", {
    session,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

export async function buildNftRevealTx(
  body: { creator: string; collectionMint: string },
  session: string,
): Promise<NftBuiltTx> {
  return post<NftBuiltTx>("/tx/reveal", body, "reveal build", {
    session,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}
