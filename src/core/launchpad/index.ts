// MomoSwap launchpad (momoswap.fun) — launch a token on a bonding curve, trade the curve, and claim
// payouts. Non-custodial: the launchpad API builds and partial-signs each transaction (it leases the
// pre-ground `momo` mint the program requires, pins metadata to IPFS, and wraps/unwraps COOK), then
// we simulate it on our RPC, add the wallet signature locally and send + confirm.
//
// ⚠️ Pre-graduation, a holder's tokens are program-tracked **curve shares**, not SPL tokens — they do
// NOT show up in `get_balance` and cannot be swapped with `trade`. Selling back to the curve
// (launchpad_sell) is the only exit until the pool graduates; after graduation the holder claims the
// real SPL token (claim_launchpad) and trades it normally.
import { PublicKey, Transaction, type Keypair } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";

import {
  COOK_DECIMALS,
  COOK_MINT,
  COOK_SYMBOL,
  explorerTxUrl,
  launchpadPoolUrl,
  launchpadTokenUrl,
  PROGRAM_IDS,
} from "../config";
import { CookieMcpError } from "../errors";
import { rawToUi, uiToRaw } from "../format";
import { getConnection } from "../rpc";
import { assertWithinSpendCap, ownPublicKey, requireWallet } from "../wallet";
import {
  buildBuyTx,
  buildClaimCreatorFeesTx,
  buildClaimTx,
  buildCreatePoolTx,
  buildSellTx,
  fetchLaunchpadConfig,
  fetchPendingCreatorFees,
  fetchPoolByAddress,
  fetchPoolByMint,
  fetchPools,
  fetchPosition,
  fetchWinnerProof,
  uploadImage,
  type BuiltTx,
  type ClaimKind,
  type CreatePoolParams,
  type ExpiryMode,
  type LaunchpadConfig,
  type LaunchpadMetadata,
  type LaunchpadPool,
  type LaunchpadPosition,
  type PoolStatus,
} from "./api";
import { estimateBuy, estimateSell, graduationProgressPct, spotPriceCook } from "./curve";
import { fetchCreatorFeeVaults, fetchPositionsForPools } from "./positions";

const MIN_DURATION_SECS = 60;
const MAX_DURATION_SECS = 604_800; // 7 days, enforced on-chain
const DEFAULT_DURATION_SECS = 86_400;
const MAX_NAME_LEN = 32;
const MAX_SYMBOL_LEN = 10;

// Program error codes (anchor custom errors) worth translating for an agent — the rest fall through
// to the raw simulation log tail.
const LAUNCHPAD_ERRORS: Record<number, string> = {
  6000: "the launchpad is paused",
  6011: "the pool is not in a tradeable state (it has graduated or expired)",
  6012: "trading has not opened yet for this launch",
  6013: "the launch has ended — the pool is expired",
  6015: "the amount is below the pool's minimum buy",
  6016: "this buy would exceed the pool's per-wallet cap",
  6017: "this buy would exceed the pool's raise cap",
  6019: "the pool has no sale tokens left at this size",
  6020: "you have no bonding-curve position on this pool",
  6021: "you are trying to sell more shares than you hold",
  6022: "the pool's payment vault cannot cover this sell",
  6025: "there is nothing to claim",
  6026: "this has already been claimed",
  6035: "self-referral is not allowed",
  6040: "the anti-snipe window caps how much one wallet can buy right after launch",
};

function programErrorCode(blob: string): number | null {
  const m =
    blob.match(/"Custom"\s*:\s*(\d+)/) ?? blob.match(/custom program error: 0x([0-9a-f]+)/i);
  if (!m) return null;
  const raw = m[1]!;
  return /^0x/i.test(m[0]) || m[0].includes("0x") ? parseInt(raw, 16) : parseInt(raw, 10);
}

/** Turn a failed simulation into an actionable error, translating known program error codes. */
export function launchpadSimError(
  what: string,
  err: unknown,
  logs: string[] | null,
): CookieMcpError {
  const blob = `${JSON.stringify(err)} ${logs?.join(" ") ?? ""}`;
  const code = programErrorCode(blob);
  if (code != null && LAUNCHPAD_ERRORS[code]) {
    return new CookieMcpError(`${what} would fail: ${LAUNCHPAD_ERRORS[code]}`, "nothing was sent");
  }
  if (/BlockhashNotFound|blockhash/i.test(blob)) {
    return new CookieMcpError(
      `${what} simulation failed: blockhash not found`,
      "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
    );
  }
  if (/insufficient|0x1\b/i.test(blob)) {
    return new CookieMcpError(
      `${what} simulation failed: insufficient funds`,
      "check the wallet's COOK balance (it also pays rent for new accounts and the network fee)",
    );
  }
  const tail = logs?.slice(-3).join(" | ");
  return new CookieMcpError(
    `${what} simulation failed${tail ? `: ${tail}` : ""}`,
    "the pool state may have changed; re-read it and retry — nothing was sent",
  );
}

/**
 * Simulate an API-built, partial-signed legacy transaction, add our signature and send it.
 * The API sets the fee payer and blockhash, so we confirm against the window it returned.
 */
async function submitBuilt(built: BuiltTx, keypair: Keypair, what: string): Promise<string> {
  if (!built.transactionBase64) {
    throw new CookieMcpError(
      `the launchpad returned no ${what} transaction`,
      "retry; if it persists the launchpad API may be degraded",
    );
  }
  const conn = getConnection();
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(built.transactionBase64, "base64"));
  } catch {
    throw new CookieMcpError(
      `the ${what} transaction returned by the launchpad was malformed`,
      "retry; if it persists the launchpad API may be degraded",
    );
  }

  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) throw launchpadSimError(what, sim.value.err, sim.value.logs ?? null);

  tx.partialSign(keypair);
  const signature = await conn.sendRawTransaction(tx.serialize());
  try {
    await conn.confirmTransaction(
      {
        signature,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
      },
      "confirmed",
    );
  } catch (e) {
    // The transaction was SENT. A confirm timeout (blockhash window elapsed on a slow chain) does not
    // mean it failed — it may still land. Say so loudly: a blind retry here can buy/launch twice.
    const detail = e instanceof Error ? e.message : String(e);
    throw new CookieMcpError(
      `the ${what} transaction was sent (${signature}) but could not be confirmed in time: ${detail}`,
      `DO NOT retry blindly — check ${explorerTxUrl(signature)} first; if it landed, the ${what} already happened`,
    );
  }
  return signature;
}

