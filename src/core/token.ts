// get_token_info — metadata + market data for a mint from the Cookiescan registry.
import { COOK_MINT, COOK_SYMBOL, explorerTokenUrl } from "./config";
import { CookieMcpError } from "./errors";
import { fetchToken, fetchTokens, type CookiescanToken } from "./cookiescan";

export interface TokenInfo {
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  description: string | null;
  logo: string | null;
  priceUsd: number | null;
  priceCook: number | null;
  change24hPct: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  holderCount: number | null;
  supply: number | null;
  updateAuthority: string | null;
  cookieboxHosted: boolean;
  bondingProgress: null;
  explorerUrl: string;
  note?: string;
}

export function mapTokenInfo(t: CookiescanToken): TokenInfo {
  const logo = t.metadata?.logo ?? null;
  const usd = t.price?.usd != null ? Number(t.price.usd) : null;
  return {
    mint: t.mint,
    name: t.metadata?.name ?? null,
    symbol: t.metadata?.symbol ?? null,
    decimals: t.metadata?.decimals ?? null,
    description: t.metadata?.description ?? null,
    logo,
    priceUsd: usd != null && Number.isFinite(usd) ? usd : null,
    priceCook: t.price?.native ?? null,
    change24hPct: t.price?.change24h ?? null,
    marketCapUsd: t.marketData?.marketCap ?? null,
    liquidityUsd: t.marketData?.liquidity ?? null,
    volume24hUsd: t.marketData?.volume24h ?? null,
    holderCount: t.marketData?.holderCount ?? null,
    supply: t.marketData?.supply ?? null,
    updateAuthority: t.metadata?.updateAuthority ?? null,
    // Image hosted on Cookiebox's metadata CDN ⇒ launched via the Cookiebox DBC launchpad.
    cookieboxHosted: typeof logo === "string" && logo.startsWith("https://metadata.cookiebox.app"),
    bondingProgress: null,
    explorerUrl: explorerTokenUrl(t.mint),
    note: "bondingProgress/migrated not populated yet (needs an on-chain DBC read)",
  };
}

export async function getTokenInfo(mint: string): Promise<TokenInfo> {
  const t = await fetchToken(mint);
  if (mint === COOK_MINT && t) {
    return { ...mapTokenInfo(t), name: t.metadata?.name ?? "Cookie", symbol: COOK_SYMBOL };
  }
  if (!t) {
    throw new CookieMcpError(
      `token ${mint} not found in the Cookiescan registry`,
      "check the mint address; brand-new tokens can take a moment to be indexed",
    );
  }
  return mapTokenInfo(t);
}

// --- search --------------------------------------------------------------------------------------

export interface TokenSearchResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  priceCook: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  holderCount: number | null;
  explorerUrl: string;
}

// Match a token against a lowercased query, best-match-first. 0 = no match. Symbol/name exact beats
// prefix beats substring; a full-mint match is treated as exact, a mint prefix ranks with prefixes.
function tokenMatchScore(t: CookiescanToken, q: string): number {
  const sym = (t.metadata?.symbol ?? "").toLowerCase();
  const name = (t.metadata?.name ?? "").toLowerCase();
  const mint = t.mint.toLowerCase();
  if (mint === q) return 100;
  if (sym === q) return 95;
  if (name === q) return 90;
  if (sym.startsWith(q)) return 70;
  if (name.startsWith(q)) return 60;
  if (mint.startsWith(q)) return 55;
  if (sym.includes(q)) return 40;
  if (name.includes(q)) return 30;
  return 0;
}

function toSearchResult(t: CookiescanToken): TokenSearchResult {
  const usd = t.price?.usd != null ? Number(t.price.usd) : null;
  return {
    mint: t.mint,
    symbol: t.metadata?.symbol ?? null,
    name: t.metadata?.name ?? null,
    priceUsd: usd != null && Number.isFinite(usd) ? usd : null,
    priceCook: t.price?.native ?? null,
    liquidityUsd: t.marketData?.liquidity ?? null,
    volume24hUsd: t.marketData?.volume24h ?? null,
    holderCount: t.marketData?.holderCount ?? null,
    explorerUrl: explorerTokenUrl(t.mint),
  };
}

// Pure: rank the registry against a query. Ties (same score) break by liquidity, then 24h volume,
// so the "real" token surfaces above namesakes and dust. Network fetch is the caller's concern.
export function searchTokenRegistry(
  tokens: CookiescanToken[],
  query: string,
  limit: number,
): TokenSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return tokens
    .map((t) => ({ t, score: tokenMatchScore(t, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const lb = b.t.marketData?.liquidity ?? 0;
      const la = a.t.marketData?.liquidity ?? 0;
      if (lb !== la) return lb - la;
      return (b.t.marketData?.volume24h ?? 0) - (a.t.marketData?.volume24h ?? 0);
    })
    .slice(0, limit)
    .map((x) => toSearchResult(x.t));
}

/** Resolve a token name/ticker/mint-prefix to candidate mints via the Cookiescan registry. */
export async function searchTokens(
  query: string,
  limit = 20,
): Promise<{ query: string; count: number; results: TokenSearchResult[]; note?: string }> {
  const bounded = Math.min(Math.max(limit, 1), 50);
  const results = searchTokenRegistry(await fetchTokens(), query, bounded);
  const seen = new Set<string>();
  let ambiguous = false;
  for (const r of results) {
    const s = (r.symbol ?? "").toLowerCase();
    if (!s) continue;
    if (seen.has(s)) ambiguous = true;
    seen.add(s);
  }
  const note =
    results.length === 0
      ? "no tokens matched — try a shorter query or a partial symbol/name"
      : ambiguous
        ? "multiple tokens share a symbol; compare liquidity/volume/holders and confirm the mint before trading"
        : undefined;
  return { query, count: results.length, results, note };
}
