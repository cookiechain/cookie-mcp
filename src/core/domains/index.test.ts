import { describe, it, expect } from "vitest";

import {
  buyPriceGuardError,
  mapListedDomains,
  mapOwnedDomains,
  priceGuardError,
  priceView,
  type DecodedListing,
} from "./index";
import { ACCOUNT_DISCRIMINATORS } from "./program";
import type { DomainsConfig } from "./names";

const CONFIG: DomainsConfig = {
  admin: "9qMq4JXX4TkVzGpTHN8ZZLRTCt2zcMtnVNafdXj8VUik",
  feeReceiver: "HrbhP5Q9ohsY63Ah6abkUJG8jjuYf1esazsAWvKVg1X7",
  cookUsdPriceMicro: 100n,
  shortNameUsdCents: 350n,
  longNameUsdCents: 150n,
  nativeDecimals: 9,
};

const OWNER = "FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ";
const OTHER = "9qMq4JXX4TkVzGpTHN8ZZLRTCt2zcMtnVNafdXj8VUik";

describe("priceView", () => {
  it("reports both denominations for each tier", () => {
    expect(priceView(CONFIG, "bot")).toEqual({
      tier: "short",
      priceCook: "35000",
      priceUsd: 3.5,
      priceRaw: "35000000000000",
    });
    expect(priceView(CONFIG, "cookie")).toMatchObject({
      tier: "long",
      priceCook: "15000",
      priceUsd: 1.5,
    });
  });
});

describe("priceGuardError", () => {
  const price = priceView(CONFIG, "bot");

  it("refuses when no maxPriceCook is given, and quotes the live price in the refusal", () => {
    const e = priceGuardError({ label: "bot", price });
    expect(e).not.toBeNull();
    expect(e!.message).toContain("35000 COOK");
    expect(e!.message).toContain("nothing was spent");
    expect(e!.hint).toContain("maxPriceCook: 35000");
  });

  it("refuses when the live price exceeds the cap", () => {
    const e = priceGuardError({ label: "bot", price, maxPriceCook: 100 });
    expect(e!.message).toMatch(/above the maxPriceCook of 100/);
  });

  it("authorizes an exact-price cap — the boundary must not be off by one", () => {
    expect(priceGuardError({ label: "bot", price, maxPriceCook: "35000" })).toBeNull();
    expect(
      priceGuardError({ label: "bot", price, maxPriceCook: "34999.999999999" }),
    ).not.toBeNull();
    expect(priceGuardError({ label: "bot", price, maxPriceCook: 50_000 })).toBeNull();
  });

  it("refuses an unparseable cap rather than treating it as unlimited", () => {
    const e = priceGuardError({ label: "bot", price, maxPriceCook: "lots" });
    expect(e!.message).toMatch(/invalid maxPriceCook/);
  });

  it("refuses a cap with more precision than COOK has, instead of rounding it up", () => {
    expect(
      priceGuardError({ label: "bot", price, maxPriceCook: "35000.0000000001" }),
    ).not.toBeNull();
  });
});

/** Build a current-layout `DomainAccount` the way the program serializes one. */
function domainAccount(name: string, owner: string, createdAt = 1_779_985_287): Buffer {
  const data = Buffer.alloc(149);
  Buffer.from(ACCOUNT_DISCRIMINATORS.domain).copy(data, 0);
  const bytes = Buffer.from(name, "utf8");
  data.writeUInt32LE(bytes.length, 8);
  bytes.copy(data, 12);
  const o = 12 + bytes.length;
  Buffer.from(bs58Decode(owner)).copy(data, o);
  data.writeBigInt64LE(BigInt(createdAt), o + 96);
  return data;
}

