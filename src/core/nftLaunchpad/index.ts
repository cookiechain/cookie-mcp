// MomoSwap NFT launchpad (momoswap.fun/nft) — fixed-supply NFT drops on a bonding curve.
//
// A drop mints its items off a constant-product curve priced in COOK: each mint costs a little more
// than the last, and a holder can SELL an item back to the curve at the current price while the drop
// is live (the "guaranteed exit"). The drop graduates when it sells out, or earlier at a raise target
// the creator chose: a share of the raise is then locked forever as a floor every item can REDEEM
// against, the creator takes the rest, and the items trade on Baked Bazaar like any NFT. A drop whose
// window closes short winds down instead, and every holder can redeem the raise pro rata. After a
// target graduation the remaining units mint at random through a request a keeper settles.
//
// Unlike the token launchpad's curve shares, the items are real NFTs in the wallet from the first
// mint (Metaplex, immutable, verified into the collection), so `get_wallet_nfts` and the Baked Bazaar
// tools see them. The art stays hidden behind a committed reveal until the sale ends.
//
// Same non-custodial shape as the token launchpad: the API builds every transaction; we hold it to
// the program's IDL (verify.ts), simulate it within a spend budget (spendGuard.ts), sign locally, send.
import { NATIVE_MINT } from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import fs from "node:fs";

import { COOK_DECIMALS, COOK_SYMBOL, explorerTxUrl, nftDropUrl } from "../config";
import { confirmSent } from "../confirm";
import { withProvidedSignatures, type ProvidedSignature } from "../context";
import { resolveWallet } from "../domains";
import { CookieMcpError } from "../errors";
import { rawToUi, uiToRaw } from "../format";
import {
  anchorLogError,
  anchorLogSummary,
  assertBlockhashUsable,
  diagnosticLogTail,
  sendFailure,
  withLaunchSession,
} from "../launchpad";
import { getConnection } from "../rpc";
import {
  assertQuotedMinimum,
  LAUNCH_RENT_ALLOWANCE,
  NATIVE_FEE_ALLOWANCE,
  simulateWithinBudget,
  type SpendBudget,
} from "../spendGuard";
import type { TxSigner } from "../signer";
import { ownPublicKey, requireSigner, signerMode } from "../wallet";
import {
  buildNftBuyTx,
  buildNftClaimTx,
  buildNftCreateTx,
  buildNftRedeemTx,
  buildNftRequestMintTx,
  buildNftRevealTx,
  buildNftSellTx,
  buildNftWindDownTx,
  fetchNftBuyQuote,
  fetchNftCollection,
  fetchNftCollections,
  fetchNftItemCollection,
  fetchNftMintRequest,
  fetchNftOwnerItems,
  fetchNftRequestQuote,
  fetchNftSellQuote,
  fetchNftStatus,
  sealNftDrop,
  uploadNftArt,
  type NftBuiltTx,
  type NftCollection,
  type NftCollectionParams,
  type NftDropFilter,
  type SealDropRequest,
  type SealedDrop,
} from "./api";
import { readArtDir, readOneImage, readPiece, type ArtPiece } from "./art";
import {
  MAX_FLOOR_LOCK_BPS,
  MAX_TARGET_BPS,
  MIN_TARGET_BPS,
  allInToCurveRaw,
  curveToAllInRaw,
  designCurve,
  graduationSplit,
  profileCurve,
  selloutRaise,
  targetForBps,
  unitsToTarget,
} from "./curve";
import { assertNftBuild, nftProgramError, type NftExpectation, type NftKind } from "./verify";

export type { NftDropFilter } from "./api";

/** The site's default tolerance. A drop's price moves one unit per mint, so 1% covers a busy minute. */
export const NFT_DEFAULT_SLIPPAGE_BPS = 100;
/** Items per call. Each is its own transaction (a mint needs ~400k CU of the 1.4M limit). */
export const MAX_MINT_COUNT = 10;
/** Rent a mint opens on top of the payment: the item's mint, metadata, edition and token account. */
export const NFT_ITEM_RENT_ALLOWANCE = 30_000_000n;
/** A post-graduation request escrows the item's rent and opens its request and queue accounts. */
export const NFT_REQUEST_DEPOSIT_ALLOWANCE = 50_000_000n;
/** How long a mint request is watched for its keeper settle before handing back a pending result. */
const SETTLE_WAIT_MS = 20_000;

const cook = (raw: string | bigint): string => rawToUi(raw, COOK_DECIMALS);
const iso = (ts: number): string | null => (ts > 0 ? new Date(ts * 1000).toISOString() : null);

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Where a drop is, in terms of what can be done with it:
 *   upcoming — scheduled, not open yet
 *   live     — minting off the curve; holders can sell back
 *   sold-out — every unit minted, waiting for the (permissionless, keeper-run) graduation; sell-backs still work
 *   minting  — graduated at a target, the rest mint at random by request; holders redeem the floor
 *   graduated — done minting; holders redeem the floor or trade on Baked Bazaar
 *   ended    — the window closed short; holders redeem the wind-down refund
 */
export type NftDropPhase = "upcoming" | "live" | "sold-out" | "minting" | "graduated" | "ended";

/** Pure. The API's `state` is the on-chain one; the window and supply decide the rest. */
export function dropPhase(c: NftCollection, nowSec: number): NftDropPhase {
  if (c.state === "closed") return "ended";
  if (c.state === "graduated") return c.postGraduation?.open ? "minting" : "graduated";
  if (c.launchTs > nowSec) return "upcoming";
  if (c.endTs > 0 && nowSec > c.endTs) return "ended";
  if (BigInt(c.available) === 0n) return "sold-out";
  return "live";
}

/** What a holder of this drop's items can do now, as the tool to call. Pure. */
export function holderExit(c: NftCollection, phase: NftDropPhase): string {
  switch (phase) {
    case "live":
    case "sold-out":
      return "sell an item back to the curve at the current price with nft_drop_sell";
    case "minting":
    case "graduated":
      return BigInt(c.floorPriceRaw || "0") > 0n
        ? `redeem an item for the ${cook(c.floorPriceRaw)} ${COOK_SYMBOL} floor with nft_drop_redeem (burns it), or list it on Baked Bazaar with list_nft`
        : "list an item on Baked Bazaar with list_nft";
    case "ended":
      return c.windDown.available
        ? `redeem an item for the ${cook(c.windDown.priceRaw)} ${COOK_SYMBOL} wind-down refund with nft_drop_redeem (burns it)`
        : "nothing yet: the wind-down refund opens once the drop is closed on chain (anyone may close it)";
    case "upcoming":
      return "nothing to hold yet: the drop has not opened";
  }
}

