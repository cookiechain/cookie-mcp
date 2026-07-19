// get_quote — a Candy Shop swap quote formatted for an agent: expected out (gross), out after the
// ~20 bps fee, min out after slippage, price impact, and the route. No key needed. `amount` is a UI
// amount of the input token.
import { COOK_MINT, COOK_DECIMALS, COOK_SYMBOL, DEFAULT_SLIPPAGE_BPS } from "./config";
import { CookieMcpError } from "./errors";
import { fetchTokens } from "./cookiescan";
import { quoteMultiRoute, type CandyShopMultiRoute } from "./candyshop";
import { rawToUi, uiToRaw } from "./format";

export interface QuoteResult {
  input: { mint: string; symbol: string | null; amount: string };
  output: {
    mint: string;
    symbol: string | null;
    expectedOut: string; // gross
    outAfterCandyShopFee: string; // net of the ~20 bps fee
    minOut: string; // after slippage
  };
  priceImpactPct: string;
  candyShopFee: { bps: number | null; amount: string | null };
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
  return {
    input: { mint: ctx.inputMint, symbol: ctx.inSym, amount: rawToUi(r.totalInAmount, ctx.inDec) },
    output: {
      mint: ctx.outputMint,
      symbol: ctx.outSym,
      expectedOut: rawToUi(gross, ctx.outDec),
      outAfterCandyShopFee: rawToUi(r.totalOutAmount, ctx.outDec),
      minOut: rawToUi(r.minOutAmount, ctx.outDec),
    },
    priceImpactPct: `${Math.max(0, r.combinedPriceImpactPct ?? 0).toFixed(3)}%`,
    candyShopFee: {
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
}): Promise<QuoteResult> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (args.inputMint === args.outputMint) {
    throw new CookieMcpError("inputMint and outputMint are the same", "pick two different tokens");
  }
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

  const { multiRoute } = await quoteMultiRoute(
    args.inputMint,
    args.outputMint,
    amountRaw.toString(),
    slippageBps,
  );
  if (!multiRoute || !multiRoute.segments?.length) {
    throw new CookieMcpError(
      "no route found for this pair",
      "the pair may lack liquidity; try a smaller amount or a more liquid token",
    );
  }
  return formatQuote(multiRoute, {
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    inSym: inMeta.sym,
    outSym: outMeta.sym,
    inDec: inMeta.dec,
    outDec: outMeta.dec,
    slippageBps,
  });
}
