import { describe, it, expect } from "vitest";

import { mapTokenInfo, searchTokenRegistry } from "./token";
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
