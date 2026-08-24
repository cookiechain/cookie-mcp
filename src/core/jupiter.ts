// Jupiter client — swaps on SOLANA MAINNET, not Cookie Chain. Used by `trade`/`get_quote` when
// `chain: "solana"`, whose main purpose is buying/selling the SPL COOK that the Hyperlane bridge
// moves (see bridge.ts / BRIDGE.solana.splMint).
//
// Same non-custodial shape as the Cookiebox agg: GET /swap/v1/quote quotes, POST /swap/v1/swap
// re-quotes server-side and returns an UNSIGNED v0 transaction (fee payer = our wallet), which we
// simulate on the Solana RPC, sign locally, send, and confirm.
//
// ⚠️ `So1111…112` means COOK on Cookie Chain but wSOL on Solana. Never resolve token metadata for
// this path through the Cookiescan registry — that registry prices Cookie Chain mints.
import {
  JUPITER_API_URL,
  JUPITER_API_KEY,
  HTTP_TIMEOUT_MS,
  SOL_MINT,
  SOL_DECIMALS,
  SOL_SYMBOL,
  BRIDGE,
} from "./config";
import { CookieMcpError } from "./errors";
import { fetchJson } from "./http";
import type { CandyShopMultiRoute } from "./candyshop";

// The build call re-quotes and runs a server-side simulation, so give it more headroom than a quote.
const SWAP_TX_TIMEOUT_MS = 30_000;

function headers(): Record<string, string> {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}

export interface JupSwapInfo {
  ammKey: string;
  label?: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  feeAmount?: string;
  feeMint?: string;
}

export interface JupRoutePlanStep {
  swapInfo: JupSwapInfo;
  percent?: number;
  bps?: number | null;
}

/**
 * The quote body, passed back VERBATIM to /swap — Jupiter treats it as an opaque token, so we keep
 * the whole object rather than reconstructing it from our normalized view.
 */
export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** minimum out after slippage (Jupiter's name for it). */
  otherAmountThreshold: string;
  swapMode?: string;
  slippageBps?: number;
  /** A DECIMAL FRACTION (0.0381 = 3.81%), and measured against Jupiter's price feed — see below. */
  priceImpactPct?: string | number | null;
  platformFee?: { amount?: string; feeBps?: number } | null;
  routePlan: JupRoutePlanStep[];
  swapUsdValue?: string;
  [k: string]: unknown;
}

export interface JupSwapTx {
  transactionBase64: string;
  lastValidBlockHeight: number;
  /** What Jupiter budgeted for priority fee, in lamports — reported so the cost is visible. */
  prioritizationFeeLamports: number | null;
  /** Jupiter's own server-side simulation result. Advisory: we simulate again on our RPC. */
  simulationError: unknown;
}

/**
 * Position each swap in the route by hop: a step consuming the overall input mint is hop 0, and any
 * step consuming a mint produced by an earlier hop sits one hop later. Derived rather than read off
 * the response because Jupiter's routePlan carries no hop index — only an implied order.
 *
 * Pure — unit-tested.
 */
export function assignHopIndexes(inputMint: string, plan: JupRoutePlanStep[]): number[] {
  // mint -> the earliest hop at which it is available as an input.
  const availableAt = new Map<string, number>([[inputMint, 0]]);
  const hops = new Array<number>(plan.length).fill(0);
  // A split route repeats the same input mint across steps, and a multi-hop leg only becomes
  // resolvable once its predecessor is placed, so sweep until nothing new resolves.
  const pending = new Set(plan.map((_, i) => i));
  while (pending.size) {
    let progressed = false;
    for (const i of [...pending]) {
      const at = availableAt.get(plan[i].swapInfo.inputMint);
      if (at === undefined) continue;
      hops[i] = at;
      const outAt = at + 1;
      const prev = availableAt.get(plan[i].swapInfo.outputMint);
      if (prev === undefined || outAt < prev) availableAt.set(plan[i].swapInfo.outputMint, outAt);
      pending.delete(i);
      progressed = true;
    }
    // Unreachable steps (a route shape we can't order) keep hop 0 rather than looping forever.
    if (!progressed) break;
  }
  return hops;
}

/**
 * Reshape a Jupiter quote into the CandyShopMultiRoute the quote/trade formatters consume, so the
 * Solana path reuses the same downstream reporting as both Cookie Chain aggregators. Pure —
 * unit-tested.
 */
