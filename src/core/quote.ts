// get_quote — a swap quote formatted for an agent: expected out (gross), out after any aggregator
// fee, min out after slippage, price impact, and the route. Two aggregators: Cookiebox and Candy Shop / Cookiescan.
// No key needed. `amount` is a UI amount of the input token.
import {
  COOK_MINT,
  COOK_DECIMALS,
  COOK_SYMBOL,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_SWAP_AGGREGATOR,
  type SwapAggregator,
  type TradeChain,
} from "./config";
import { CookieMcpError } from "./errors";
import { fetchTokens } from "./cookiescan";
import { quoteMultiRoute, type CandyShopMultiRoute } from "./candyshop";
import { quoteAgg } from "./cookiebox";
import {
  quoteJup,
  routeFromJupQuote,
  resolveSolanaMeta,
  requireSolanaMeta,
  assertSolanaAggregator,
  assertSolanaCookPair,
} from "./jupiter";
import { ownPublicKey } from "./wallet";
import { rawToUi, uiToRaw } from "./format";
import { noRouteError } from "./launchpad";

export interface QuoteResult {
  chain: TradeChain;
  aggregator: SwapAggregator;
  input: { mint: string; symbol: string | null; amount: string };
  output: {
    mint: string;
    symbol: string | null;
    expectedOut: string; // gross
    outAfterFee: string; // net of the aggregator fee (equal to expectedOut when there is none)
    minOut: string; // after slippage
  };
  priceImpactPct: string;
  aggregatorFee: { bps: number | null; amount: string | null };
  slippageBps: number;
  route: {
    split: boolean;
    multiHop: boolean;
    lowLiquidity: boolean;
    hops: Array<{ venue: string; poolAddress: string; inAmountRaw: string; outAmountRaw: string }>;
  };
}

export function formatQuote(
  r: CandyShopMultiRoute,
  ctx: {
    chain: TradeChain;
    aggregator: SwapAggregator;
    inputMint: string;
    outputMint: string;
    inSym: string | null;
    outSym: string | null;
    inDec: number;
    outDec: number;
    slippageBps: number;
  },
): QuoteResult {
  const gross = r.grossOutAmount ?? r.totalOutAmount;
  const impact = r.combinedPriceImpactPct;
  return {
    chain: ctx.chain,
    aggregator: ctx.aggregator,
    input: { mint: ctx.inputMint, symbol: ctx.inSym, amount: rawToUi(r.totalInAmount, ctx.inDec) },
    output: {
      mint: ctx.outputMint,
      symbol: ctx.outSym,
      expectedOut: rawToUi(gross, ctx.outDec),
      outAfterFee: rawToUi(r.totalOutAmount, ctx.outDec),
      minOut: rawToUi(r.minOutAmount, ctx.outDec),
    },
    // NaN = the aggregator couldn't measure impact; "—" beats a lying 0.
    priceImpactPct: Number.isNaN(impact) ? "—" : `${Math.max(0, impact ?? 0).toFixed(3)}%`,
    aggregatorFee: {
      bps: r.protocolFeeBps ?? null,
      amount: r.protocolFeeAmount != null ? rawToUi(r.protocolFeeAmount, ctx.outDec) : null,
    },
    slippageBps: ctx.slippageBps,
    route: {
      split: Boolean(r.isSplit),
      multiHop: Boolean(r.isMultiHop),
      lowLiquidity: Boolean(r.lowLiquidity),
      // Per-hop amounts stay raw: intermediate-hop mints have unknown decimals. The human-readable
      // numbers are the top-level input/output amounts.
      hops: r.segments.map((s) => ({
        venue: s.programName ?? s.dex,
        poolAddress: s.poolAddress,
        inAmountRaw: s.inAmount,
        outAmountRaw: s.outAmount,
      })),
    },
  };
}