export interface NftDropSummary {
  name: string;
  symbol: string;
  collectionMint: string;
  phase: NftDropPhase;
  minted: string;
  totalSupply: string;
  available: string;
  graduation: {
    model: "sellout" | "target";
    progressPct: number | null;
    targetCook: string | null;
    raisedCook: string | null;
  } | null;
  floorPriceCook: string | null;
  royaltyPct: number;
  opensAt: string | null;
  endsAt: string | null;
  link: string;
}

/** Pure. */
export function mapDropSummary(c: NftCollection, nowSec: number): NftDropSummary {
  const g = c.graduation;
  return {
    name: c.name,
    symbol: c.symbol,
    collectionMint: c.collectionMint,
    phase: dropPhase(c, nowSec),
    minted: c.minted,
    totalSupply: c.totalSupply,
    available: c.available,
    graduation: g
      ? {
          model: g.model,
          progressPct: Number.isFinite(g.progressBps) ? g.progressBps / 100 : null,
          targetCook: g.model === "target" ? cook(g.targetRaw) : cook(g.selloutRaiseRaw),
          raisedCook: g.raisedRaw ? cook(g.raisedRaw) : null,
        }
      : null,
    floorPriceCook: BigInt(c.floorPriceRaw || "0") > 0n ? cook(c.floorPriceRaw) : null,
    royaltyPct: c.sellerFeeBps / 100,
    opensAt: iso(c.launchTs),
    endsAt: iso(c.endTs),
    link: nftDropUrl(c.collectionMint),
  };
}

/** A drop by its collection mint, or by one of its items' mints. */
async function resolveDrop(ref: string): Promise<NftCollection> {
  const s = ref.trim();
  try {
    return await fetchNftCollection(s);
  } catch (e) {
    const viaItem = await fetchNftItemCollection(s);
    if (viaItem) return fetchNftCollection(viaItem);
    throw e;
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function getNftDrops(args: { status?: NftDropFilter; limit?: number }) {
  const status = args.status ?? "live";
  const limit = Math.max(1, Math.min(100, args.limit ?? 20));
  const [statusRes, list] = await Promise.all([
    fetchNftStatus(),
    fetchNftCollections(status, limit),
  ]);
  const now = Math.floor(Date.now() / 1000);
  return {
    filter: status,
    count: list.length,
    launchesOpen: statusRes.writable,
    drops: list.map((c) => mapDropSummary(c, now)),
    ...(list.length === 0
      ? {
          note:
            status === "all" ? "no drops yet" : `no ${status} drops right now — try status "all"`,
        }
      : {}),
  };
}

export async function getNftDrop(args: { collection: string; count?: number; owner?: string }) {
  const c = await resolveDrop(args.collection);
  const now = Math.floor(Date.now() / 1000);
  const phase = dropPhase(c, now);
  const count = Math.max(1, Math.min(MAX_MINT_COUNT, args.count ?? 1));
  const ownerKey = args.owner?.trim()
    ? (await resolveWallet(args.owner, "owner")).pubkey.toBase58()
    : ownPublicKey();

  const [buy, request, holdings] = await Promise.all([
    phase === "live" ? fetchNftBuyQuote(c.collectionMint, count).catch(() => null) : null,
    phase === "minting" ? fetchNftRequestQuote(c.collectionMint).catch(() => null) : null,
    ownerKey ? fetchNftOwnerItems(c.collectionMint, ownerKey).catch(() => null) : null,
  ]);
  const held =
    holdings?.details ?? holdings?.items.map((mint) => ({ mint, name: null, uri: null })) ?? [];
  const sell =
    held.length && (phase === "live" || phase === "sold-out")
      ? await fetchNftSellQuote(c.collectionMint).catch(() => null)
      : null;

  const g = c.graduation;
  const isCreator = ownerKey !== null && ownerKey === c.creator;
  return {
    ...mapDropSummary(c, now),
    creator: c.creator,
    collectionAddress: c.address,
    description: c.profile?.description ?? null,
    image: c.profile?.image ?? null,
    revealed: c.revealed,
    antiSnipe: c.antiSnipe,
    maxPerWallet: c.maxPerWallet === "0" ? null : c.maxPerWallet,
    allowlist: c.hasAllowlist ? { endsAt: iso(c.allowlistEndTs) } : null,
    floorLockPct: c.floorLockBps / 100,
    graduationDetail: g
      ? {
          ...(g.model === "target" ? { targetPctOfSellout: (g.targetBps ?? 0) / 100 } : {}),
          selloutRaiseCook: cook(g.selloutRaiseRaw),
          unitsToTarget: g.unitsToTarget,
          graduatedAt: g.graduatedAt ? iso(g.graduatedAt) : null,
        }
      : null,
    windDown: c.windDown.available ? { refundPerItemCook: cook(c.windDown.priceRaw) } : null,
    mintQuote: buy
      ? {
          items: buy.units,
          totalCook: cook(buy.totalRaw),
          tradeFeeCook: cook(buy.feeRaw),
          perItemCook: (buy.unitCostsRaw ?? []).map((u) => cook(u)),
          ...(buy.notStarted && buy.opensAt ? { opensAt: iso(buy.opensAt) } : {}),
        }
      : null,
    requestQuote: request
      ? {
          totalCook: cook(request.totalRaw),
          tradeFeeCook: cook(request.feeRaw),
          remaining: request.remaining,
          note: "after a target graduation each mint is a request: you pay now and a keeper settles a RANDOM remaining item within seconds",
        }
      : null,
    holdings: ownerKey
      ? {
          owner: ownerKey,
          items: held,
          ...(sell ? { sellBackNowCook: cook(sell.netRaw) } : {}),
          exit: held.length ? holderExit(c, phase) : null,
        }
      : null,
    ...(isCreator
      ? {
          creatorProceedsCook: cook(c.creatorProceedsRaw ?? "0"),
          ...(BigInt(c.creatorProceedsRaw ?? "0") > 0n
            ? { creatorAction: "claim the proceeds with nft_drop_claim" }
            : {}),
        }
      : {}),
  };
}

// ── build → verify → simulate → sign → send ──────────────────────────────────

/** A simulation the program refused, with its custom error code when it has one. */
export class NftSimFailure extends CookieMcpError {
  readonly code: number | null;
  constructor(message: string, hint: string, code: number | null) {
    super(message, hint);
    this.code = code;
  }
}

/** Advice for the codes an agent can act on; the rest get the program's own message. */
const CODE_HINTS: Record<number, string> = {
  6001: "the NFT launchpad is paused for new mints; exits (sell, redeem, claim) still work",
  6013: "the drop has not opened yet — get_nft_drop shows when it does",
  6014: "the drop's mint window has closed",
  6015: "the drop sold out",
  6016: "this wallet already holds the drop's per-wallet limit",
  6017: "the drop's opening window caps each wallet; mint fewer, or wait a few minutes",
  6018: "the drop is in its allowlist phase and this wallet is not on it",
  6019: "the drop is in its allowlist phase and this wallet is not on it",
  6031: "the price moved past the slippage allowed — re-quote with get_nft_drop and retry, or raise slippageBps / maxCookPerItem",
  6054: "the pool holds items sold back earlier, which are sold first — retry, the next build buys one of those",
};

/** Program errors in a failed simulation, as a sentence (pure). */
export function nftSimError(what: string, err: unknown, logs: string[] | null): NftSimFailure {
  const blob = JSON.stringify(err) ?? "";
  const m = /"Custom":(\d+)/.exec(blob);
  const code = m ? Number(m[1]) : null;
  const known = code !== null ? nftProgramError(code) : null;
  if (known) {
    return new NftSimFailure(
      `${what} would fail: ${known.msg} (${known.name})`,
      `${CODE_HINTS[code!] ?? "re-read the drop with get_nft_drop and retry"} — nothing was sent`,
      code,
    );
  }
  const anchor = anchorLogError(logs);
  if (anchor)
    return new NftSimFailure(
      `${what} would fail: ${anchorLogSummary(anchor)}`,
      "nothing was sent",
      code,
    );
  if (/insufficient|0x1\b/i.test(`${blob} ${logs?.join(" ") ?? ""}`)) {
    return new NftSimFailure(
      `${what} simulation failed: insufficient funds`,
      "check the wallet's COOK balance (it also pays rent for the item's accounts and the network fee)",
      code,
    );
  }
  const tail = diagnosticLogTail(logs);
  return new NftSimFailure(
    `${what} simulation failed${tail ? `: ${tail}` : ""}`,
    "nothing was sent",
    code,
  );
}

async function submitNft(
  built: NftBuiltTx,
  signer: TxSigner,
  what: string,
  kind: NftKind,
  known: NftExpectation,
  budget: SpendBudget,
  summary: Record<string, unknown>,
): Promise<string> {
  if (!built.transactionBase64) {
    throw new CookieMcpError(
      `the NFT launchpad returned no ${what} transaction`,
      "retry; the API may be degraded",
    );
  }
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(built.transactionBase64, "base64"));
  } catch {
    throw new CookieMcpError(
      `the ${what} transaction the NFT launchpad returned was malformed`,
      "retry",
    );
  }
  // Before anything else: the build must be the instructions this action calls, on the accounts asked
  // about, as the program's IDL lays them out.
  assertNftBuild(tx, kind, known);

  const conn = getConnection();
  const sim = await simulateWithinBudget(conn, tx, signer.publicKey, budget, {
    what,
    source: "MomoSwap NFT API",
  });
  if (sim.value.err) throw nftSimError(what, sim.value.err, sim.value.logs ?? null);
  // The API's blockhash has to be alive on our node: mints and creates are co-signed by keys the API
  // holds (the item / collection mint), so the blockhash cannot be refreshed here.
  await assertBlockhashUsable(conn, built, what);

  await signer.signTransaction(tx, {
    what,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
    summary,
  });
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize());
  } catch (e) {
    throw sendFailure(what, e);
  }
  return confirmSent(
    conn,
    { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
    what,
  );
}