export function routeFromJupQuote(q: JupQuote): CandyShopMultiRoute {
  const plan = q.routePlan ?? [];
  const hops = assignHopIndexes(q.inputMint, plan);
  const hopTotals = new Map<number, bigint>();
  for (let i = 0; i < plan.length; i++) {
    hopTotals.set(hops[i], (hopTotals.get(hops[i]) ?? 0n) + BigInt(plan[i].swapInfo.inAmount));
  }

  // Jupiter reports impact as a FRACTION; downstream renders a percent.
  const rawImpact = q.priceImpactPct == null ? NaN : Number(q.priceImpactPct);
  const impactPct = Number.isFinite(rawImpact) ? rawImpact * 100 : NaN;

  const feeBps = q.platformFee?.feeBps ?? 0;
  return {
    segments: plan.map((s, i) => {
      const hopTotal = hopTotals.get(hops[i])!;
      return {
        dex: s.swapInfo.label ?? s.swapInfo.ammKey,
        poolAddress: s.swapInfo.ammKey,
        inAmount: s.swapInfo.inAmount,
        outAmount: s.swapInfo.outAmount,
        priceImpactPct: 0,
        percentage:
          s.percent ??
          (hopTotal === 0n ? undefined : Number((BigInt(s.swapInfo.inAmount) * 100n) / hopTotal)),
        hopIndex: hops[i],
        inputMint: s.swapInfo.inputMint,
        outputMint: s.swapInfo.outputMint,
      };
    }),
    totalInAmount: q.inAmount,
    // Jupiter's outAmount is already net of the platform fee (we set none), so gross == net.
    totalOutAmount: q.outAmount,
    grossOutAmount: q.outAmount,
    ...(feeBps > 0 && q.platformFee?.amount
      ? { protocolFeeAmount: q.platformFee.amount, protocolFeeBps: feeBps }
      : {}),
    combinedPriceImpactPct: impactPct,
    minOutAmount: q.otherAmountThreshold,
    // Distinct mints in hop order — the same "path" notion the agg reports.
    route: [q.inputMint, ...plan.map((s) => s.swapInfo.outputMint)].filter(
      (m, i, a) => a.indexOf(m) === i,
    ),
    isSplit: new Set(hops).size < plan.length,
    isMultiHop: new Set(hops).size > 1,
  };
}

/** A 200 response can still carry an error body (e.g. TOKEN_NOT_TRADABLE), so check for it. */
function assertNoErrorBody(body: unknown): void {
  const e = (body as { error?: string; errorCode?: string } | null)?.error;
  if (e) throw new CookieMcpError(String(e), "check the mints are tradable on Solana mainnet");
}

/**
 * Quote on Solana via Jupiter. Returns null when the pair isn't routable, so the caller can raise
 * the same no-route error the Cookie Chain paths use.
 */
export async function quoteJup(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
): Promise<JupQuote | null> {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
  });
  let body: JupQuote;
  try {
    body = await fetchJson<JupQuote>(`${JUPITER_API_URL}/swap/v1/quote?${q}`, {
      headers: headers(),
      timeoutMs: HTTP_TIMEOUT_MS,
    });
  } catch (e) {
    if (e instanceof Error && /not tradable|no route|route not found|HTTP 404/i.test(e.message)) {
      return null;
    }
    throw e;
  }
  const errText = (body as { error?: string }).error;
  if (errText) {
    if (/not tradable|no route|route not found/i.test(String(errText))) return null;
    assertNoErrorBody(body);
  }
  if (!body?.routePlan?.length) return null;
  return body;
}

/**
 * Ask Jupiter to build the swap. The returned tx already carries its own blockhash, so this path
 * never calls getLatestBlockhash — one less RPC round trip on a rate-limited endpoint.
 */