/** A pool reference is either the pool PDA or the token mint — resolve both to the pool. */
async function resolvePool(ref: string): Promise<LaunchpadPool> {
  try {
    return await fetchPoolByAddress(ref);
  } catch {
    try {
      return (await fetchPoolByMint(ref)).pool;
    } catch {
      throw new CookieMcpError(
        `no launchpad pool found for "${ref}"`,
        "pass the token mint or the pool address of a MomoSwap launch (get_launchpad_pools lists them)",
      );
    }
  }
}

// --- cross-tool handoff -------------------------------------------------------------------------

/**
 * Explain why a mint has no swap route when the reason is the launchpad (pure — the caller supplies
 * the pool). A live curve has no DEX pool at all, so aggregators legitimately find nothing; the agent
 * needs to be sent to the launchpad tools instead of concluding the token is untradeable. Returns
 * null for a graduated pool: that token DOES have a market, so a missing route is a real liquidity
 * problem and the caller's own message is the honest one.
 */
export function launchpadRouteMessage(
  pool: Pick<
    LaunchpadPool,
    | "pubkey"
    | "symbol"
    | "expiryMode"
    | "launchTs"
    | "endTs"
    | "paymentRaisedNet"
    | "graduationTarget"
  > & { status: PoolPhase },
): { error: string; hint: string } | null {
  const sym = pool.symbol || "this token";
  switch (pool.status) {
    case "ended":
      return {
        error: `${sym} has no swap route: its MomoSwap launch window has closed and the pool has not been settled on-chain yet`,
        hint: "it never graduated, so there is no market; once the pool is expired on-chain, claim_launchpad settles a curve position",
      };
    case "live":
      return {
        error: `${sym} has no swap route: it is still trading on its MomoSwap launchpad bonding curve, which DEX aggregators cannot route`,
        hint:
          `buy it with launchpad_buy and sell it with launchpad_sell (pool ${pool.pubkey}) — it becomes ` +
          `swappable only after the launch graduates (${graduationProgressPct(pool.paymentRaisedNet, pool.graduationTarget)}% of the target raised)`,
      };
    case "upcoming":
      return {
        error: `${sym} is not tradeable yet: its MomoSwap launch opens at ${new Date(pool.launchTs * 1000).toISOString()}`,
        hint: "check it with get_launchpad_token, then buy on the curve with launchpad_buy once it opens",
      };
    case "expired":
      return {
        error: `${sym} has no market: its MomoSwap launch expired without reaching the graduation target, so it never got a pool`,
        hint:
          pool.expiryMode === "fair"
            ? "if you bought on the curve, claim_launchpad returns your pro-rata refund"
            : pool.expiryMode === "dead"
              ? "there is no market and no holder payout — unraised funds went to the treasury"
              : "if you placed in the settlement, claim_launchpad pays out your Merkle allocation",
      };
    default:
      return null;
  }
}

/**
 * A swap route lookup came back empty. If one of the mints is a launchpad token whose curve is still
 * the only venue, return an error pointing at the launchpad tools; otherwise null so the caller keeps
 * its own message. **Never throws** — a launchpad lookup must not replace a swap error with a
 * lookup error.
 */
export async function launchpadRouteRedirect(mints: string[]): Promise<CookieMcpError | null> {
  for (const mint of mints) {
    if (!mint || mint === COOK_MINT) continue;
    try {
      const { pool } = await fetchPoolByMint(mint);
      const msg = launchpadRouteMessage({ ...pool, status: poolPhase(pool, nowSeconds()) });
      if (msg) return new CookieMcpError(msg.error, msg.hint);
    } catch {
      /* not a launchpad mint, or the launchpad API is unreachable — fall through */
    }
  }
  return null;
}

/**
 * The error the swap paths (`get_quote`, `trade`) should raise when no route exists: the launchpad
 * redirect when that is the real reason, else the original upstream error, else the generic message.
 * Lives here because only the launchpad can explain the interesting case.
 */
export async function noRouteError(mints: string[], upstream?: unknown): Promise<unknown> {
  // Only second-guess route-shaped failures; a timeout or an outage must surface as itself.
  const msg = upstream instanceof Error ? upstream.message : "";
  const routeShaped = !upstream || /route|liquidity|pool/i.test(msg);
  if (routeShaped) {
    const redirect = await launchpadRouteRedirect(mints);
    if (redirect) return redirect;
  }
  return (
    upstream ??
    new CookieMcpError(
      "no route found for this pair",
      "the pair may lack liquidity; try a smaller amount or a more liquid token",
    )
  );
}

/** The launch token's decimals, read from the mint (falls back to the launchpad default). */
async function tokenDecimals(pool: LaunchpadPool, cfg: LaunchpadConfig): Promise<number> {
  try {
    return (await getMint(getConnection(), new PublicKey(pool.tokenMint))).decimals;
  } catch {
    return cfg.defaultTokenDecimals;
  }
}

// --- reads ---------------------------------------------------------------------------------------

export interface LaunchpadPoolView {
  pool: string;
  mint: string;
  name: string;
  symbol: string;
  /** Derived phase, not the raw API status — see poolPhase (can be `ended`). */
  status: PoolPhase;
  expiryMode: ExpiryMode;
  creator: string;
  metadataUri: string;
  priceCook: number;
  raisedCook: string;
  graduationTargetCook: string;
  graduationProgressPct: number;
  tokensSold: string;
  saleSupply: string;
  participants: number;
  launchAt: string;
  /** When trading closes. Past this, `status` reads `ended` until the pool is settled on-chain. */
  endsAt: string;
  antiSnipe: boolean;
  minBuyCook: string;
  maxBuyPerWalletCook: string | null;
  links: { launchpad: string; token: string };
}

/**
 * The pool's real phase, which is NOT always the API's `status`.
 *
 * On-chain, `buy`/`sell` require `now <= end_ts` and the claim paths require state `Expired` — a state
 * only a permissionless `expire_pool` call sets, and nothing calls it automatically. The API reports
 * such a pool as `live` (its on-chain state IS still `Open`), so taking `status` at face value would
 * have us advertise a pool as tradeable when every trade reverts, and tell holders to "sell to exit"
 * when they cannot. `ended` names that window: trading closed, settlement not yet performed.
 */
export type PoolPhase = PoolStatus | "ended";

