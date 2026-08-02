import { describe, it, expect } from "vitest";

import { launchpadOnlyTokenInfo, looksUnpriced, mapTokenInfo, searchTokenRegistry } from "./token";
import type { CookiescanToken } from "./cookiescan";

const token: CookiescanToken = {
  mint: "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL",
  metadata: {
    name: "Cookie Monster",
    symbol: "MON",
    logo: "https://metadata.cookiebox.app/tokens/6H7x/image.png",
    decimals: 6,
    description: "Me want cookie!",
    updateAuthority: "FFWfqNZGQKun8d1iePAnqkrob359Do2qXwV7CqvF4wq2",
  },
  price: { usd: "0.000000087002488784", native: 0.0011218511237308763, change24h: 0 },
  marketData: {
    volume24h: 0,
    liquidity: 1234690.64,
    marketCap: 87.0,
    supply: 1e9,
    holderCount: 17,
  },
};

describe("mapTokenInfo", () => {
  it("maps registry fields into the tool shape", () => {
    const t = mapTokenInfo(token);
    expect(t.symbol).toBe("MON");
    expect(t.decimals).toBe(6);
    expect(t.priceUsd).toBeCloseTo(8.7002e-8, 12);
    expect(t.priceCook).toBeCloseTo(0.00112185, 8);
    expect(t.marketCapUsd).toBe(87.0);
    expect(t.holderCount).toBe(17);
    expect(t.explorerUrl).toContain("/token/6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL");
    // liquidity is native COOK; USD is null unless a COOK price is supplied.
    expect(t.liquidityCook).toBe(1234690.64);
    expect(t.liquidityUsd).toBeNull();
  });

  it("converts COOK liquidity to USD when given the COOK price", () => {
    const t = mapTokenInfo(token, 0.00009072209);
    expect(t.liquidityCook).toBe(1234690.64);
    expect(t.liquidityUsd).toBeCloseTo(112.01, 2); // 1234690.64 COOK × $0.00009072209
  });

  it("tolerates missing fields", () => {
    const t = mapTokenInfo({ mint: "Xmint" });
    expect(t.symbol).toBeNull();
    expect(t.priceUsd).toBeNull();
    expect(t.decimals).toBeNull();
  });
});

describe("launchpadOnlyTokenInfo", () => {
  // The case this exists for: a token launched minutes ago is NOT in the Cookiescan registry yet, so
  // get_token_info used to throw — which meant the `launchpad` field could never be populated for the
  // very tokens it was written to explain. Shape mirrors the real MCPLC launch of 2026-07-29.
  const lp = {
    pool: "EKkxjFhWdiqqaTnUyyKPxPFWdaXU4Ji2A5jWykG3wFBb",
    status: "live" as const,
    note: "buy it with launchpad_buy and sell it with launchpad_sell",
    name: "MCP Live Check",
    symbol: "MCPLC",
    decimals: 6,
    metadataUri: "ipfs://QmcyEAYSknmhyTgKkDrGmHL6AvtyFK7kmMxcTgaoKc5WJ3",
    priceCook: 0.0001644650512581547,
  };

  it("describes an unindexed launchpad token instead of failing", () => {
    const t = launchpadOnlyTokenInfo("HvnJCQjeGxvn27WEoYk1UbdDwXhRGuQkase17NiVmomo", lp);
    expect(t.symbol).toBe("MCPLC");
    expect(t.name).toBe("MCP Live Check");
    expect(t.decimals).toBe(6);
    expect(t.priceCook).toBe(lp.priceCook);
    expect(t.launchpad).toEqual({ pool: lp.pool, status: "live", note: lp.note });
  });

  it("leaves every market field null rather than inventing one from curve reserves", () => {
    const t = launchpadOnlyTokenInfo("HvnJCQjeGxvn27WEoYk1UbdDwXhRGuQkase17NiVmomo", lp);
    expect(t.liquidityCook).toBeNull();
    expect(t.liquidityUsd).toBeNull();
    expect(t.marketCapUsd).toBeNull();
    expect(t.volume24h).toBeNull();
    expect(t.holderCount).toBeNull();
    expect(t.supply).toBeNull();
    expect(t.change24hPct).toBeNull();
  });

  it("converts the curve price to USD only when the COOK price is known", () => {
    expect(launchpadOnlyTokenInfo("m", lp, 2).priceUsd).toBeCloseTo(lp.priceCook * 2, 18);
    expect(launchpadOnlyTokenInfo("m", lp).priceUsd).toBeNull();
    expect(launchpadOnlyTokenInfo("m", lp, null).priceUsd).toBeNull();
  });

  it("reports no price rather than 0 when the curve price is unusable", () => {
    for (const bad of [0, NaN, Infinity]) {
      const t = launchpadOnlyTokenInfo("m", { ...lp, priceCook: bad }, 2);
      expect(t.priceCook).toBeNull();
      expect(t.priceUsd).toBeNull();
    }
  });

  it("quotes the curve price ONLY while the curve is live", () => {
    // A frozen (ended/expired) curve and a graduated pool both have a price nothing can trade at:
    // reporting it as `priceCook` would be a fiction. The `launchpad` field still explains the token.
    for (const status of ["ended", "expired", "graduated", "upcoming"] as const) {
      const t = launchpadOnlyTokenInfo("m", { ...lp, status }, 2);
      expect(t.priceCook).toBeNull();
      expect(t.priceUsd).toBeNull();
      expect(t.launchpad?.status).toBe(status);
    }
    expect(launchpadOnlyTokenInfo("m", lp, 2).priceCook).toBe(lp.priceCook);
  });
});

