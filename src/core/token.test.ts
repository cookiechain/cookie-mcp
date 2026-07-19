import { describe, it, expect } from "vitest";

import { mapTokenInfo } from "./token";
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
    expect(t.cookieboxHosted).toBe(true);
    expect(t.bondingProgress).toBeNull();
    expect(t.explorerUrl).toContain("/token/6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL");
  });

  it("flags non-cookiebox-hosted logos", () => {
    const t = mapTokenInfo({
      ...token,
      metadata: { ...token.metadata, logo: "https://evil.example/x.png" },
    });
    expect(t.cookieboxHosted).toBe(false);
  });

  it("tolerates missing fields", () => {
    const t = mapTokenInfo({ mint: "Xmint" });
    expect(t.symbol).toBeNull();
    expect(t.priceUsd).toBeNull();
    expect(t.decimals).toBeNull();
  });
});
