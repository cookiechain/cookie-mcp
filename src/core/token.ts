// get_token_info — metadata + market data for a mint from the Cookiescan registry.
import { COOK_MINT, COOK_SYMBOL, explorerTokenUrl } from "./config";
import { CookieMcpError } from "./errors";
import { fetchToken, fetchTokens, fetchCookPriceUsd, type CookiescanToken } from "./cookiescan";
import { launchpadTokenIdentity, type LaunchpadTokenIdentity } from "./launchpad";

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
  liquidityCook: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  holderCount: number | null;
  supply: number | null;
  updateAuthority: string | null;
  explorerUrl: string;
  /**
   * Present only when the mint has no market because it lives on the MomoSwap launchpad — a
   * pre-graduation curve has no DEX pool, so price/liquidity read as 0 and swaps find no route.
   */
  launchpad?: { pool: string; status: string; note: string };
}

/** A token with no price AND no liquidity may simply be on a launchpad curve — worth a lookup. */
export function looksUnpriced(info: TokenInfo): boolean {
  return !info.priceUsd && !info.priceCook && !info.liquidityCook;
}

export function mapTokenInfo(t: CookiescanToken, cookPriceUsd?: number | null): TokenInfo {
  const logo = t.metadata?.logo ?? null;
  const usd = t.price?.usd != null ? Number(t.price.usd) : null;
  // Cookiescan reports `marketData.liquidity` in native COOK (NOT USD, unlike marketCap). Convert to
  // USD via the COOK price when we have it; always surface the raw COOK figure too.
  const liqCook = t.marketData?.liquidity ?? null;
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
    liquidityCook: liqCook,
    liquidityUsd: liqCook != null && cookPriceUsd != null ? liqCook * cookPriceUsd : null,
    // Cookiescan reports this figure but its unit is unverified (only `price.usd` is a reliable USD
    // value from /api/tokens) — surfaced unit-neutral, not asserted as USD.
    volume24h: t.marketData?.volume24h ?? null,
    holderCount: t.marketData?.holderCount ?? null,
    supply: t.marketData?.supply ?? null,
    updateAuthority: t.metadata?.updateAuthority ?? null,
    explorerUrl: explorerTokenUrl(t.mint),
  };
}

/**
 * The curve price, but only when quoting it as *the* price is honest — i.e. while the curve is the
 * token's live market. Once a launch has `ended`/`expired` the curve is frozen and nobody can transact
 * at that number; once it has `graduated` the real market is a DEX pool and the curve price is stale.
 * In both cases reporting it as `priceCook` would be a price nothing can be traded at.
 */
function tradeableCurvePrice(lp: LaunchpadTokenIdentity): number | null {
  if (lp.status !== "live") return null;
  return lp.priceCook > 0 && Number.isFinite(lp.priceCook) ? lp.priceCook : null;
}

/**
 * Describe a token the Cookiescan registry has never indexed, purely from its launchpad pool (pure).
 * Every market field stays null on purpose — a pre-graduation curve has no DEX market, and inventing
 * a liquidity or market-cap figure from curve reserves would be a fabricated number. The curve price
 * is filled only while it is live (see above), and `launchpad` says why it is not swappable.
 */
export function launchpadOnlyTokenInfo(
  mint: string,
  lp: LaunchpadTokenIdentity,
  cookPriceUsd?: number | null,
): TokenInfo {
  const priceCook = tradeableCurvePrice(lp);
  return {
    mint,
    name: lp.name || null,
    symbol: lp.symbol || null,
    decimals: lp.decimals,
    description: null,
    logo: null,
    priceUsd: priceCook != null && cookPriceUsd != null ? priceCook * cookPriceUsd : null,
    priceCook,
    change24hPct: null,
    marketCapUsd: null,
    liquidityCook: null,
    liquidityUsd: null,
    volume24h: null,
    holderCount: null,
    supply: null,
    updateAuthority: null,
    explorerUrl: explorerTokenUrl(mint),
    launchpad: { pool: lp.pool, status: lp.status, note: lp.note },
  };
}

