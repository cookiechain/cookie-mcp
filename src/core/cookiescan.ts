// Cookiescan REST client: the token registry (/api/tokens) and the markets/pools feed (/api/markets).
import { COOKIESCAN_API_URL } from "./config";
import { fetchJson } from "./http";

export interface CookiescanToken {
  mint: string;
  metadata?: {
    name?: string;
    symbol?: string;
    logo?: string;
    decimals?: number;
    description?: string;
    updateAuthority?: string;
  };
  price?: { usd?: string; native?: number; change24h?: number };
  marketData?: {
    volume24h?: number;
    volumeChange24h?: number;
    liquidity?: number;
    marketCap?: number;
    supply?: number;
    holderCount?: number;
  };
  lastUpdated?: string;
}

export interface CookiescanMarketSide {
  mint: string;
  symbol?: string;
  amount?: number;
  priceUsd?: number;
}

export interface CookiescanMarket {
  marketId: string;
  type: string; // venue label, e.g. "COOKIEBOX DAMM", "COOKIESWAP SAMM"
  baseToken: CookiescanMarketSide;
  quoteToken: CookiescanMarketSide;
  liquidityUsd?: number;
  liquidityDisplay?: string;
}

function unwrap<T>(json: unknown, keys: string[]): T[] {
  if (Array.isArray(json)) return json as T[];
  for (const k of keys) {
    const v = (json as Record<string, unknown>)?.[k];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

// Full registry (~6k tokens). Callers must filter/paginate — never return all of it to the model.
export async function fetchTokens(): Promise<CookiescanToken[]> {
  const json = await fetchJson<unknown>(`${COOKIESCAN_API_URL}/api/tokens`);
  return unwrap<CookiescanToken>(json, ["data", "tokens"]);
}

export async function fetchToken(mint: string): Promise<CookiescanToken | null> {
  const tokens = await fetchTokens();
  return tokens.find((t) => t.mint === mint) ?? null;
}

export async function fetchMarkets(): Promise<CookiescanMarket[]> {
  const json = await fetchJson<unknown>(`${COOKIESCAN_API_URL}/api/markets`);
  return unwrap<CookiescanMarket>(json, ["data", "markets"]);
}

// COOK's USD price, from Cookiescan's dedicated endpoint. Needed to value COOK-denominated fields
// (e.g. `/api/tokens` `marketData.liquidity`, which is in native COOK, NOT USD). Best-effort: returns
// null on any failure so a read still succeeds (the USD figure just shows null).
export async function fetchCookPriceUsd(): Promise<number | null> {
  try {
    const json = await fetchJson<{ data?: { price?: { usd?: number } } }>(
      `${COOKIESCAN_API_URL}/api/price/cook`,
    );
    const usd = json?.data?.price?.usd;
    return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}