async function resolveDecimals(
  mints: string[],
): Promise<Map<string, { dec: number; sym: string | null }>> {
  const out = new Map<string, { dec: number; sym: string | null }>();
  const need = mints.filter((m) => m !== COOK_MINT);
  out.set(COOK_MINT, { dec: COOK_DECIMALS, sym: COOK_SYMBOL });
  if (need.length) {
    const registry = await fetchTokens();
    for (const m of need) {
      const t = registry.find((x) => x.mint === m);
      out.set(m, { dec: t?.metadata?.decimals ?? 9, sym: t?.metadata?.symbol ?? null });
    }
  }
  return out;
}

export async function getQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps?: number;
  aggregator?: SwapAggregator;
  chain?: TradeChain;
}): Promise<QuoteResult> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const chain = args.chain ?? "cookie";
  if (args.inputMint === args.outputMint) {
    throw new CookieMcpError("inputMint and outputMint are the same", "pick two different tokens");
  }
  if (chain === "solana") return quoteSolana(args, slippageBps);
  const aggregator = args.aggregator ?? DEFAULT_SWAP_AGGREGATOR;
  const dec = await resolveDecimals([args.inputMint, args.outputMint]);
  const inMeta = dec.get(args.inputMint)!;
  const outMeta = dec.get(args.outputMint)!;

  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, inMeta.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is a UI amount of the input token (max ${inMeta.dec} decimals)`,
    );
  }
  if (amountRaw <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive input amount");
  }

  // A launchpad token that hasn't graduated has no DEX pool at all, so "no route" is expected and the
  // agent should be sent to the launchpad tools instead — see noRouteError.
  let multiRoute: CandyShopMultiRoute | null | undefined;
  try {
    if (aggregator === "cookiebox") {
      multiRoute = await quoteAgg(
        args.inputMint,
        args.outputMint,
        amountRaw.toString(),
        slippageBps,
        ownPublicKey(),
      );
    } else {
      ({ multiRoute } = await quoteMultiRoute(
        args.inputMint,
        args.outputMint,
        amountRaw.toString(),
        slippageBps,
      ));
    }
  } catch (e) {
    throw await noRouteError([args.inputMint, args.outputMint], e);
  }
  if (!multiRoute || !multiRoute.segments?.length) {
    throw await noRouteError([args.inputMint, args.outputMint]);
  }
  return formatQuote(multiRoute, {
    chain,
    aggregator,
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    inSym: inMeta.sym,
    outSym: outMeta.sym,
    inDec: inMeta.dec,
    outDec: outMeta.dec,
    slippageBps,
  });
}

/**
 * Quote on Solana mainnet via Jupiter. Read-only and RPC-free — Jupiter serves both the route and
 * the token metadata, so this works with no Solana RPC configured at all.
 */
async function quoteSolana(
  args: {
    inputMint: string;
    outputMint: string;
    amount: string | number;
    aggregator?: SwapAggregator;
  },
  slippageBps: number,
): Promise<QuoteResult> {
  assertSolanaAggregator(args.aggregator);
  assertSolanaCookPair(args.inputMint, args.outputMint);
  const meta = await resolveSolanaMeta([args.inputMint, args.outputMint]);
  const inMeta = requireSolanaMeta(meta, args.inputMint);
  const outMeta = requireSolanaMeta(meta, args.outputMint);

  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, inMeta.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is a UI amount of the input token (max ${inMeta.dec} decimals)`,
    );
  }
  if (amountRaw <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive input amount");
  }

  const jup = await quoteJup(args.inputMint, args.outputMint, amountRaw.toString(), slippageBps);
  if (!jup) {
    throw new CookieMcpError(
      "no Solana route for this pair",
      "Jupiter found no route — check both mints trade on Solana mainnet, or try a smaller amount",
    );
  }
  return formatQuote(routeFromJupQuote(jup), {
    chain: "solana",
    aggregator: "jupiter",
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    inSym: inMeta.sym,
    outSym: outMeta.sym,
    inDec: inMeta.dec,
    outDec: outMeta.dec,
    slippageBps,
  });
}
