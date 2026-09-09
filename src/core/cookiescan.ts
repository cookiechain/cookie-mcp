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
  type: string; // venue label, e.g. "COOKIEBOX DAMM", "COOKIESWAP BAMM"
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

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Cookiescan has two public `/api/tokens` shapes:
 * - `api.cookiescan.io` (default): nested `metadata` / `price` / `marketData`
 * - `cookiescan.io` (explorer REST): flat `symbol`, `decimals`, `logoUri`, string `price`
 *
 * `get_quote` reads `metadata.decimals` (else 9). A flat OMNOM row (6 decimals) would otherwise
 * quote 1000× too large. Normalize both shapes onto the nested interface.
 */
export function normalizeCookiescanToken(raw: unknown): CookiescanToken | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const mint = asStr(t.mint);
  if (!mint) return null;

  const nested =
    t.metadata && typeof t.metadata === "object"
      ? (t.metadata as NonNullable<CookiescanToken["metadata"]>)
      : undefined;
  const priceObj =
    t.price && typeof t.price === "object" && !Array.isArray(t.price)
      ? (t.price as { usd?: string | number; native?: number; change24h?: number })
      : undefined;
  const market =
    t.marketData && typeof t.marketData === "object"
      ? (t.marketData as NonNullable<CookiescanToken["marketData"]>)
      : undefined;

  const usdRaw = priceObj?.usd ?? (typeof t.price === "object" ? undefined : t.price);
  const usd =
    typeof usdRaw === "number" && Number.isFinite(usdRaw) ? String(usdRaw) : asStr(usdRaw);

  return {
    mint,
    metadata: {
      name: nested?.name ?? asStr(t.name),
      symbol: nested?.symbol ?? asStr(t.symbol),
      logo: nested?.logo ?? asStr(t.logo) ?? asStr(t.logoUri),
      decimals: nested?.decimals ?? asNum(t.decimals),
      description: nested?.description ?? asStr(t.description),
      updateAuthority: nested?.updateAuthority,
    },
    price: {
      usd,
      native: priceObj?.native ?? asNum(t.priceNative),
      change24h: priceObj?.change24h ?? asNum(t.change24h),
    },
    marketData: {
      volume24h: market?.volume24h ?? asNum(t.volume24h),
      volumeChange24h: market?.volumeChange24h,
      liquidity: market?.liquidity ?? asNum(t.liquidity),
      marketCap: market?.marketCap ?? asNum(t.marketCap),
      supply: market?.supply ?? asNum(t.supply),
      holderCount: market?.holderCount ?? asNum(t.holderCount),
    },
    lastUpdated: asStr(t.lastUpdated),
  };
}

// Full registry (~6k tokens). Callers must filter/paginate — never return all of it to the model.
export async function fetchTokens(): Promise<CookiescanToken[]> {
  const json = await fetchJson<unknown>(`${COOKIESCAN_API_URL}/api/tokens`);
  return unwrap<unknown>(json, ["data", "tokens"])
    .map(normalizeCookiescanToken)
    .filter((t): t is CookiescanToken => t != null);
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
