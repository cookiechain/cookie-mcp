// Cookiebox swap aggregator client (agg.cookiebox.app) — the same router that powers cookiebox.app's
// trade page, exposed as a service. GET /quote quotes; POST /swap-tx re-quotes server-side and returns
// an UNSIGNED v0 transaction (fee payer = our wallet, ephemeral leg signers already applied), which we
// simulate on our own RPC, sign locally, send, and confirm — same non-custodial shape as Candy Shop.
import { COOKIEBOX_AGG_API_URL } from "./config";
import { CookieMcpError } from "./errors";
import { fetchJson } from "./http";
import type { CandyShopMultiRoute, RouteWarning } from "./candyshop";

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
  /** Absent on agg builds that predate transfer-hook support. */
  warnings?: RouteWarning[];
}

export interface AggSwapTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  route: AggQuote;
  /** Echo of the native-side flags the server built with (absent on builds that predate them). */
  wrapSol?: boolean;
  unwrapSol?: boolean;
}

/**
 * How the agg handles native COOK on a swap. Both default to `true` (COOK in, COOK out; the tx
 * wraps into a throwaway account and unwraps at the end, never touching our wCOOK ATA).
 * `wrapSol: false` pays a native input straight from our wCOOK ATA; `unwrapSol: false` delivers a
 * native output to it as wCOOK. COOK and wCOOK are the same mint, so this is the ONLY way to say
 * which one you mean.
 */
export interface AggNativeFlags {
  wrapSol?: boolean;
  unwrapSol?: boolean;
}

/**
 * An agg build that predates `wrapSol`/`unwrapSol` ignores them and unwraps — the user would get
 * COOK where they asked for wCOOK. It also doesn't echo them, so a non-default request without a
 * matching echo is refused BEFORE signing. A default request is safe against any build.
 */
export function assertAggNativeFlagsHonoured(
  requested: AggNativeFlags,
  echoed: AggNativeFlags,
): void {
  const wrapSol = requested.wrapSol ?? true;
  const unwrapSol = requested.unwrapSol ?? true;
  if (wrapSol && unwrapSol) return;
  if ((echoed.wrapSol ?? true) !== wrapSol || (echoed.unwrapSol ?? true) !== unwrapSol) {
    throw new CookieMcpError(
      "the Cookiebox aggregator did not honour wrapSol/unwrapSol (build predates them)",
      "omit the flags to swap plain COOK, or retry once agg.cookiebox.app is redeployed",
    );
  }
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
    ...(q.warnings && q.warnings.length > 0 ? { warnings: q.warnings } : {}),
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
export async function buildAggSwapTx(
  args: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    owner: string;
  } & AggNativeFlags,
): Promise<AggSwapTx> {
  const built = await fetchJson<AggSwapTx>(`${COOKIEBOX_AGG_API_URL}/swap-tx`, {
    method: "POST",
    body: JSON.stringify(args),
    timeoutMs: SWAP_TX_TIMEOUT_MS,
  });
  assertAggNativeFlagsHonoured(args, built);
  return built;
}