function parseCook(v: string | number, field: string): bigint {
  let raw: bigint;
  try {
    raw = uiToRaw(v, COOK_DECIMALS);
  } catch {
    throw new CookieMcpError(
      `invalid ${field} "${v}"`,
      `pass a positive ${COOK_SYMBOL} amount, e.g. 150`,
    );
  }
  if (raw <= 0n)
    throw new CookieMcpError(
      `${field} must be greater than 0`,
      `pass a positive ${COOK_SYMBOL} amount`,
    );
  return raw;
}

function slippageOf(bps: number | undefined): number {
  const s = bps ?? NFT_DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(s) || s < 0 || s > 5_000) {
    throw new CookieMcpError("slippageBps must be a whole number from 0 to 5000", "100 = 1%");
  }
  return s;
}

/**
 * What one curve mint may do to the wallet: spend at most `maxSpend` (fee included) plus the rent for
 * the item's accounts, and the item has to arrive.
 */
export function mintBudget(maxSpend: bigint, nftMint: string): SpendBudget {
  return {
    native: NATIVE_FEE_ALLOWANCE + NFT_ITEM_RENT_ALLOWANCE + maxSpend,
    receive: { mint: nftMint, min: 1n },
  };
}

/** What giving an item back (sell, redeem) may do: only that item leaves, and at least `min` arrives. */
export function exitBudget(nftMint: string, min: bigint): SpendBudget {
  return {
    native: NATIVE_FEE_ALLOWANCE,
    tokens: new Map([[nftMint, 1n]]),
    receive: { mint: NATIVE_MINT.toBase58(), min },
  };
}

/** A creator claim spends nothing beyond fees and rent (a partner's ATA), and at least `own` arrives. */
export function claimBudget(own: bigint): SpendBudget {
  return { native: NATIVE_FEE_ALLOWANCE, receive: { mint: NATIVE_MINT.toBase58(), min: own } };
}

/** The creator's own share of a claim: the vault minus the royalty partner's floored share. */
export function creatorShare(totalRaw: bigint, partnerShareBps: number): bigint {
  return totalRaw - (partnerShareBps > 0 ? (totalRaw * BigInt(partnerShareBps)) / 10_000n : 0n);
}

