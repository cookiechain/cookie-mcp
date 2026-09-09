import { describe, it, expect } from "vitest";

import { normalizeCookiescanToken } from "./cookiescan";

const OMNOM = "9V6z4wiifv2BrCxd7rwBWBAaWS2dxSepWZmWjRpfQ66p";

describe("normalizeCookiescanToken", () => {
  it("keeps the nested api.cookiescan.io registry shape", () => {
    const t = normalizeCookiescanToken({
      mint: OMNOM,
      metadata: { name: "OMNOM", symbol: "OMNOM", decimals: 6, logo: "https://ipfs.io/omnom.png" },
      price: { usd: 2.12e-7, native: 0.002171, change24h: 0 },
      marketData: { liquidity: 2541574.51, marketCap: 212.78, holderCount: 21, supply: 1e9 },
    });
    expect(t?.mint).toBe(OMNOM);
    expect(t?.metadata?.decimals).toBe(6);
    expect(t?.metadata?.symbol).toBe("OMNOM");
    expect(t?.price?.usd).toBe(String(2.12e-7));
    expect(t?.marketData?.holderCount).toBe(21);
  });

  it("lifts a flat cookiescan.io explorer row so decimals are not defaulted to 9", () => {
    // Live explorer REST (2026-09-09): top-level decimals/symbol/logoUri, string price.
    const t = normalizeCookiescanToken({
      mint: OMNOM,
      symbol: "OMNOM",
      name: "OMNOM",
      decimals: 6,
      supply: "1000000000000000.000000000",
      price: "0.000000213",
      marketCap: "213.00",
      liquidity: "2541574.52",
      logoUri: "https://ipfs.io/ipfs/QmVGEisrKTiSi6xEpLjLgs6kwCoiQMq4svYpbX3JewpcQZ",
      holderCount: 21,
      change24h: "0",
    });
    expect(t?.metadata?.decimals).toBe(6);
    expect(t?.metadata?.symbol).toBe("OMNOM");
    expect(t?.metadata?.logo).toContain("QmVGEis");
    expect(t?.price?.usd).toBe("0.000000213");
    expect(t?.marketData?.liquidity).toBeCloseTo(2541574.52, 2);
    expect(t?.marketData?.holderCount).toBe(21);
  });

  it("returns null when mint is missing", () => {
    expect(normalizeCookiescanToken({ symbol: "OMNOM", decimals: 6 })).toBeNull();
    expect(normalizeCookiescanToken(null)).toBeNull();
    expect(normalizeCookiescanToken("nope")).toBeNull();
  });
});