// Minimal base58 decode so the fixture builder doesn't depend on PublicKey internals.
function bs58Decode(s: string): Uint8Array {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(A.indexOf(ch));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

describe("mapOwnedDomains", () => {
  const accounts = [
    { pubkey: "PdaZebra", data: domainAccount("zebra", OWNER) },
    { pubkey: "PdaBot", data: domainAccount("bot", OWNER) },
    { pubkey: "PdaOther", data: domainAccount("pro", OTHER) },
  ];

  it("keeps only this wallet's names", () => {
    const owned = mapOwnedDomains(accounts, OWNER, null);
    expect(owned.map((d) => d.name)).toEqual(["bot.cook", "zebra.cook"]);
  });

  it("floats the primary to the top and flags it", () => {
    const owned = mapOwnedDomains(accounts, OWNER, "zebra");
    expect(owned[0]).toMatchObject({ name: "zebra.cook", isPrimary: true });
    expect(owned[1]).toMatchObject({ name: "bot.cook", isPrimary: false });
  });

  it("does NOT mark a primary that belongs to a different wallet's name", () => {
    // `pro` is the primary string but is owned by OTHER, so nothing of OWNER's is primary.
    const owned = mapOwnedDomains(accounts, OWNER, "pro");
    expect(owned.every((d) => !d.isPrimary)).toBe(true);
  });

  it("skips accounts of another type instead of throwing on them", () => {
    const junk = Buffer.alloc(149); // no discriminator
    expect(
      mapOwnedDomains([...accounts, { pubkey: "Junk", data: junk }], OWNER, null),
    ).toHaveLength(2);
  });

  it("renders createdAt as ISO", () => {
    expect(mapOwnedDomains(accounts, OWNER, null)[0].createdAt).toBe("2026-05-28T16:21:27.000Z");
  });
});

describe("buyPriceGuardError", () => {
  // 500,000 COOK — the live asking price for bot.cook on the marketplace.
  const priceRaw = 500_000_000_000_000n;

  it("refuses with a quote when no cap is given, and spends nothing", () => {
    const e = buyPriceGuardError({ label: "bot", priceRaw });
    expect(e?.message).toContain("bot.cook is listed for 500000 COOK");
    expect(e?.message).toContain("nothing was spent");
    expect(e?.hint).toContain("maxPriceCook: 500000");
  });

  it("refuses a cap below the asking price", () => {
    const e = buyPriceGuardError({ label: "bot", priceRaw, maxPriceCook: 499_999 });
    expect(e?.message).toContain("above the maxPriceCook of 499999");
  });

  it("authorizes an exact-price cap and anything above it", () => {
    expect(buyPriceGuardError({ label: "bot", priceRaw, maxPriceCook: "500000" })).toBeNull();
    expect(buyPriceGuardError({ label: "bot", priceRaw, maxPriceCook: 1_000_000 })).toBeNull();
  });

  it("refuses one lamport under the price", () => {
    expect(
      buyPriceGuardError({ label: "bot", priceRaw, maxPriceCook: "499999.999999999" }),
    ).not.toBeNull();
  });

  // An unparseable cap must never be read as "no limit" — that is the whole point of the guard.
  it("refuses an unparseable cap rather than treating it as unlimited", () => {
    const e = buyPriceGuardError({ label: "bot", priceRaw, maxPriceCook: "lots" });
    expect(e?.message).toContain('invalid maxPriceCook "lots"');
    expect(
      buyPriceGuardError({ label: "bot", priceRaw, maxPriceCook: "500000.0000000001" }),
    ).not.toBeNull();
  });
});

describe("mapListedDomains", () => {
  const listing = (name: string, priceRaw: bigint, seller: string): DecodedListing => ({
    seller,
    domain: "8o8kfjiof69r5rnN3HtnmKm89eAVXVznHNKMzxhkeLhk",
    name,
    priceRaw,
    createdAt: 1786391354,
  });

  it("keeps only this wallet's listings, cheapest-first", () => {
    const out = mapListedDomains(
      [listing("expensive", 9n, OWNER), listing("theirs", 1n, OTHER), listing("cheap", 2n, OWNER)],
      OWNER,
    );
    expect(out.map((l) => l.name)).toEqual(["cheap.cook", "expensive.cook"]);
  });

  it("carries the listing PDA and an ISO timestamp", () => {
    const [only] = mapListedDomains([listing("bot", 500_000_000_000_000n, OWNER)], OWNER);
    expect(only).toEqual({
      name: "bot.cook",
      label: "bot",
      priceCook: "500000",
      priceLamports: "500000000000000",
      listing: "ECJiWoTihW2PJ8hqpTK5JCM24pHcbrxT1TWMHD8kLWkn",
      listedAt: "2026-08-10T19:49:14.000Z",
    });
  });

  it("is empty for a wallet with no listings", () => {
    expect(mapListedDomains([listing("theirs", 1n, OTHER)], OWNER)).toEqual([]);
  });
});