/** total × (1 + slippage), rounded up: the most one item may cost, fee included. */
export function spendCap(totalRaw: bigint, slippageBps: number): bigint {
  return (totalRaw * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}

function phaseRefusal(c: NftCollection, phase: NftDropPhase, action: string): CookieMcpError {
  const why: Record<NftDropPhase, string> = {
    upcoming: `it opens at ${iso(c.launchTs)}`,
    live: "it is live",
    "sold-out": "it sold out and is waiting to graduate",
    minting: "it graduated at its target; remaining items mint at random by request",
    graduated: "it graduated",
    ended: "its mint window closed short",
  };
  return new CookieMcpError(
    `cannot ${action} "${c.name}" right now: ${why[phase]}`,
    `what a holder can do now: ${holderExit(c, phase)}`,
  );
}

// ── mint ─────────────────────────────────────────────────────────────────────

export interface NftMintedItem {
  nftMint: string;
  signature: string;
  explorerUrl: string;
  paidCook: string;
  /** A unit the pool held (sold back earlier), bought instead of a new mint. */
  returned?: true;
}

export async function mintNftDrop(args: {
  collection: string;
  count?: number;
  maxCookPerItem?: string | number;
  slippageBps?: number;
}) {
  const signer = requireSigner();
  const buyer = signer.publicKey.toBase58();
  const count = args.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_MINT_COUNT) {
    throw new CookieMcpError(
      `count must be 1 to ${MAX_MINT_COUNT}`,
      "each item is its own transaction",
    );
  }
  if (count > 1 && signerMode() === "external") {
    throw new CookieMcpError(
      "an external signer mints one item per call",
      "each item is its own transaction to sign; call nft_drop_mint once per item",
    );
  }
  const slippageBps = slippageOf(args.slippageBps);
  const cap =
    args.maxCookPerItem !== undefined ? parseCook(args.maxCookPerItem, "maxCookPerItem") : null;

  const c = await resolveDrop(args.collection);
  const phase = dropPhase(c, Math.floor(Date.now() / 1000));
  if (phase === "minting") {
    if (count > 1) {
      throw new CookieMcpError(
        `"${c.name}" graduated at its target: each remaining item is a request a keeper settles, one at a time per wallet`,
        "call nft_drop_mint with count 1 (or leave it out), then again once it settles",
      );
    }
    return requestMint(signer, c, cap, slippageBps);
  }
  if (phase !== "live") throw phaseRefusal(c, phase, "mint from");

  const items: NftMintedItem[] = [];
  let stoppedEarly: string | null = null;
  for (let i = 0; i < count; i++) {
    try {
      const quote = await fetchNftBuyQuote(c.collectionMint, 1, slippageBps);
      if (quote.notStarted) throw phaseRefusal(c, "upcoming", "mint from");
      const quoted = BigInt(quote.totalRaw);
      const maxSpend = cap ?? spendCap(quoted, slippageBps);
      if (quoted > maxSpend) {
        throw new CookieMcpError(
          `the next item costs ${cook(quoted)} ${COOK_SYMBOL} (fee included), above maxCookPerItem ${cook(maxSpend)}`,
          "raise maxCookPerItem, or wait for sell-backs to bring the price down",
        );
      }
      const built = await buildNftBuyTx({
        buyer,
        collectionMint: c.collectionMint,
        maxSpendRaw: maxSpend.toString(),
        slippageBps,
      });
      // The item must arrive, and nothing beyond the stated spend (plus the item's rent) may leave.
      const signature = await submitNft(
        built,
        signer,
        "NFT mint",
        "mint",
        { wallet: buyer, collectionMint: c.collectionMint, maxCost: maxSpend },
        mintBudget(maxSpend, built.nftMint),
        {
          drop: c.name,
          collection: c.collectionMint,
          item: i + 1,
          of: count,
          maxCook: cook(maxSpend),
        },
      );
      items.push({
        nftMint: built.nftMint,
        signature,
        explorerUrl: explorerTxUrl(signature),
        paidCook: cook(built.totalRaw),
        ...(built.returned ? { returned: true as const } : {}),
      });
      if (built.graduatesDrop && i < count - 1) {
        stoppedEarly =
          "this mint reached the drop's graduation target; the remaining items mint at random by request — call nft_drop_mint again";
        break;
      }
    } catch (e) {
      // The first item failing is the call failing. A later one keeps what already landed.
      if (items.length === 0) throw e;
      stoppedEarly = e instanceof Error ? e.message : String(e);
      break;
    }
  }

  const spent = items.reduce((s, it) => s + uiToRaw(it.paidCook, COOK_DECIMALS), 0n);
  return {
    drop: c.name,
    collectionMint: c.collectionMint,
    minted: items.length,
    requested: count,
    items,
    spent: { amount: cook(spent), symbol: COOK_SYMBOL },
    ...(stoppedEarly ? { stoppedEarly } : {}),
    links: { drop: nftDropUrl(c.collectionMint) },
    note:
      "The items are real NFTs in your wallet (get_wallet_nfts). " +
      (c.revealed ? "" : "The art stays hidden until the sale ends (a committed reveal). ") +
      "While the drop is live you can sell an item back to the curve with nft_drop_sell; after it " +
      "graduates you can redeem the floor with nft_drop_redeem or list it on Baked Bazaar with list_nft.",
  };
}