export async function getTokenInfo(mint: string): Promise<TokenInfo> {
  const [t, cookPriceUsd] = await Promise.all([fetchToken(mint), fetchCookPriceUsd()]);
  if (mint === COOK_MINT && t) {
    return {
      ...mapTokenInfo(t, cookPriceUsd),
      name: t.metadata?.name ?? "Cookie",
      symbol: COOK_SYMBOL,
    };
  }
  // Not in the registry: before giving up, ask the launchpad. A freshly launched token is in exactly
  // this state until Cookiescan indexes it, so this is the normal path for a new launch — and it used
  // to throw, which meant the `launchpad` field below could never be reached for the very tokens it
  // exists to explain.
  if (!t) {
    const lp = await launchpadTokenIdentity(mint);
    if (!lp) {
      throw new CookieMcpError(
        `token ${mint} not found in the Cookiescan registry`,
        "check the mint address; brand-new tokens can take a moment to be indexed",
      );
    }
    return launchpadOnlyTokenInfo(mint, lp, cookPriceUsd);
  }

  const info = mapTokenInfo(t, cookPriceUsd);
  // Only pay for the launchpad lookup when the market data is empty — otherwise every call would hit
  // a second API for nothing. Best-effort: a launchpad outage must not fail a plain token read.
  if (looksUnpriced(info)) {
    const lp = await launchpadTokenIdentity(mint);
    if (lp) {
      info.launchpad = { pool: lp.pool, status: lp.status, note: lp.note };
      // The registry knows the mint but has no market for it — fill in the curve price it cannot see.
      // Test `!info.priceCook`, not `== null`: Cookiescan reports an unpriced token as 0, which is the
      // same thing `looksUnpriced` treats as absent, and `== null` would never fire here.
      const curve = tradeableCurvePrice(lp);
      if (!info.priceCook && curve != null) {
        info.priceCook = curve;
        if (cookPriceUsd != null) info.priceUsd = curve * cookPriceUsd;
      }
    }
  }
  return info;
}

// --- search --------------------------------------------------------------------------------------

export interface TokenSearchResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  priceCook: number | null;
  liquidityCook: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
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

function toSearchResult(t: CookiescanToken, cookPriceUsd?: number | null): TokenSearchResult {
  const usd = t.price?.usd != null ? Number(t.price.usd) : null;
  const liqCook = t.marketData?.liquidity ?? null; // native COOK, not USD — see mapTokenInfo
  return {
    mint: t.mint,
    symbol: t.metadata?.symbol ?? null,
    name: t.metadata?.name ?? null,
    priceUsd: usd != null && Number.isFinite(usd) ? usd : null,
    priceCook: t.price?.native ?? null,
    liquidityCook: liqCook,
    liquidityUsd: liqCook != null && cookPriceUsd != null ? liqCook * cookPriceUsd : null,
    volume24h: t.marketData?.volume24h ?? null,
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
  cookPriceUsd?: number | null,
): TokenSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return tokens
    .map((t) => ({ t, score: tokenMatchScore(t, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // liquidity is native COOK, but COOK price is constant across the set → still a valid ranking key
      const lb = b.t.marketData?.liquidity ?? 0;
      const la = a.t.marketData?.liquidity ?? 0;
      if (lb !== la) return lb - la;
      return (b.t.marketData?.volume24h ?? 0) - (a.t.marketData?.volume24h ?? 0);
    })
    .slice(0, limit)
    .map((x) => toSearchResult(x.t, cookPriceUsd));
}

/** Resolve a token name/ticker/mint-prefix to candidate mints via the Cookiescan registry. */
export async function searchTokens(
  query: string,
  limit = 20,
): Promise<{ query: string; count: number; results: TokenSearchResult[]; note?: string }> {
  const bounded = Math.min(Math.max(limit, 1), 50);
  const [tokens, cookPriceUsd] = await Promise.all([fetchTokens(), fetchCookPriceUsd()]);
  const results = searchTokenRegistry(tokens, query, bounded, cookPriceUsd);
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