describe("looksUnpriced", () => {
  it("is false for a token with any market data (so no launchpad lookup is made)", () => {
    expect(looksUnpriced(mapTokenInfo(token))).toBe(false);
    expect(looksUnpriced(mapTokenInfo({ ...token, price: {}, marketData: { liquidity: 5 } }))).toBe(
      false,
    );
  });

  it("is true when price and liquidity are all absent or zero — the launchpad-curve signature", () => {
    expect(looksUnpriced(mapTokenInfo({ mint: "Xmint" }))).toBe(true);
    expect(
      looksUnpriced(
        mapTokenInfo({
          mint: "Xmint",
          price: { usd: "0", native: 0 },
          marketData: { liquidity: 0 },
        }),
      ),
    ).toBe(true);
  });
});

describe("searchTokenRegistry", () => {
  const tok = (mint: string, symbol: string, name: string, liquidity = 0, volume24h = 0) => ({
    mint,
    metadata: { symbol, name },
    marketData: { liquidity, volume24h },
  });
  const registry = [
    tok("Cmint", "COOKHOUSE", "COOKHOUSE", 5_000), // two namesakes...
    tok("Dmint", "COOKHOUSE", "COOKHOUSE", 120_000), // ...this one is far more liquid
    tok("Emint", "GORBHOUSE", "Gorbhouse", 9_000),
    tok("Fmint", "COOK", "Cookie", 999_999),
    tok("Gmint", "MOO", "Moo Deng cook house", 1),
  ];

  it("finds a token by exact symbol and ranks the most-liquid namesake first", () => {
    const out = searchTokenRegistry(registry, "cookhouse", 10);
    expect(out.map((r) => r.mint)).toEqual(["Dmint", "Cmint"]); // liquidity tiebreak
    // Cookiescan liquidity is native COOK; with no COOK price passed, USD is null.
    expect(out[0]!.liquidityCook).toBe(120_000);
    expect(out[0]!.liquidityUsd).toBeNull();
  });

  it("values liquidity in USD via the COOK price when supplied", () => {
    const out = searchTokenRegistry(registry, "cookhouse", 10, 0.0001);
    expect(out[0]!.liquidityCook).toBe(120_000);
    expect(out[0]!.liquidityUsd).toBeCloseTo(12, 9); // 120000 COOK × $0.0001
  });

  it("matches case-insensitively on a name substring", () => {
    const out = searchTokenRegistry(registry, "house", 10).map((r) => r.mint);
    expect(out).toContain("Emint"); // "Gorbhouse"
    expect(out).toContain("Gmint"); // "...cook house"
  });

  it("ranks exact/prefix matches above substring matches", () => {
    // "cook": COOK symbol-exact + Cookie/COOKHOUSE prefixes rank above the "cook house" substring.
    const out = searchTokenRegistry(registry, "cook", 10).map((r) => r.mint);
    expect(out[0]).toBe("Fmint"); // exact symbol "COOK"
    expect(out.indexOf("Gmint")).toBe(out.length - 1); // substring-only match last
  });

  it("matches a mint prefix and honors the limit", () => {
    expect(searchTokenRegistry(registry, "Dmi", 10).map((r) => r.mint)).toEqual(["Dmint"]);
    expect(searchTokenRegistry(registry, "cookhouse", 1)).toHaveLength(1);
  });

  it("returns [] for a blank query or no match", () => {
    expect(searchTokenRegistry(registry, "   ", 10)).toEqual([]);
    expect(searchTokenRegistry(registry, "nonexistenttoken", 10)).toEqual([]);
  });
});