async function requestMint(
  signer: TxSigner,
  c: NftCollection,
  cap: bigint | null,
  slippageBps: number,
) {
  const buyer = signer.publicKey.toBase58();
  const quote = await fetchNftRequestQuote(c.collectionMint, slippageBps);
  const quoted = BigInt(quote.totalRaw);
  const maxSpend = cap ?? spendCap(quoted, slippageBps);
  if (quoted > maxSpend) {
    throw new CookieMcpError(
      `a mint request costs ${cook(quoted)} ${COOK_SYMBOL} (fee included), above maxCookPerItem ${cook(maxSpend)}`,
      "raise maxCookPerItem",
    );
  }
  const built = await buildNftRequestMintTx({
    buyer,
    collectionMint: c.collectionMint,
    maxSpendRaw: maxSpend.toString(),
    slippageBps,
  });
  const signature = await submitNft(
    built,
    signer,
    "NFT mint request",
    "request-mint",
    { wallet: buyer, collectionMint: c.collectionMint, maxCost: maxSpend },
    { native: NATIVE_FEE_ALLOWANCE + NFT_REQUEST_DEPOSIT_ALLOWANCE + maxSpend },
    { drop: c.name, collection: c.collectionMint, maxCook: cook(maxSpend), random: true },
  );

  // The keeper settles within seconds; wait a little so the usual answer names the item.
  const deadline = Date.now() + SETTLE_WAIT_MS;
  let view = null as Awaited<ReturnType<typeof fetchNftMintRequest>> | null;
  while (Date.now() < deadline) {
    view = await fetchNftMintRequest(built.request, built.minNonce).catch(() => null);
    if (view && (view.status === "settled" || view.status === "refunded")) break;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  const base = {
    drop: c.name,
    collectionMint: c.collectionMint,
    signature,
    explorerUrl: explorerTxUrl(signature),
    paidCook: cook(built.totalRaw),
    request: built.request,
    links: { drop: nftDropUrl(c.collectionMint) },
  };
  if (view?.status === "settled") {
    return {
      ...base,
      status: "settled",
      nftMint: view.itemMint ?? null,
      index: view.index ?? null,
    };
  }
  if (view?.status === "refunded") {
    return {
      ...base,
      status: "refunded",
      refundedCook: view.amountRaw ? cook(view.amountRaw) : null,
      note: "the request's randomness expired before a keeper settled it, so the payment went back",
    };
  }
  return {
    ...base,
    status: "pending",
    note:
      "paid and queued: a keeper settles it with a random remaining item, normally within seconds. " +
      "get_nft_drop lists your items once it lands. If no keeper settles it in ~3 minutes it can only be refunded.",
  };
}

// ── sell back / redeem ───────────────────────────────────────────────────────

async function dropForItem(nftMint: string, collection?: string): Promise<NftCollection> {
  if (collection?.trim()) return resolveDrop(collection);
  const mint = await fetchNftItemCollection(nftMint.trim());
  if (!mint) {
    throw new CookieMcpError(
      `${nftMint} is not an item of a MomoSwap NFT drop`,
      "pass the item's mint (get_nft_drop lists your items), or `collection` if you know the drop",
    );
  }
  return fetchNftCollection(mint);
}

export async function sellNftDrop(args: {
  nftMint: string;
  collection?: string;
  minCook?: string | number;
  slippageBps?: number;
}) {
  const signer = requireSigner();
  const seller = signer.publicKey.toBase58();
  const nftMint = args.nftMint.trim();
  const slippageBps = slippageOf(args.slippageBps);
  const c = await dropForItem(nftMint, args.collection);
  const phase = dropPhase(c, Math.floor(Date.now() / 1000));
  if (phase !== "live" && phase !== "sold-out") throw phaseRefusal(c, phase, "sell back to");

  const built = await buildNftSellTx({
    seller,
    collectionMint: c.collectionMint,
    nftMint,
    slippageBps,
  });
  // The build's minimum has to be what the slippage asked for allows on its own stated proceeds, or
  // the guard below would hold the sale to a floor the API picked (a quote of 1 accepts anything).
  const floor = assertQuotedMinimum(
    { totalOutAmount: built.netRaw, minOutAmount: built.minProceedsRaw },
    slippageBps,
    "NFT sell-back",
  );
  const asked = args.minCook !== undefined ? parseCook(args.minCook, "minCook") : null;
  if (asked !== null && floor < asked) {
    throw new CookieMcpError(
      `selling now pays ${cook(built.netRaw)} ${COOK_SYMBOL} (at least ${cook(floor)} after slippage), below minCook ${cook(asked)}`,
      "nothing was sent; wait for the price to rise, or lower minCook",
    );
  }
  const minProceeds = asked ?? floor;
  const signature = await submitNft(
    built,
    signer,
    "NFT sell-back",
    "sell",
    { wallet: seller, collectionMint: c.collectionMint, nftMint, minProceeds },
    exitBudget(nftMint, minProceeds),
    { drop: c.name, item: nftMint, expectCook: cook(built.netRaw) },
  );
  return {
    drop: c.name,
    nftMint,
    signature,
    explorerUrl: explorerTxUrl(signature),
    received: { estimate: cook(built.netRaw), minimum: cook(minProceeds), symbol: COOK_SYMBOL },
    tradeFee: { amount: cook(built.feeRaw), symbol: COOK_SYMBOL },
    note: "The item went back into the pool's inventory, which the next buyer gets first. Proceeds may arrive as wrapped COOK.",
  };
}

export async function redeemNftDrop(args: { nftMint: string; collection?: string }) {
  const signer = requireSigner();
  const holder = signer.publicKey.toBase58();
  const nftMint = args.nftMint.trim();
  const c = await dropForItem(nftMint, args.collection);
  const phase = dropPhase(c, Math.floor(Date.now() / 1000));

  const budgetFor = (price: bigint): SpendBudget => exitBudget(nftMint, price);
  const known = { wallet: holder, collectionMint: c.collectionMint, nftMint };

  if (phase === "graduated" || phase === "minting") {
    const price = BigInt(c.floorPriceRaw || "0");
    if (price === 0n) {
      throw new CookieMcpError(
        `"${c.name}" has no floor to redeem against`,
        "list the item on Baked Bazaar with list_nft instead",
      );
    }
    const built = await buildNftRedeemTx({ holder, collectionMint: c.collectionMint, nftMint });
    const signature = await submitNft(
      built,
      signer,
      "NFT floor redemption",
      "redeem",
      known,
      budgetFor(price),
      {
        drop: c.name,
        item: nftMint,
        floorCook: cook(price),
      },
    );
    return {
      drop: c.name,
      nftMint,
      kind: "floor",
      signature,
      explorerUrl: explorerTxUrl(signature),
      received: { amount: cook(price), symbol: COOK_SYMBOL },
      note: "The item was burned; the floor per remaining item is unchanged by a redemption.",
    };
  }

  if (c.windDown.available) {
    const price = BigInt(c.windDown.priceRaw);
    let built = await buildNftWindDownTx({ holder, collectionMint: c.collectionMint, nftMint });
    let signature: string;
    try {
      signature = await submitNft(
        built,
        signer,
        "NFT wind-down refund",
        "wind-down",
        known,
        budgetFor(price),
        {
          drop: c.name,
          item: nftMint,
          refundCook: cook(price),
        },
      );
    } catch (e) {
      // Someone closed the drop between the build and our simulation: rebuild without the close.
      if (!(e instanceof NftSimFailure) || !built.closesDrop || e.code !== 6012) throw e;
      built = await buildNftWindDownTx({
        holder,
        collectionMint: c.collectionMint,
        nftMint,
        skipClose: true,
      });
      signature = await submitNft(
        built,
        signer,
        "NFT wind-down refund",
        "wind-down",
        known,
        budgetFor(price),
        {
          drop: c.name,
          item: nftMint,
          refundCook: cook(price),
        },
      );
    }
    return {
      drop: c.name,
      nftMint,
      kind: "wind-down",
      signature,
      explorerUrl: explorerTxUrl(signature),
      received: { amount: cook(price), symbol: COOK_SYMBOL },
      ...(built.closesDrop ? { closedDrop: true } : {}),
      note: "The drop ended short, so every item redeems an equal share of what it raised. The item was burned.",
    };
  }
  throw phaseRefusal(c, phase, "redeem items of");
}

// ── creator ──────────────────────────────────────────────────────────────────

export async function claimNftDropProceeds(args: { collection: string }) {
  const signer = requireSigner();
  const creator = signer.publicKey.toBase58();
  const c = await resolveDrop(args.collection);
  if (c.creator !== creator) {
    throw new CookieMcpError(
      `this wallet did not create "${c.name}" (its creator is ${c.creator})`,
      "only the drop's creator can claim its proceeds",
    );
  }
  const total = BigInt(c.creatorProceedsRaw ?? "0");
  if (total === 0n) {
    throw new CookieMcpError(
      `"${c.name}" has no proceeds to claim right now`,
      "proceeds accrue from the creator's share of trade fees and the graduation payout",
    );
  }
  // A royalty partner takes their share of the vault in the same instruction.
  const own = creatorShare(total, c.partnerShareBps);
  const partnerCut = total - own;
  const built = await buildNftClaimTx({ creator, collectionMint: c.collectionMint });
  const signature = await submitNft(
    built,
    signer,
    "NFT creator claim",
    "claim",
    { wallet: creator, collectionMint: c.collectionMint },
    claimBudget(own),
    { drop: c.name, claimCook: cook(own) },
  );
  return {
    drop: c.name,
    signature,
    explorerUrl: explorerTxUrl(signature),
    received: { amount: cook(own), symbol: COOK_SYMBOL, unwrapped: built.unwrapped },
    ...(partnerCut > 0n
      ? { toRoyaltyPartner: { amount: cook(partnerCut), wallet: c.royaltyPartner } }
      : {}),
  };
}

export async function revealNftDrop(args: {
  collection: string;
  loginSignature?: ProvidedSignature;
}) {
  // The signer is resolved inside the context so an external one can see `loginSignature`.
  return withProvidedSignatures(args.loginSignature ? [args.loginSignature] : undefined, () =>
    revealInner(args.collection),
  );
}

async function revealInner(collection: string) {
  const signer = requireSigner();
  const creator = signer.publicKey.toBase58();
  const c = await resolveDrop(collection);
  if (c.creator !== creator) {
    throw new CookieMcpError(
      `this wallet did not create "${c.name}"`,
      "only the creator can reveal a drop",
    );
  }
  if (c.revealedOnChain) {
    throw new CookieMcpError(`"${c.name}" is already revealed on chain`, "nothing to do");
  }
  const built = await withLaunchSession(signer, (session) =>
    buildNftRevealTx({ creator, collectionMint: c.collectionMint }, session),
  );
  const signature = await submitNft(
    built,
    signer,
    "NFT reveal",
    "reveal",
    { wallet: creator, collectionMint: c.collectionMint },
    { native: NATIVE_FEE_ALLOWANCE },
    { drop: c.name },
  );
  return {
    drop: c.name,
    signature,
    explorerUrl: explorerTxUrl(signature),
    note: "The reveal seed is on chain: anyone can now check the item order against the commitment fixed at launch.",
  };
}

// ── launch ───────────────────────────────────────────────────────────────────

export interface CreateNftDropArgs {
  name: string;
  symbol: string;
  description?: string;
  artDir: string;
  imagePath?: string;
  bannerPath?: string;
  placeholderPath?: string;
  startPriceCook: string | number;
  curveMultiple?: number;
  royaltyPct?: number;
  floorLockPct?: number;
  royaltyPartner?: string;
  partnerSharePct?: number;
  graduationTargetPct?: number;
  launchAt?: string;
  durationHours?: number;
  maxPerWallet?: number;
  antiSnipe?: boolean;
  allowlist?: string[];
  allowlistHours?: number;
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
  dryRun?: boolean;
}

/** The launch wizard's defaults. */
const DEFAULTS = {
  curveMultiple: 4,
  royaltyPct: 5,
  floorLockPct: 20,
  durationHours: 24,
  allowlistHours: 1,
};

const httpsLink = (v: string | undefined, field: string): string | null => {
  const s = v?.trim();
  if (!s) return null;
  if (!/^https:\/\/[^\s"'<>]+$/i.test(s) || s.length > 200) {
    throw new CookieMcpError(`${field} must be an https URL`, `e.g. https://example.com`);
  }
  return s;
};

function pctToBps(v: number, field: string, min: number, max: number): number {
  const bps = Math.round(v * 100);
  if (!Number.isFinite(v) || bps < min || bps > max) {
    throw new CookieMcpError(
      `${field} must be between ${min / 100} and ${max / 100}`,
      "a percentage, e.g. 5 for 5%",
    );
  }
  return bps;
}

/** Everything about a launch that can be decided without uploading anything (pure apart from time). */
export function planNftDrop(
  args: CreateNftDropArgs,
  supply: number,
  terms: {
    tradeFeeBps: number;
    maxCreatorRoyaltyBps: number | null;
    maxStartAheadSeconds: number;
    targetGraduation: boolean;
    targetMaxSupply: number;
  },
  nowSec: number,
) {
  const name = args.name.trim();
  if (!name || Buffer.byteLength(name) > 24) {
    throw new CookieMcpError(
      "the drop name must be 1–24 bytes",
      "items are named `{name} #{n}`, which has to fit the 32-byte metadata name",
    );
  }
  const symbol = args.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(symbol))
    throw new CookieMcpError("the symbol must be 1–10 letters or digits", "e.g. CHADS");
  const description = (args.description ?? "").trim();
  if (description.length > 500)
    throw new CookieMcpError("the description is over 500 characters", "shorten it");

  const royaltyCap = terms.maxCreatorRoyaltyBps;
  if (royaltyCap === null) {
    throw new CookieMcpError(
      "MomoSwap's royalty settings do not allow new drops right now",
      "try again later",
    );
  }
  const royaltyBps = pctToBps(args.royaltyPct ?? DEFAULTS.royaltyPct, "royaltyPct", 0, royaltyCap);
  const floorLockBps = pctToBps(
    args.floorLockPct ?? DEFAULTS.floorLockPct,
    "floorLockPct",
    0,
    MAX_FLOOR_LOCK_BPS,
  );

  let partner: string | null = null;
  let partnerShareBps = 0;
  if (args.royaltyPartner?.trim()) {
    partner = args.royaltyPartner.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(partner)) {
      throw new CookieMcpError("royaltyPartner must be a wallet address", "or leave it out");
    }
    partnerShareBps = pctToBps(args.partnerSharePct ?? 0, "partnerSharePct", 100, 10_000);
  } else if (args.partnerSharePct) {
    throw new CookieMcpError(
      "partnerSharePct needs a royaltyPartner",
      "name the partner's wallet, or drop the share",
    );
  }

  const multiple = args.curveMultiple ?? DEFAULTS.curveMultiple;
  if (!(multiple >= 1.2 && multiple <= 25)) {
    throw new CookieMcpError(
      "curveMultiple must be between 1.2 and 25",
      "the last item's price ÷ the first's; 4 is the site's default",
    );
  }
  const startAllIn = parseCook(args.startPriceCook, "startPriceCook");
  const startCurve = allInToCurveRaw(startAllIn, terms.tradeFeeBps);
  const reserves = designCurve(supply, startCurve, multiple);
  if (!reserves)
    throw new CookieMcpError("those prices cannot be put on a curve", "raise startPriceCook");
  const profile = profileCurve(reserves, supply);

  let targetBps: number | null = null;
  let targetRaw: bigint | null = null;
  const targetPct = args.graduationTargetPct ?? 100;
  if (targetPct !== 100) {
    targetBps = pctToBps(targetPct, "graduationTargetPct", MIN_TARGET_BPS, MAX_TARGET_BPS - 1);
    if (!terms.targetGraduation) {
      throw new CookieMcpError(
        "graduating before sell-out is not enabled on the launchpad right now",
        "leave graduationTargetPct out (sell-out)",
      );
    }
    if (supply > terms.targetMaxSupply) {
      throw new CookieMcpError(
        `a drop that graduates early can have at most ${terms.targetMaxSupply} items`,
        "use fewer items, or graduate at sell-out",
      );
    }
    const sellout = selloutRaise(
      reserves.virtualPaymentReserve,
      reserves.virtualNftReserve,
      BigInt(supply),
    );
    if (sellout === null)
      throw new CookieMcpError("this curve cannot take a graduation target", "change the prices");
    targetRaw = targetForBps(sellout, targetBps);
  }

  let launchTs = nowSec;
  if (args.launchAt?.trim()) {
    const t = Date.parse(args.launchAt.trim());
    if (!Number.isFinite(t))
      throw new CookieMcpError("launchAt must be an ISO date-time", "e.g. 2026-11-01T18:00:00Z");
    launchTs = Math.max(nowSec, Math.floor(t / 1000));
    if (launchTs - nowSec > terms.maxStartAheadSeconds) {
      throw new CookieMcpError(
        `a drop can be scheduled at most ${Math.round(terms.maxStartAheadSeconds / 86_400)} days ahead`,
        "pick an earlier launchAt",
      );
    }
  }
  const hours = args.durationHours ?? DEFAULTS.durationHours;
  if (!(hours >= 0.25 && hours <= 24 * 30))
    throw new CookieMcpError(
      "durationHours must be between 0.25 and 720",
      "how long minting stays open",
    );
  const endTs = launchTs + Math.round(hours * 3600);

  const allowlist = [...new Set((args.allowlist ?? []).map((w) => w.trim()).filter(Boolean))];
  let allowlistEndTs = 0;
  if (allowlist.length) {
    const bad = allowlist.find((w) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w));
    if (bad)
      throw new CookieMcpError(
        `allowlist entry "${bad}" is not a wallet address`,
        "list wallet addresses only",
      );
    allowlistEndTs = launchTs + Math.round((args.allowlistHours ?? DEFAULTS.allowlistHours) * 3600);
    if (allowlistEndTs >= endTs)
      throw new CookieMcpError(
        "the allowlist phase must end before the mint window does",
        "shorten allowlistHours",
      );
  }
  const maxPerWallet = args.maxPerWallet ?? 0;
  if (!Number.isInteger(maxPerWallet) || maxPerWallet < 0)
    throw new CookieMcpError("maxPerWallet must be a whole number (0 = no limit)", "e.g. 5");

  const split = graduationSplit(profile.raiseRaw, floorLockBps, supply);
  const fee = terms.tradeFeeBps;
  return {
    name,
    symbol,
    description,
    supply,
    reserves,
    royaltyBps,
    floorLockBps,
    partner,
    partnerShareBps,
    targetBps,
    targetRaw,
    launchTs,
    endTs,
    allowlist,
    allowlistEndTs,
    maxPerWallet,
    antiSnipe: args.antiSnipe ?? true,
    preview: {
      items: supply,
      firstItemCook: cook(curveToAllInRaw(profile.firstRaw, fee)),
      lastItemCook: cook(curveToAllInRaw(profile.lastRaw, fee)),
      raiseAtSelloutCook: cook(profile.raiseRaw),
      floorAtSellout: { totalCook: cook(split.floorRaw), perItemCook: cook(split.floorPriceRaw) },
      creatorAtSelloutCook: cook(split.creatorRaw),
      graduation:
        targetRaw !== null
          ? {
              atRaiseCook: cook(targetRaw),
              afterItems: unitsToTarget(reserves, supply, targetRaw),
              then: "the remaining items mint at random, by request",
            }
          : { at: "sell-out" },
      tradeFeePct: fee / 100,
      royaltyPct: royaltyBps / 100,
      opensAt: iso(launchTs),
      endsAt: iso(endTs),
      ...(allowlist.length
        ? { allowlist: { wallets: allowlist.length, endsAt: iso(allowlistEndTs) } }
        : {}),
    },
  };
}

