// Cookiebox swap aggregator client (agg.cookiebox.app) — the same router that powers cookiebox.app's
// trade page, exposed as a service. GET /quote quotes; POST /swap-tx re-quotes server-side and returns
// an UNSIGNED v0 transaction (fee payer = our wallet, ephemeral leg signers already applied), which we
// simulate on our own RPC, sign locally, send, and confirm — same non-custodial shape as Candy Shop.
import { COOKIEBOX_AGG_API_URL } from "./config";
import { fetchJson } from "./http";
import type { CandyShopMultiRoute } from "./candyshop";

// /swap-tx quotes, builds, and simulates server-side (a real network sim per DBC leg). It may also
// lazily extend the agg's server-owned lookup table inside the call (several sequential
// send+confirm txs plus an activation-slot wait on a cold oversized route), so give it headroom.
const SWAP_TX_TIMEOUT_MS = 60_000;

export interface AggSegment {
  pool: string;
  venue: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  percentage?: number;
  hopIndex: number;
}

export interface AggQuote {
  inAmount: string;
  outAmount: string;
  feePct: number;
  feeAmount: string;
  netOutAmount: string;
  minOutAmount: string;
  priceImpactPct: number | null;
  path: string[];
  isSplit: boolean;
  isMultiHop: boolean;
  segments: AggSegment[];
}

export interface AggSwapTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  route: AggQuote;
}

/**
 * Reshape the agg's quote JSON into the CandyShopMultiRoute shape the quote/trade formatters
 * consume, so both aggregators flow through the same downstream code. Pure — unit-tested.
 */
export function routeFromAggQuote(q: AggQuote): CandyShopMultiRoute {
  // Split share per segment: its input as a share of all inputs on the same hop — fallback for
  // agg builds that don't send `percentage` yet.
  const hopTotals = new Map<number, bigint>();
  for (const s of q.segments) {
    hopTotals.set(s.hopIndex, (hopTotals.get(s.hopIndex) ?? 0n) + BigInt(s.inAmount));
  }
  const feeBps = Math.round((q.feePct ?? 0) * 100);
  return {
    segments: q.segments.map((s) => {
      const hopTotal = hopTotals.get(s.hopIndex)!;
      return {
        dex: s.venue,
        poolAddress: s.pool,
        inAmount: s.inAmount,
        outAmount: s.outAmount,
        priceImpactPct: 0,
        percentage:
          s.percentage ??
          (hopTotal === 0n ? undefined : Number((BigInt(s.inAmount) * 100n) / hopTotal)),
        hopIndex: s.hopIndex,
        inputMint: s.inputMint,
        outputMint: s.outputMint,
      };
    }),
    totalInAmount: q.inAmount,
    totalOutAmount: q.netOutAmount ?? q.outAmount,
    grossOutAmount: q.outAmount,
    ...(feeBps > 0 ? { protocolFeeAmount: q.feeAmount, protocolFeeBps: feeBps } : {}),
    // null = the agg couldn't measure it (its router reports NaN → JSON null); NaN renders as "—"
    // downstream instead of a lying 0.
    combinedPriceImpactPct: q.priceImpactPct ?? NaN,
    minOutAmount: q.minOutAmount,
    route: q.path,
    isSplit: q.isSplit,
    isMultiHop: q.isMultiHop,
  };
}

/**
 * Quote via the Cookiebox. Returns null on 404 = "no route" (the caller maps that to the same
 * launchpad-aware no-route error the Candy Shop path uses).
 */
export async function quoteAgg(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  owner?: string | null,
): Promise<CandyShopMultiRoute | null> {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
    ...(owner ? { owner } : {}),
  });
  try {
    const body = await fetchJson<{ route: AggQuote }>(`${COOKIEBOX_AGG_API_URL}/quote?${q}`);
    return routeFromAggQuote(body.route);
  } catch (e) {
    if (e instanceof Error && /HTTP 404|no route/i.test(e.message)) return null;
    throw e;
  }
}

/**
 * Ask the agg to build the swap: it re-quotes and returns an unsigned v0 tx. The caller simulates,
 * signs, sends, and confirms on our own RPC using the returned blockhash/height.
 */
export async function buildAggSwapTx(args: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  owner: string;
}): Promise<AggSwapTx> {
  return fetchJson<AggSwapTx>(`${COOKIEBOX_AGG_API_URL}/swap-tx`, {
    method: "POST",
    body: JSON.stringify(args),
    timeoutMs: SWAP_TX_TIMEOUT_MS,
  });
}
