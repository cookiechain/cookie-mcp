// get_pools — pools across every Cookie Chain DEX from the markets feed, with TVL (USD) and 24h
// volume joined from the token registry (mint-level: the markets feed has no per-pool volume).
import { COOK_MINT } from "./config";
import { CookieMcpError } from "./errors";
import { fetchMarkets, fetchTokens, type CookiescanMarket } from "./cookiescan";
import { shortAddr } from "./format";

export interface PoolSummary {
  poolId: string;
  venue: string;
  base: { mint: string; symbol: string | null };
  quote: { mint: string; symbol: string | null };
  tvlUsd: number | null;
  // Joined from the token registry; unit unverified (Cookiescan /api/tokens only reliably gives USD via
  // `price.usd`), so not asserted as USD. Still a valid relative key for sort=volume.
  volume24h: number | null;
  liquidityDisplay: string | null;
}

export type PoolSort = "tvl" | "volume";

// The non-COOK side is the one the registry has volume for.
function nonCookMint(m: CookiescanMarket): string {
  if (m.quoteToken?.mint === COOK_MINT) return m.baseToken?.mint;
  if (m.baseToken?.mint === COOK_MINT) return m.quoteToken?.mint;
  return m.baseToken?.mint;
}

export function mapPools(
  markets: CookiescanMarket[],
  volumeByMint: Map<string, number>,
  opts: { limit: number; sort: PoolSort },
): PoolSummary[] {
  const rows: PoolSummary[] = markets.map((m) => ({
    poolId: m.marketId,
    venue: m.type,
    base: { mint: m.baseToken?.mint, symbol: m.baseToken?.symbol ?? null },
    quote: { mint: m.quoteToken?.mint, symbol: m.quoteToken?.symbol ?? null },
    tvlUsd: typeof m.liquidityUsd === "number" ? m.liquidityUsd : null,
    volume24h: volumeByMint.get(nonCookMint(m)) ?? null,
    liquidityDisplay: m.liquidityDisplay ?? null,
  }));
  const key = (p: PoolSummary) => (opts.sort === "volume" ? p.volume24h : p.tvlUsd) ?? -1;
  rows.sort((a, b) => key(b) - key(a));
  return rows.slice(0, opts.limit);
}

export async function getPools(opts?: { limit?: number; sort?: PoolSort }): Promise<{
  count: number;
  totalPools: number;
  sort: PoolSort;
  pools: PoolSummary[];
}> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  const sort = opts?.sort ?? "tvl";
  const [markets, tokens] = await Promise.all([fetchMarkets(), fetchTokens()]);
  if (markets.length === 0) {
    throw new CookieMcpError(
      "no pools returned by Cookiescan",
      "the markets feed may be temporarily empty; retry shortly",
    );
  }
  const volumeByMint = new Map<string, number>();
  for (const t of tokens) {
    const v = t.marketData?.volume24h;
    if (t.mint && typeof v === "number") volumeByMint.set(t.mint, v);
  }
  return {
    count: Math.min(limit, markets.length),
    totalPools: markets.length,
    sort,
    pools: mapPools(markets, volumeByMint, { limit, sort }),
  };
}

export function poolLabel(p: PoolSummary): string {
  const pair = `${p.base.symbol ?? shortAddr(p.base.mint)}/${p.quote.symbol ?? shortAddr(p.quote.mint)}`;
  return `${p.venue} ${pair}`;
}