/** Pins already made in this process, by file identity, so a retried launch skips them. */
const pinned = new Map<string, { url: string; type: string }>();
/** Drops already sealed in this process, by the exact seal request: a retried create reuses its drop. */
const sealed = new Map<string, SealedDrop>();
const PIN_CONCURRENCY = 4;
const PIN_RETRIES = 2;

async function pinPiece(piece: ArtPiece, session: string): Promise<{ url: string; type: string }> {
  const stat = fs.statSync(piece.file);
  const key = `${piece.file}:${stat.size}:${stat.mtimeMs}`;
  const hit = pinned.get(key);
  if (hit) return hit;
  const { bytes, mimeType } = readPiece(piece);
  let last: unknown;
  for (let attempt = 0; attempt <= PIN_RETRIES; attempt++) {
    try {
      const pin = {
        url: await uploadNftArt(bytes, mimeType, piece.fileName, session),
        type: mimeType,
      };
      pinned.set(key, pin);
      return pin;
    } catch (e) {
      last = e;
      // A 4xx other than rate limiting will not heal on retry.
      if (e instanceof CookieMcpError && !/429|limit|timed out|network/i.test(e.message)) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new CookieMcpError(
    `could not upload ${piece.fileName}: ${last instanceof Error ? last.message : String(last)}`,
    "nothing was signed or spent; retry — pieces already uploaded are skipped",
  );
}

async function pinAll(
  pieces: ArtPiece[],
  session: string,
): Promise<{ url: string; type: string }[]> {
  const out: { url: string; type: string }[] = new Array(pieces.length);
  let next = 0;
  const worker = async () => {
    while (next < pieces.length) {
      const i = next++;
      out[i] = await pinPiece(pieces[i]!, session);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PIN_CONCURRENCY, pieces.length) }, worker));
  return out;
}