export function poolPhase(
  pool: Pick<LaunchpadPool, "status" | "endTs">,
  nowSec: number,
): PoolPhase {
  return pool.status === "live" && nowSec > pool.endTs ? "ended" : pool.status;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Project a raw pool account into the agent-facing view (pure — all inputs are supplied). */
export function mapPoolView(
  pool: LaunchpadPool,
  tokenDecs: number,
  paymentDecs: number = COOK_DECIMALS,
  nowSec: number = nowSeconds(),
): LaunchpadPoolView {
  return {
    pool: pool.pubkey,
    mint: pool.tokenMint,
    name: pool.name,
    symbol: pool.symbol,
    status: poolPhase(pool, nowSec),
    expiryMode: pool.expiryMode,
    creator: pool.creator,
    metadataUri: pool.uri,
    priceCook: spotPriceCook(pool, paymentDecs, tokenDecs),
    raisedCook: rawToUi(pool.paymentRaisedNet, paymentDecs),
    graduationTargetCook: rawToUi(pool.graduationTarget, paymentDecs),
    graduationProgressPct: graduationProgressPct(pool.paymentRaisedNet, pool.graduationTarget),
    tokensSold: rawToUi(pool.tokensSold, tokenDecs),
    saleSupply: rawToUi(pool.saleTokenSupply, tokenDecs),
    participants: Number(pool.participantCount),
    launchAt: new Date(pool.launchTs * 1000).toISOString(),
    endsAt: new Date(pool.endTs * 1000).toISOString(),
    antiSnipe: pool.antiSnipe,
    minBuyCook: rawToUi(pool.minBuy, paymentDecs),
    maxBuyPerWalletCook:
      BigInt(pool.maxBuyPerWallet) > 0n ? rawToUi(pool.maxBuyPerWallet, paymentDecs) : null,
    links: { launchpad: launchpadPoolUrl(pool.pubkey), token: launchpadTokenUrl(pool.tokenMint) },
  };
}

export interface GetLaunchpadPoolsResult {
  count: number;
  status: PoolStatus | "all";
  program: string;
  pools: LaunchpadPoolView[];
}

export async function getLaunchpadPools(args: {
  status?: PoolStatus | "all";
  limit?: number;
}): Promise<GetLaunchpadPoolsResult> {
  const status = args.status ?? "live";
  const [cfg, pools] = await Promise.all([fetchLaunchpadConfig(), fetchPools(status)]);
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  // Most-progressed first — for live pools that's "closest to graduating".
  const sorted = [...pools].sort(
    (a, b) =>
      graduationProgressPct(b.paymentRaisedNet, b.graduationTarget) -
      graduationProgressPct(a.paymentRaisedNet, a.graduationTarget),
  );
  return {
    count: pools.length,
    status,
    program: PROGRAM_IDS.momoswapLaunchpad,
    pools: sorted.slice(0, limit).map((p) => mapPoolView(p, cfg.defaultTokenDecimals)),
  };
}

export interface PositionView {
  owner: string;
  shares: string;
  investedCook: string;
  withdrawnCook: string;
  estimatedValueCook: string | null;
  claimed: { refund: boolean; winnings: boolean; graduatedTokens: boolean };
}

// --- get_launchpad_positions ---------------------------------------------------------------------

/** What the holder can do about a position right now, if anything. */
export interface PositionAction {
  tool: "launchpad_sell" | "claim_launchpad" | "claim_creator_fees";
  kind: ClaimKind | "sell" | "creator_fees";
  reason: string;
}

/**
 * The action a position calls for (pure). Curve shares are not SPL tokens, so "do nothing" is rarely
 * right: after graduation the tokens sit unclaimed, and a Fair expiry leaves a refund on the table.
 * Returns null when the position is settled or there is genuinely nothing to collect.
 */
export function positionAction(
  pool: { status: PoolPhase; expiryMode: ExpiryMode },
  position: Pick<
    LaunchpadPosition,
    "shares" | "claimed" | "winnerClaimed" | "graduatedTokensClaimed"
  >,
): PositionAction | null {
  const hasShares = BigInt(position.shares) > 0n;
  // `ended` = trading closed but nobody has settled the pool on-chain yet, so there is nothing the
  // holder can do: selling reverts (past end_ts) and claiming reverts (state is still Open).
  if (pool.status === "ended") return null;
  if (pool.status === "graduated") {
    if (hasShares && !position.graduatedTokensClaimed) {
      return {
        tool: "claim_launchpad",
        kind: "graduated_tokens",
        reason: "the pool graduated and your SPL tokens are still unclaimed",
      };
    }
    return null;
  }
  if (pool.status === "live") {
    return hasShares
      ? {
          tool: "launchpad_sell",
          kind: "sell",
          reason: "the curve is still live — you can sell these shares back to it",
        }
      : null;
  }
  if (pool.status !== "expired") return null;
  if (!hasShares) return null;
  if (pool.expiryMode === "fair" && !position.claimed) {
    return {
      tool: "claim_launchpad",
      kind: "fair",
      reason: "the launch expired in Fair mode — your pro-rata refund is unclaimed",
    };
  }
  if (
    (pool.expiryMode === "jackpot" || pool.expiryMode === "survivor") &&
    !position.winnerClaimed
  ) {
    return {
      tool: "claim_launchpad",
      kind: "winner",
      reason: `the launch expired in ${pool.expiryMode} mode — claim_launchpad checks whether you placed in the settlement`,
    };
  }
  return null; // dead mode, or already claimed
}

/** Unclaimed creator vesting on a pool this wallet created (pure). */
export function creatorVestOutstanding(
  pool: Pick<LaunchpadPool, "creatorVestAmount" | "creatorVestClaimed">,
): bigint {
  const total = BigInt(pool.creatorVestAmount);
  const claimed = BigInt(pool.creatorVestClaimed);
  return total > claimed ? total - claimed : 0n;
}

export interface LaunchpadPositionEntry {
  pool: string;
  mint: string;
  symbol: string;
  status: PoolPhase;
  expiryMode: ExpiryMode;
  shares: string;
  investedCook: string;
  withdrawnCook: string;
  /** What selling the remaining shares back to a LIVE curve would pay; null once it isn't live. */
  estimatedValueCook: string | null;
  action: PositionAction | null;
  links: { launchpad: string; token: string };
}

export interface LaunchpadCreatorEntry {
  pool: string;
  mint: string;
  symbol: string;
  status: PoolPhase;
  unclaimedFeesCook: string;
  /** Creator vesting is denominated in the LAUNCH TOKEN, not COOK — hence the explicit name. */
  unclaimedVestTokens: string | null;
  actions: PositionAction[];
}

export interface GetLaunchpadPositionsResult {
  owner: string;
  poolsScanned: number;
  positions: LaunchpadPositionEntry[];
  created: LaunchpadCreatorEntry[];
  totals: {
    investedCook: string;
    withdrawnCook: string;
    liveValueCook: string;
    unclaimedCreatorFeesCook: string;
    actionsPending: number;
  };
  notes: string[];
}

/**
 * Every launchpad position a wallet holds, plus anything it can claim — the view `get_balance` cannot
 * give, because pre-graduation shares are program state rather than SPL tokens. Reads the
 * `UserPosition` PDAs directly in batches (see positions.ts), so cost is ~1 RPC round trip per 100
 * pools rather than one HTTP call each. No key needed when `owner` is passed.
 */
export async function getLaunchpadPositions(args: {
  owner?: string;
  includeClosed?: boolean;
}): Promise<GetLaunchpadPositionsResult> {
  const owner = args.owner?.trim() || ownPublicKey();
  if (!owner) {
    throw new CookieMcpError(
      "no wallet to look up",
      "pass `owner` (any address), or set COOKIE_PRIVATE_KEY to use your own",
    );
  }
  try {
    new PublicKey(owner);
  } catch {
    throw new CookieMcpError(`"${owner}" is not a valid address`, "pass a base58 wallet address");
  }

  const conn = getConnection();
  const [cfg, pools] = await Promise.all([fetchLaunchpadConfig(), fetchPools("all")]);
  const decs = cfg.defaultTokenDecimals;
  const poolKeys = pools.map((p) => p.pubkey);
  const created = pools.filter((p) => p.creator === owner);

  const [positions, feeVaults] = await Promise.all([
    fetchPositionsForPools(conn, owner, poolKeys),
    created.length
      ? fetchCreatorFeeVaults(
          conn,
          created.map((p) => p.pubkey),
        )
      : new Map(),
  ]);

  let investedRaw = 0n;
  let withdrawnRaw = 0n;
  let liveValueRaw = 0n;
  let actionsPending = 0;

  const now = nowSeconds();
  const entries: LaunchpadPositionEntry[] = [];
  for (const pool of pools) {
    const position = positions.get(pool.pubkey);
    if (!position) continue;
    const phase = poolPhase(pool, now);
    const shares = BigInt(position.shares);
    const action = positionAction({ status: phase, expiryMode: pool.expiryMode }, position);
    if (shares === 0n && !action && !args.includeClosed) continue; // fully exited and settled

    investedRaw += BigInt(position.totalPaymentIn);
    withdrawnRaw += BigInt(position.totalPaymentOut);
    let value: string | null = null;
    if (phase === "live" && shares > 0n) {
      const net = estimateSell(pool, shares, cfg.tradeFeeBps).netRaw;
      liveValueRaw += net;
      value = rawToUi(net, COOK_DECIMALS);
    }
    // A live curve's "sell" is an option, not an outstanding obligation — only claims count as pending.
    if (action && action.tool === "claim_launchpad") actionsPending += 1;

    entries.push({
      pool: pool.pubkey,
      mint: pool.tokenMint,
      symbol: pool.symbol,
      status: phase,
      expiryMode: pool.expiryMode,
      shares: rawToUi(position.shares, decs),
      investedCook: rawToUi(position.totalPaymentIn, COOK_DECIMALS),
      withdrawnCook: rawToUi(position.totalPaymentOut, COOK_DECIMALS),
      estimatedValueCook: value,
      action,
      links: { launchpad: launchpadPoolUrl(pool.pubkey), token: launchpadTokenUrl(pool.tokenMint) },
    });
  }

  let feesRaw = 0n;
  const createdEntries: LaunchpadCreatorEntry[] = [];
  for (const pool of created) {
    const fees = (feeVaults as Map<string, bigint>).get(pool.pubkey) ?? 0n;
    const vest = creatorVestOutstanding(pool);
    if (fees === 0n && vest === 0n && !args.includeClosed) continue;
    feesRaw += fees;
    const actions: PositionAction[] = [];
    if (fees > 0n) {
      actions.push({
        tool: "claim_creator_fees",
        kind: "creator_fees",
        reason: `${rawToUi(fees, COOK_DECIMALS)} ${COOK_SYMBOL} of creator trading fees is unclaimed`,
      });
    }
    // Vesting is linear from graduation, so the claimable slice may be smaller than what is left.
    if (vest > 0n && pool.status === "graduated") {
      actions.push({
        tool: "claim_launchpad",
        kind: "creator_vest",
        reason: `${rawToUi(vest, decs)} ${pool.symbol} of your creator allocation is still vesting/unclaimed — claim the vested portion with kind=creator_vest`,
      });
    }
    actionsPending += actions.length;
    createdEntries.push({
      pool: pool.pubkey,
      mint: pool.tokenMint,
      symbol: pool.symbol,
      status: poolPhase(pool, now),
      unclaimedFeesCook: rawToUi(fees, COOK_DECIMALS),
      unclaimedVestTokens: vest > 0n ? rawToUi(vest, decs) : null,
      actions,
    });
  }

  const notes: string[] = [];
  if (entries.length) {
    notes.push(
      "Shares on a live curve are program state, not SPL tokens — they never appear in get_balance.",
    );
  }
  if (actionsPending) {
    notes.push(`${actionsPending} position(s) have something unclaimed — see each entry's action.`);
  }
  if (!entries.length && !createdEntries.length) {
    notes.push(
      args.includeClosed
        ? "This wallet has never traded on the MomoSwap launchpad."
        : "Nothing outstanding. Pass includeClosed=true to also list fully exited positions.",
    );
  }

  return {
    owner,
    poolsScanned: pools.length,
    positions: entries,
    created: createdEntries,
    totals: {
      investedCook: rawToUi(investedRaw, COOK_DECIMALS),
      withdrawnCook: rawToUi(withdrawnRaw, COOK_DECIMALS),
      liveValueCook: rawToUi(liveValueRaw, COOK_DECIMALS),
      unclaimedCreatorFeesCook: rawToUi(feesRaw, COOK_DECIMALS),
      actionsPending,
    },
    notes,
  };
}

export interface GetLaunchpadTokenResult extends LaunchpadPoolView {
  fees: { tradePct: number; creatorSharePct: number; referralSharePct: number };
  quote: { cookIn: string; tokensOut: string } | null;
  position: PositionView | null;
  pendingCreatorFeesCook: number | null;
  notes: string[];
}

export async function getLaunchpadToken(args: {
  ref: string;
  quoteCook?: string | number;
}): Promise<GetLaunchpadTokenResult> {
  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  const decs = await tokenDecimals(pool, cfg);
  const owner = ownPublicKey();

  const [position, pendingCreatorFees] = await Promise.all([
    owner ? fetchPosition(pool.pubkey, owner).catch(() => null) : Promise.resolve(null),
    owner && owner === pool.creator
      ? fetchPendingCreatorFees(pool.pubkey).catch(() => null)
      : Promise.resolve(null),
  ]);

  const view = mapPoolView(pool, decs);
  const phase = poolPhase(pool, nowSeconds());
  const tradeable = phase === "live";

  let quote: { cookIn: string; tokensOut: string } | null = null;
  // Quote from the curve for pools that still have one — including a launch that hasn't opened yet.
  if (args.quoteCook != null && (tradeable || phase === "upcoming")) {
    const cookIn = uiToRaw(args.quoteCook, COOK_DECIMALS);
    const est = estimateBuy(pool, cookIn, cfg.tradeFeeBps);
    quote = {
      cookIn: rawToUi(cookIn, COOK_DECIMALS),
      tokensOut: rawToUi(est.tokensOutRaw, decs),
    };
  }

  const notes: string[] = [];
  if (phase === "live") {
    notes.push(
      "Pre-graduation holdings are program-tracked curve shares, not SPL tokens: they do not appear " +
        "in get_balance and cannot be swapped with trade. Use launchpad_sell to exit.",
    );
  }
  if (phase === "graduated") {
    notes.push(
      "This pool graduated — curve buyers claim their real SPL tokens with claim_launchpad, then " +
        "trade them normally with trade/get_quote.",
    );
  }
  if (phase === "expired") {
    notes.push(
      `This launch expired without graduating; settlement mode is "${pool.expiryMode}"` +
        (pool.expiryMode === "fair"
          ? " — curve buyers can claim a pro-rata refund with claim_launchpad."
          : pool.expiryMode === "dead"
            ? " — unraised funds are swept to the treasury; there is nothing to claim."
            : " — winners claim their Merkle payout with claim_launchpad once the root is set."),
    );
  }

  return {
    ...view,
    fees: {
      tradePct: cfg.tradeFeeBps / 100,
      creatorSharePct: cfg.creatorFeeBps / 100,
      referralSharePct: cfg.referralFeeBps / 100,
    },
    quote,
    position: position
      ? {
          owner: position.owner,
          shares: rawToUi(position.shares, decs),
          investedCook: rawToUi(position.totalPaymentIn, COOK_DECIMALS),
          withdrawnCook: rawToUi(position.totalPaymentOut, COOK_DECIMALS),
          estimatedValueCook:
            tradeable && BigInt(position.shares) > 0n
              ? rawToUi(
                  estimateSell(pool, BigInt(position.shares), cfg.tradeFeeBps).netRaw,
                  COOK_DECIMALS,
                )
              : null,
          claimed: {
            refund: position.claimed,
            winnings: position.winnerClaimed,
            graduatedTokens: position.graduatedTokensClaimed,
          },
        }
      : null,
    pendingCreatorFeesCook: pendingCreatorFees,
    notes,
  };
}

// --- deploy_token -------------------------------------------------------------------------------

export interface DeployTokenArgs {
  name: string;
  symbol: string;
  description?: string;
  imageBase64?: string;
  imageMimeType?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  durationSecs?: number;
  expiryMode?: ExpiryMode;
  antiSnipe?: boolean;
  minBuyCook?: string | number;
  maxBuyPerWalletCook?: string | number;
  devBuyCook?: string | number;
}

/** Assemble the off-chain metadata JSON the launchpad pins to IPFS (pure). */
export function buildMetadata(args: DeployTokenArgs, imageUrl?: string): LaunchpadMetadata {
  const extensions: Record<string, string> = {};
  if (args.website?.trim()) extensions.website = args.website.trim();
  if (args.twitter?.trim()) {
    const h = args.twitter.trim().replace(/^@/, "");
    extensions.twitter = /^https?:\/\//i.test(h) ? h : `https://x.com/${h}`;
  }
  if (args.telegram?.trim()) {
    const h = args.telegram.trim().replace(/^@/, "");
    extensions.telegram = /^https?:\/\//i.test(h) ? h : `https://t.me/${h}`;
  }
  return {
    name: args.name.trim(),
    symbol: args.symbol.trim().toUpperCase(),
    ...(args.description?.trim() ? { description: args.description.trim() } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
}

/** Validate + assemble on-chain `PoolParams` (pure). `launchTs` 0 lets the API stamp "now". */
export function buildCreateParams(args: DeployTokenArgs, launchTs = 0): CreatePoolParams {
  const name = args.name?.trim() ?? "";
  const symbol = args.symbol?.trim().toUpperCase() ?? "";
  if (!name || name.length > MAX_NAME_LEN) {
    throw new CookieMcpError(
      `name must be 1–${MAX_NAME_LEN} characters`,
      "shorten the token name (the full name lives in the metadata too)",
    );
  }
  if (!symbol || symbol.length > MAX_SYMBOL_LEN) {
    throw new CookieMcpError(
      `symbol must be 1–${MAX_SYMBOL_LEN} characters`,
      "use a short ticker, e.g. MOMO",
    );
  }
  const durationSecs = args.durationSecs ?? DEFAULT_DURATION_SECS;
  if (!Number.isFinite(durationSecs) || durationSecs < MIN_DURATION_SECS) {
    throw new CookieMcpError(
      `durationSecs must be at least ${MIN_DURATION_SECS}`,
      "this is how long the launch stays open to reach the graduation target",
    );
  }
  if (durationSecs > MAX_DURATION_SECS) {
    throw new CookieMcpError(
      `durationSecs must be at most ${MAX_DURATION_SECS} (7 days)`,
      "pick a shorter launch window",
    );
  }
  const expiryMode = args.expiryMode ?? "fair";
  return {
    name,
    symbol,
    launch_ts: launchTs,
    duration_secs: Math.floor(durationSecs),
    expiry_mode: expiryMode,
    migratable: true,
    anti_snipe: args.antiSnipe ?? true,
    min_buy: (args.minBuyCook != null ? uiToRaw(args.minBuyCook, COOK_DECIMALS) : 0n).toString(),
    max_buy_per_wallet: (args.maxBuyPerWalletCook != null
      ? uiToRaw(args.maxBuyPerWalletCook, COOK_DECIMALS)
      : 0n
    ).toString(),
    // The program rejects a per-pool raise cap below the graduation target, and a cap is never
    // what an agent wants here — leave the raise uncapped.
    max_payment_raise: "0",
  };
}

export interface DeployTokenResult {
  signature: string;
  explorerUrl: string;
  mint: string;
  pool: string | null;
  name: string;
  symbol: string;
  metadataUri: string | null;
  costCook: { creationFee: string; devBuy: string; total: string };
  launch: { opensAt: string; endsAt: string | null; expiryMode: ExpiryMode; antiSnipe: boolean };
  graduationTargetCook: string;
  links: { launchpad: string | null; token: string };
  warning?: string;
  notes: string[];
}

/**
 * Launch a token on the MomoSwap bonding curve. The API pins the metadata, leases a `momo`-suffixed
 * mint (required on-chain) and partial-signs the mint/vault keypairs; we simulate, sign and send.
 * Costs the launchpad's creation fee (2,000 COOK at time of writing) plus rent and any dev buy.
 */
export async function deployToken(args: DeployTokenArgs): Promise<DeployTokenResult> {
  const { keypair } = requireWallet();
  const creator = keypair.publicKey.toBase58();

  if (args.imageBase64 && args.imageUrl) {
    throw new CookieMcpError(
      "pass either imageBase64 or imageUrl, not both",
      "imageBase64 is preferred when you generated the image yourself",
    );
  }
  if (args.imageBase64 && !args.imageMimeType) {
    throw new CookieMcpError(
      "imageMimeType is required with imageBase64",
      'e.g. "image/png" or "image/jpeg"',
    );
  }

  const cfg = await fetchLaunchpadConfig();
  if (cfg.paused) {
    throw new CookieMcpError(
      "the launchpad is paused — new launches are disabled",
      "retry later; existing pools can still be traded",
    );
  }
  if (cfg.momoReady !== undefined && cfg.momoReady <= 0) {
    throw new CookieMcpError(
      "the launchpad has no pre-ground `momo` mint available right now",
      "every launch mint must end in `momo`; retry in a few minutes while the grinder refills",
    );
  }

  const params = buildCreateParams(args);
  const creationFeeCook = Number(rawToUi(cfg.creationFeeLamports, COOK_DECIMALS));
  const devBuyRaw = args.devBuyCook != null ? uiToRaw(args.devBuyCook, COOK_DECIMALS) : 0n;
  const devBuyCook = Number(rawToUi(devBuyRaw, COOK_DECIMALS));
  // The cap covers what actually leaves the wallet: the creation fee plus any dev buy.
  assertWithinSpendCap(creationFeeCook + devBuyCook, 1);

  // Pin the logo first and reference its URL from the metadata JSON (never inline the base64 blob).
  let imageUrl = args.imageUrl?.trim() || undefined;
  if (args.imageBase64) {
    imageUrl = await uploadImage(args.imageBase64, args.imageMimeType!);
  }
  const metadata = buildMetadata(args, imageUrl);

  const built = await buildCreatePoolTx({
    creator,
    params,
    metadata,
    ...(devBuyRaw > 0n ? { devBuyCook: devBuyRaw.toString() } : {}),
  });
  const signature = await submitBuilt(built, keypair, "launch");

  const mint = built.mint ?? null;
  // The pool PDA is keyed by a random pool_id the API picked, so read it back by mint.
  let pool: LaunchpadPool | null = null;
  if (mint) {
    pool = await fetchPoolByMint(mint)
      .then((r) => r.pool)
      .catch(() => null);
  }
  if (!mint) {
    throw new CookieMcpError(
      "the launch was sent but the launchpad did not report the token mint",
      `the transaction ${signature} confirmed — check ${explorerTxUrl(signature)} for the new mint`,
    );
  }

  const notes = [
    "Buyers hold program-tracked curve shares until the pool graduates; the SPL token is claimed " +
      "after graduation (claim_launchpad).",
  ];
  if (devBuyRaw > 0n) {
    notes.push("The dev buy was bundled into the same transaction, so it is the first trade.");
  }

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    mint,
    pool: pool?.pubkey ?? null,
    name: params.name,
    symbol: params.symbol,
    metadataUri: pool?.uri ?? null,
    costCook: {
      creationFee: rawToUi(cfg.creationFeeLamports, COOK_DECIMALS),
      devBuy: rawToUi(devBuyRaw, COOK_DECIMALS),
      total: rawToUi(BigInt(cfg.creationFeeLamports) + devBuyRaw, COOK_DECIMALS),
    },
    launch: {
      opensAt: new Date((pool?.launchTs ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      endsAt: pool ? new Date(pool.endTs * 1000).toISOString() : null,
      expiryMode: params.expiry_mode,
      antiSnipe: params.anti_snipe,
    },
    graduationTargetCook: rawToUi(pool?.graduationTarget ?? cfg.graduationTarget, COOK_DECIMALS),
    links: {
      launchpad: pool ? launchpadPoolUrl(pool.pubkey) : null,
      token: launchpadTokenUrl(mint),
    },
    ...(imageUrl
      ? {}
      : { warning: "launched without a logo — most launchpad UIs will show a blank image" }),
    notes,
  };
}

// --- curve trading ------------------------------------------------------------------------------

/** Guard that a pool is currently tradeable, with a status-specific hint. */
function assertTradeable(pool: LaunchpadPool, action: string): void {
  const phase = poolPhase(pool, nowSeconds());
  if (phase === "live") return;
  const hint =
    phase === "upcoming"
      ? `trading opens at ${new Date(pool.launchTs * 1000).toISOString()}`
      : phase === "graduated"
        ? "the pool graduated — the token trades on the open market now (use get_quote / trade)"
        : phase === "ended"
          ? // On-chain the pool is still `Open`, so buy/sell revert on `now > end_ts` while the claim
            // paths revert on the state — there is nothing to do until someone calls expire_pool.
            `the launch window closed at ${new Date(pool.endTs * 1000).toISOString()} and the pool has not been settled on-chain yet — claims open once it is expired`
          : "the launch expired — use claim_launchpad to settle your position";
  throw new CookieMcpError(`cannot ${action}: the pool is ${phase}`, hint);
}

export interface LaunchpadBuyResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  spent: { amount: string; symbol: string };
  received: { estimate: string; symbol: string; kind: "curve shares" };
  tradeFee: { amount: string; symbol: string; pct: number };
  priceCookPerToken: number;
  graduationProgressPct: number;
  links: { token: string };
  note: string;
}

/** Buy on the bonding curve with COOK. The API wraps the COOK and creates any missing accounts. */
export async function launchpadBuy(args: {
  ref: string;
  amountCook: string | number;
  referrer?: string;
}): Promise<LaunchpadBuyResult> {
  const { keypair } = requireWallet();
  const buyer = keypair.publicKey.toBase58();

  assertWithinSpendCap(Number(args.amountCook), 1); // input is COOK, valued 1:1
  let paymentRaw: bigint;
  try {
    paymentRaw = uiToRaw(args.amountCook, COOK_DECIMALS);
  } catch {
    throw new CookieMcpError(
      `invalid amountCook "${args.amountCook}"`,
      "pass a positive COOK amount, e.g. 5",
    );
  }
  if (paymentRaw <= 0n) {
    throw new CookieMcpError("amountCook must be greater than 0", "pass a positive COOK amount");
  }
  if (args.referrer && args.referrer === buyer) {
    throw new CookieMcpError(
      "self-referral is not allowed",
      "omit referrer, or pass another wallet's address",
    );
  }

  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  assertTradeable(pool, "buy");
  if (BigInt(pool.minBuy) > 0n && paymentRaw < BigInt(pool.minBuy)) {
    throw new CookieMcpError(
      `this pool has a minimum buy of ${rawToUi(pool.minBuy, COOK_DECIMALS)} ${COOK_SYMBOL}`,
      "increase the amount",
    );
  }

  const decs = await tokenDecimals(pool, cfg);
  const est = estimateBuy(pool, paymentRaw, cfg.tradeFeeBps);

  const built = await buildBuyTx({
    buyer,
    pool: pool.pubkey,
    paymentAmount: paymentRaw.toString(),
    referrer: args.referrer ?? null,
  });
  const signature = await submitBuilt(built, keypair, "buy");

  // Post-trade curve state, so the reported price/progress reflect this buy.
  const after = {
    ...pool,
    paymentRaisedNet: (BigInt(pool.paymentRaisedNet) + est.netRaw).toString(),
    tokensSold: (BigInt(pool.tokensSold) + est.tokensOutRaw).toString(),
  };

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    spent: { amount: rawToUi(paymentRaw, COOK_DECIMALS), symbol: COOK_SYMBOL },
    received: {
      estimate: rawToUi(est.tokensOutRaw, decs),
      symbol: pool.symbol,
      kind: "curve shares",
    },
    tradeFee: {
      amount: rawToUi(est.feeRaw, COOK_DECIMALS),
      symbol: COOK_SYMBOL,
      pct: cfg.tradeFeeBps / 100,
    },
    priceCookPerToken: spotPriceCook(after, COOK_DECIMALS, decs),
    graduationProgressPct: graduationProgressPct(after.paymentRaisedNet, pool.graduationTarget),
    links: { token: launchpadTokenUrl(pool.tokenMint) },
    note:
      "These are program-tracked curve shares, not SPL tokens — they will not show in get_balance. " +
      "Sell them back to the curve with launchpad_sell, or claim the real token after graduation.",
  };
}

export interface LaunchpadSellResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  sold: { shares: string; symbol: string };
  received: { estimate: string; symbol: string };
  tradeFee: { amount: string; symbol: string; pct: number };
  remainingShares: string;
  links: { token: string };
}

/** Sell curve shares back to the bonding curve for COOK (unwrapped to native COOK by default). */
export async function launchpadSell(args: {
  ref: string;
  shares: string | number;
  unwrap?: boolean;
}): Promise<LaunchpadSellResult> {
  const { keypair } = requireWallet();
  const seller = keypair.publicKey.toBase58();

  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  assertTradeable(pool, "sell");
  const decs = await tokenDecimals(pool, cfg);

  let sharesRaw: bigint;
  try {
    sharesRaw = uiToRaw(args.shares, decs);
  } catch {
    throw new CookieMcpError(
      `invalid shares "${args.shares}"`,
      `pass a positive token amount with at most ${decs} decimals`,
    );
  }
  if (sharesRaw <= 0n) {
    throw new CookieMcpError("shares must be greater than 0", "pass a positive token amount");
  }

  const position = await fetchPosition(pool.pubkey, seller);
  if (!position || BigInt(position.shares) <= 0n) {
    throw new CookieMcpError(
      "you have no curve position on this pool",
      "launchpad_sell only sells shares bought on the bonding curve with launchpad_buy",
    );
  }
  if (sharesRaw > BigInt(position.shares)) {
    throw new CookieMcpError(
      `you hold ${rawToUi(position.shares, decs)} ${pool.symbol} shares, less than the ${rawToUi(sharesRaw, decs)} requested`,
      "lower the amount",
    );
  }

  const est = estimateSell(pool, sharesRaw, cfg.tradeFeeBps);
  // Value the sale in COOK for the spend cap (proceeds are what moves).
  assertWithinSpendCap(Number(rawToUi(est.netRaw, COOK_DECIMALS)), 1);

  const built = await buildSellTx({
    seller,
    pool: pool.pubkey,
    tokenShares: sharesRaw.toString(),
    unwrap: args.unwrap ?? true,
  });
  const signature = await submitBuilt(built, keypair, "sell");

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    sold: { shares: rawToUi(sharesRaw, decs), symbol: pool.symbol },
    received: { estimate: rawToUi(est.netRaw, COOK_DECIMALS), symbol: COOK_SYMBOL },
    tradeFee: {
      amount: rawToUi(est.feeRaw, COOK_DECIMALS),
      symbol: COOK_SYMBOL,
      pct: cfg.tradeFeeBps / 100,
    },
    remainingShares: rawToUi(BigInt(position.shares) - sharesRaw, decs),
    links: { token: launchpadTokenUrl(pool.tokenMint) },
  };
}

