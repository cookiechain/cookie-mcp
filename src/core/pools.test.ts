import { describe, it, expect } from "vitest";

import { mapPools } from "./pools";
import type { CookiescanMarket } from "./cookiescan";

const COOK = "So11111111111111111111111111111111111111112";

const markets: CookiescanMarket[] = [
  {
    marketId: "poolA",
    type: "COOKIEBOX DAMM",
    baseToken: { mint: "MintA", symbol: "AAA" },
    quoteToken: { mint: COOK, symbol: "wCOOK" },
    liquidityUsd: 100,
  },
  {
    marketId: "poolB",
    type: "COOKIESWAP SAMM",
    baseToken: { mint: COOK, symbol: "wCOOK" },
    quoteToken: { mint: "MintB", symbol: "BBB" },
    liquidityUsd: 500,
  },
  {
    marketId: "poolC",
    type: "METEORA DAMM",
    baseToken: { mint: "MintC", symbol: "CCC" },
    quoteToken: { mint: COOK, symbol: "wCOOK" },
    liquidityUsd: 300,
  },
];

const volumeByMint = new Map<string, number>([
  ["MintA", 5],
  ["MintB", 999],
  ["MintC", 50],
]);

describe("mapPools", () => {
  it("sorts by TVL desc and limits", () => {
    const out = mapPools(markets, volumeByMint, { limit: 2, sort: "tvl" });
    expect(out.map((p) => p.poolId)).toEqual(["poolB", "poolC"]);
    expect(out[0].tvlUsd).toBe(500);
  });

  it("sorts by 24h volume desc, joined on the non-COOK side", () => {
    const out = mapPools(markets, volumeByMint, { limit: 3, sort: "volume" });
    expect(out.map((p) => p.poolId)).toEqual(["poolB", "poolC", "poolA"]);
    // poolB's non-COOK side is MintB (quote), volume 999
    expect(out[0].volume24hUsd).toBe(999);
    // poolA's non-COOK side is MintA (base), volume 5
    expect(out[2].volume24hUsd).toBe(5);
  });

  it("maps venue + symbols", () => {
    const [top] = mapPools(markets, volumeByMint, { limit: 1, sort: "tvl" });
    expect(top.venue).toBe("COOKIESWAP SAMM");
    expect(top.base.symbol).toBe("wCOOK");
    expect(top.quote.symbol).toBe("BBB");
  });
});
