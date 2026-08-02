import { describe, it, expect } from "vitest";

import { mapOwnedDomains, priceGuardError, priceView } from "./index";
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