// --- claims -------------------------------------------------------------------------------------

/**
 * Pick the claim a pool's state calls for (pure):
 * graduated → the real SPL token; expired+fair → pro-rata refund; expired+jackpot/survivor → the
 * Merkle payout. `creator_vest` is never auto-selected — it is the creator's own vesting claim.
 */
export function resolveClaimKind(pool: {
  status: PoolPhase;
  expiryMode: ExpiryMode;
}): ClaimKind | null {
  if (pool.status === "graduated") return "graduated_tokens";
  if (pool.status !== "expired") return null;
  if (pool.expiryMode === "fair") return "fair";
  if (pool.expiryMode === "jackpot" || pool.expiryMode === "survivor") return "winner";
  return null; // dead → unraised funds went to the treasury, nothing to claim
}

export interface ClaimLaunchpadResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  kind: ClaimKind;
  claimed: { estimate: string; symbol: string } | null;
  links: { token: string };
  note?: string;
}

/**
 * Claim what a launch owes you: the SPL token after graduation, a Fair-mode refund, a
 * Jackpot/Survivor Merkle payout, or (creators) the vested creator allocation.
 */
export async function claimLaunchpad(args: {
  ref: string;
  kind?: ClaimKind | "auto";
}): Promise<ClaimLaunchpadResult> {
  const { keypair } = requireWallet();
  const claimant = keypair.publicKey.toBase58();

  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  const decs = await tokenDecimals(pool, cfg);

  const phase = poolPhase(pool, nowSeconds());
  const requested = args.kind && args.kind !== "auto" ? args.kind : null;
  const kind = requested ?? resolveClaimKind({ status: phase, expiryMode: pool.expiryMode });
  if (!kind) {
    throw new CookieMcpError(
      `there is nothing to claim on this pool (status ${phase}${
        phase === "expired" ? `, ${pool.expiryMode} mode` : ""
      })`,
      phase === "live"
        ? "claims open after the pool graduates or expires; sell on the curve to exit now"
        : phase === "ended"
          ? // Trading is closed but the pool is still `Open` on-chain, so no claim path is reachable
            // yet. Anyone can call expire_pool to unblock it; nothing automates that today.
            `the launch window closed at ${new Date(pool.endTs * 1000).toISOString()} but the pool has not been settled on-chain yet — claims open once expire_pool has been called for it`
          : phase === "upcoming"
            ? "the launch has not opened yet — there is nothing to claim"
            : "Dead-mode expiries sweep unraised funds to the treasury — there is no holder payout",
    );
  }

  // The API pre-validates fair/winner/graduated_tokens against the position, but not creator_vest —
  // that one only fails at the program's `has_one = creator` constraint, which reads as a raw anchor
  // error. Check it here so a non-creator (or a pool with no vest) gets a real explanation.
  if (kind === "creator_vest") {
    if (pool.creator !== claimant) {
      throw new CookieMcpError(
        "only the launch's creator can claim the creator vest",
        `the pool's creator is ${pool.creator}`,
      );
    }
    if (BigInt(pool.creatorVestAmount) <= 0n) {
      throw new CookieMcpError(
        "this pool has no creator vest to claim",
        "the creator allocation is only set aside at graduation — this pool has not graduated",
      );
    }
    if (BigInt(pool.creatorVestClaimed) >= BigInt(pool.creatorVestAmount)) {
      throw new CookieMcpError(
        "the whole creator vest has already been claimed",
        `${rawToUi(pool.creatorVestAmount, decs)} ${pool.symbol} was vested and fully claimed`,
      );
    }
  }

  let amount: string | undefined;
  let proof: number[][] | undefined;
  if (kind === "winner") {
    const win = await fetchWinnerProof(pool.pubkey, claimant);
    if (!win) {
      throw new CookieMcpError(
        "this wallet has no winning allocation in the pool's settlement",
        `${pool.expiryMode} mode pays out only the top wallets, and only once the settlement root is set`,
      );
    }
    amount = win.amount;
    proof = win.proof;
  }

  const built = await buildClaimTx({
    kind,
    claimant,
    pool: pool.pubkey,
    ...(amount ? { amount } : {}),
    ...(proof ? { proof } : {}),
  });
  const signature = await submitBuilt(built, keypair, "claim");

  // Estimate what landed: shares → SPL tokens 1:1 for graduated claims, COOK for payouts.
  const position = await fetchPosition(pool.pubkey, claimant).catch(() => null);
  let claimed: { estimate: string; symbol: string } | null = null;
  if (kind === "graduated_tokens" && position) {
    claimed = { estimate: rawToUi(position.shares, decs), symbol: pool.symbol };
  } else if (kind === "winner" && amount) {
    claimed = { estimate: rawToUi(amount, COOK_DECIMALS), symbol: COOK_SYMBOL };
  }

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    kind,
    claimed,
    links: { token: launchpadTokenUrl(pool.tokenMint) },
    ...(kind === "graduated_tokens"
      ? { note: "The SPL token is now in your wallet — trade it with trade / get_quote." }
      : {}),
  };
}