export async function buildJupSwapTx(args: { quote: JupQuote; owner: string }): Promise<JupSwapTx> {
  const body = await fetchJson<{
    swapTransaction: string;
    lastValidBlockHeight: number;
    prioritizationFeeLamports?: number;
    simulationError?: unknown;
  }>(`${JUPITER_API_URL}/swap/v1/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      quoteResponse: args.quote,
      userPublicKey: args.owner,
      // Wrap/unwrap SOL automatically so a plain SOL balance can buy, and a sale lands as SOL.
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
    timeoutMs: SWAP_TX_TIMEOUT_MS,
  });
  assertNoErrorBody(body);
  if (!body?.swapTransaction) {
    throw new CookieMcpError(
      "Jupiter did not return a swap transaction",
      "re-quote and retry; the route may have gone stale",
    );
  }
  return {
    transactionBase64: body.swapTransaction,
    lastValidBlockHeight: body.lastValidBlockHeight,
    prioritizationFeeLamports: body.prioritizationFeeLamports ?? null,
    simulationError: body.simulationError ?? null,
  };
}

export interface JupTokenMeta {
  decimals: number;
  symbol: string | null;
}

/**
 * Decimals + symbol for Solana mints, from Jupiter's own token index. The Cookiescan registry must
 * NOT be used here: it describes Cookie Chain mints, and `So1111…112` means a different asset on
 * each chain.
 */
export async function fetchJupTokenMeta(mints: string[]): Promise<Map<string, JupTokenMeta>> {
  const out = new Map<string, JupTokenMeta>();
  const unique = [...new Set(mints)];
  if (!unique.length) return out;
  const body = await fetchJson<
    Array<{ id: string; symbol?: string; decimals?: number }> | { error?: string }
  >(`${JUPITER_API_URL}/tokens/v2/search?query=${unique.join(",")}`, {
    headers: headers(),
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  if (!Array.isArray(body)) {
    assertNoErrorBody(body);
    return out;
  }
  for (const t of body) {
    if (t?.id && typeof t.decimals === "number") {
      out.set(t.id, { decimals: t.decimals, symbol: t.symbol ?? null });
    }
  }
  return out;
}

/**
 * Decimals + symbol for the two ends of a Solana swap, with wSOL filled in locally so a SOL-only
 * swap needs no token lookup at all. An unknown mint is left absent rather than defaulted: guessing
 * 9 decimals would silently misscale the amount.
 */
export async function resolveSolanaMeta(
  mints: string[],
): Promise<Map<string, { dec: number; sym: string | null }>> {
  const out = new Map<string, { dec: number; sym: string | null }>();
  out.set(SOL_MINT, { dec: SOL_DECIMALS, sym: SOL_SYMBOL });
  const need = [...new Set(mints)].filter((m) => m !== SOL_MINT);
  if (need.length) {
    const meta = await fetchJupTokenMeta(need);
    for (const m of need) {
      const t = meta.get(m);
      if (t) out.set(m, { dec: t.decimals, sym: t.symbol });
    }
  }
  return out;
}

/** The decimals of a Solana mint, or a clear error — never a silent default. */
export function requireSolanaMeta(
  meta: Map<string, { dec: number; sym: string | null }>,
  mint: string,
): { dec: number; sym: string | null } {
  const m = meta.get(mint);
  if (!m) {
    throw new CookieMcpError(
      `unknown Solana mint ${mint}`,
      "Jupiter does not index this mint — check the address, or that it trades on Solana mainnet",
    );
  }
  return m;
}

/**
 * `chain: "solana"` means Jupiter. Reject an explicit Cookie Chain aggregator instead of silently
 * ignoring it — the caller asked for a venue that cannot serve that chain.
 */
export function assertSolanaAggregator(aggregator?: string): void {
  if (aggregator && aggregator !== "jupiter") {
    throw new CookieMcpError(
      `aggregator "${aggregator}" only routes Cookie Chain liquidity, not Solana`,
      'omit `aggregator` (or pass "jupiter") when chain is "solana"',
    );
  }
}

/** Solana-side COOK: the SPL mint the Hyperlane warp route locks. The only asset tradable here. */
export const COOK_SPL_MINT = BRIDGE.solana.splMint;

/**
 * The Solana path is deliberately scoped to BUYING AND SELLING COOK, not general Solana swapping:
 * one leg must be SPL COOK. Jupiter would happily route any pair, but routing unrelated Solana
 * markets is outside what this server is for, and every extra pair is surface that can move funds.
 * So `SOL -> COOK` and `COOK -> USDC` are fine; `SOL -> USDC` is refused.
 *
 * Pure — unit-tested.
 */
export function assertSolanaCookPair(inputMint: string, outputMint: string): void {
  if (inputMint === COOK_SPL_MINT || outputMint === COOK_SPL_MINT) return;
  throw new CookieMcpError(
    "the Solana side only trades COOK",
    `one of inputMint/outputMint must be SPL COOK (${COOK_SPL_MINT}) — this server swaps Solana ` +
      `liquidity to buy or sell COOK, not arbitrary Solana pairs. For any Cookie Chain pair, omit ` +
      `\`chain\` instead.`,
  );
}