export async function createNftDrop(args: CreateNftDropArgs) {
  const status = await fetchNftStatus();
  if (!status.deployed)
    throw new CookieMcpError("the NFT launchpad is not deployed", "nothing to launch on");
  if (!args.dryRun && !status.writable) {
    throw new CookieMcpError(
      "MomoSwap NFT launches are closed right now",
      "try again later — dryRun still previews a drop",
    );
  }
  if (!args.dryRun && status.storage && !status.storage.configured) {
    throw new CookieMcpError(
      "the launchpad's IPFS storage is not available, so art cannot be uploaded",
      "try again later",
    );
  }
  const art = readArtDir(args.artDir);
  const nowSec = Math.floor(Date.now() / 1000);
  const plan = planNftDrop(
    args,
    art.pieces.length,
    {
      tradeFeeBps: status.tradeFeeBps ?? 0,
      maxCreatorRoyaltyBps: status.maxCreatorRoyaltyBps ?? null,
      maxStartAheadSeconds: status.maxStartAheadSeconds ?? 30 * 86_400,
      targetGraduation: status.targetGraduation ?? false,
      targetMaxSupply: status.targetGraduationLimits?.maxSupply ?? 10_000,
    },
    nowSec,
  );
  const image = args.imagePath?.trim()
    ? readOneImage(args.imagePath, "the collection image")
    : art.pieces[0]!;
  const banner = args.bannerPath?.trim() ? readOneImage(args.bannerPath, "the banner") : null;
  const placeholder = args.placeholderPath?.trim()
    ? readOneImage(args.placeholderPath, "the placeholder")
    : null;
  const extensions: Record<string, string> = {};
  for (const [k, v] of [
    ["website", args.website],
    ["twitter", args.x],
    ["telegram", args.telegram],
    ["discord", args.discord],
  ] as const) {
    const link = httpsLink(v, k === "twitter" ? "x" : k);
    if (link) extensions[k] = link;
  }
  const artSummary = {
    pieces: art.pieces.length,
    totalMB: Math.round(art.totalBytes / 1e5) / 10,
    withTraits: art.withMetadata,
    ...(art.warnings.length ? { warnings: art.warnings } : {}),
  };
  if (args.dryRun) {
    return {
      dryRun: true,
      launchesOpen: status.writable,
      art: artSummary,
      ...plan.preview,
      note:
        "Nothing was uploaded or signed. A launch is FINAL: the art, the order, the curve and the royalty " +
        "can never change. Run again without dryRun to launch.",
    };
  }

  const signer = requireSigner();
  const creator = signer.publicKey.toBase58();
  // The session covers the uploads, the seal and the build — never the signing: `withLaunchSession`
  // retries its callback once on a rejected token, which is only safe while nothing has been sent.
  const { built, drop, sealKey } = await withLaunchSession(signer, async (session) => {
    const pins = await pinAll(art.pieces, session);
    const imageUrl = image === art.pieces[0] ? pins[0]!.url : (await pinPiece(image, session)).url;
    const bannerUrl = banner ? (await pinPiece(banner, session)).url : null;
    const placeholderUrl = placeholder ? (await pinPiece(placeholder, session)).url : imageUrl;

    const request: SealDropRequest = {
      creator,
      name: plan.name,
      symbol: plan.symbol,
      description: plan.description,
      image: imageUrl,
      banner: bannerUrl,
      placeholder: placeholderUrl,
      extensions,
      // The type rides along: a gateway URL has no extension, and wallets want to know what the art is.
      items: art.pieces.map((p, i) => ({
        image: pins[i]!.url,
        type: pins[i]!.type,
        name: p.name,
        attributes: p.attributes,
      })),
      sellerFeeBps: plan.royaltyBps,
      ...(plan.targetBps !== null ? { graduationTargetBps: plan.targetBps } : {}),
    };
    const sealKey = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    let drop = sealed.get(sealKey);
    if (!drop) {
      drop = await sealNftDrop(request, session);
      sealed.set(sealKey, drop);
    }

    // `launch_ts` "now" is stamped at build time: the program refuses one more than 2 minutes old.
    const launchTs = args.launchAt?.trim() ? plan.launchTs : Math.floor(Date.now() / 1000);
    const params: NftCollectionParams = {
      name: plan.name,
      symbol: plan.symbol,
      base_uri: drop.baseUri,
      collection_uri: drop.collectionUri,
      total_supply: String(plan.supply),
      virtual_payment_reserve: plan.reserves.virtualPaymentReserve.toString(),
      virtual_nft_reserve: plan.reserves.virtualNftReserve.toString(),
      launch_ts: launchTs,
      end_ts: launchTs + (plan.endTs - plan.launchTs),
      max_per_wallet: String(plan.maxPerWallet),
      anti_snipe: plan.antiSnipe,
      allowlist_end_ts: plan.allowlist.length
        ? launchTs + (plan.allowlistEndTs - plan.launchTs)
        : 0,
      commitment: drop.commitment,
      seller_fee_bps: plan.royaltyBps,
      royalty_partner: plan.partner,
      partner_share_bps: plan.partnerShareBps,
      floor_lock_bps: plan.floorLockBps,
    };
    const built = await buildNftCreateTx(
      {
        creator,
        dropId: drop.dropId,
        params,
        ...(plan.allowlist.length ? { allowlist: plan.allowlist } : {}),
        ...(plan.targetBps !== null ? { graduationTargetBps: plan.targetBps } : {}),
      },
      session,
    );
    return { built, drop, sealKey };
  });

  if (built.mint !== drop.mint) {
    throw new CookieMcpError(
      `the create was built for collection ${built.mint}, not the sealed ${drop.mint}`,
      "refused before signing; retry, and report this if it persists",
    );
  }
  const signature = await submitNft(
    built,
    signer,
    "NFT drop launch",
    "create",
    { wallet: creator, collectionMint: drop.mint, graduationTarget: plan.targetRaw },
    { native: NATIVE_FEE_ALLOWANCE + LAUNCH_RENT_ALLOWANCE },
    { drop: plan.name, items: plan.supply, collection: drop.mint },
  );
  sealed.delete(sealKey);
  return {
    drop: plan.name,
    collectionMint: drop.mint,
    signature,
    explorerUrl: explorerTxUrl(signature),
    art: artSummary,
    ...plan.preview,
    commitment: drop.commitment,
    links: { drop: nftDropUrl(drop.mint) },
    note:
      "Launched. The art stays hidden until the sale ends, then MomoSwap publishes it to the IPFS folder " +
      "fixed at launch. Claim your proceeds with nft_drop_claim; once the sale is over, reveal_nft_drop " +
      "records the reveal seed on chain so anyone can verify the order.",
  };
}