export interface ClaimCreatorFeesResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  claimed: { amount: string; symbol: string };
  links: { token: string };
}

/**
 * Sweep the creator's share of trading fees (35% of the 1% trade fee at time of writing) from a
 * launch you created. Requires the wallet to be the pool's creator; unwraps to native COOK.
 */
export async function claimCreatorFees(args: {
  ref: string;
  unwrap?: boolean;
}): Promise<ClaimCreatorFeesResult> {
  const { keypair } = requireWallet();
  const creator = keypair.publicKey.toBase58();

  const pool = await resolvePool(args.ref);
  if (pool.creator !== creator) {
    throw new CookieMcpError(
      "this wallet did not create that launch, so it has no creator fees to claim",
      `the pool's creator is ${pool.creator}`,
    );
  }

  const pending = await fetchPendingCreatorFees(pool.pubkey);
  if (!(pending > 0)) {
    throw new CookieMcpError(
      "no creator fees to claim yet",
      "creator fees accrue as the pool is traded (35% of the trade fee) — check back after some volume",
    );
  }

  const built = await buildClaimCreatorFeesTx({
    creator,
    pool: pool.pubkey,
    unwrap: args.unwrap ?? true,
  });
  const signature = await submitBuilt(built, keypair, "creator-fee claim");

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    claimed: { amount: String(pending), symbol: COOK_SYMBOL },
    links: { token: launchpadTokenUrl(pool.tokenMint) },
  };
}

export type { ClaimKind, ExpiryMode, PoolStatus, LaunchpadPosition };
