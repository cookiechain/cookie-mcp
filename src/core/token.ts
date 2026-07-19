// get_token_info — metadata + market data for a mint from the Cookiescan registry.
import { COOK_MINT, COOK_SYMBOL, explorerTokenUrl } from "./config";
import { CookieMcpError } from "./errors";
import { fetchToken, type CookiescanToken } from "./cookiescan";

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
