import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  buyListingIx,
  cancelListingIx,
  decodeListingAccount,
  decodeMarketConfigAccount,
  DOMAIN_MARKET_PROGRAM_ID,
  encodeListDomainData,
  ESCROW_AUTHORITY,
  escrowAuthorityPda,
  filterSortListings,
  floorPriceRaw,
  listDomainIx,
  listingPda,
  MARKET_ERRORS,
  marketConfigPda,
  marketSimError,
  MAX_MARKET_FEE_BPS,
  splitSalePrice,
  type DecodedListing,
} from "./marketplace";
import { DOMAINS_PROGRAM_ID, domainPda } from "./program";

// Golden values from the live deployment (read 2026-08-10). Every one of them is on chain, so a drift
// in a seed string or a discriminator fails here instead of on a user's transaction.
const BOT_DOMAIN = "8o8kfjiof69r5rnN3HtnmKm89eAVXVznHNKMzxhkeLhk";
const BOT_LISTING = "ECJiWoTihW2PJ8hqpTK5JCM24pHcbrxT1TWMHD8kLWkn";
const BOT_SELLER = "FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ";
const MARKET_CONFIG = "BbyRzH5bjtqzC2q2QYWSdYRi7VNEi8AFKNE3HDBqZwNo";
const ESCROW = "7rQTSWbk1nMRPve2q3wcS1rT6g2shkXkNDGnZX53zEzR";
const FEE_WALLET = "HrbhP5Q9ohsY63Ah6abkUJG8jjuYf1esazsAWvKVg1X7";
const ADMIN = "9qMq4JXX4TkVzGpTHN8ZZLRTCt2zcMtnVNafdXj8VUik";

/** The real `Listing` account for `bot.cook`, listed at 500,000 COOK. */
const LISTING_BYTES = Buffer.from(
  "2iAySSuGGjrVfR6YFquO11tSXMfwBVWqbDWSrKKN+6tUvvebQ9qV3nPTSrvCr1KmHXVNRB6vHoM7kaeabaayZuoponBS81ef" +
    "AwAAAGJvdABAY1K/xgEAOit6agAAAAD9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "base64",
);

/** The real marketplace `Config` account. */
const CONFIG_BYTES = Buffer.from(
  "qRb3g7bIUXyDQOzYzXyfjTky1uJOO/+oFlpG3+4vRVEYU4Rd5tlp0fpvrn2jJYsaMixmrRfROfESF7XVLs077IkXG3fxmHqqZAD/",
  "base64",
);

describe("PDAs", () => {
  it('derives the live config account from ["config"]', () => {
    expect(marketConfigPda().toBase58()).toBe(MARKET_CONFIG);
  });

  it('derives the single escrow authority from ["escrow_authority"]', () => {
    expect(escrowAuthorityPda().toBase58()).toBe(ESCROW);
    expect(ESCROW_AUTHORITY).toBe(ESCROW);
  });

  it("keys a listing by the registry's domain account", () => {
    expect(listingPda(new PublicKey(BOT_DOMAIN)).toBase58()).toBe(BOT_LISTING);
    expect(listingPda(domainPda("bot")).toBase58()).toBe(BOT_LISTING);
  });
});

describe("encodeListDomainData", () => {
  it("is the discriminator plus a little-endian u64 price", () => {
    // 1 COOK = 1e9 lamports.
    expect([...encodeListDomainData(1_000_000_000n)]).toEqual([
      140, 232, 109, 191, 154, 7, 181, 108, 0, 202, 154, 59, 0, 0, 0, 0,
    ]);
  });

  it("refuses a zero or negative price rather than letting the program reject it", () => {
    expect(() => encodeListDomainData(0n)).toThrow(/greater than zero/);
    expect(() => encodeListDomainData(-1n)).toThrow(/greater than zero/);
  });

  it("refuses a price over u64", () => {
    expect(() => encodeListDomainData(2n ** 64n)).toThrow(/u64/);
  });
});

describe("instruction account lists", () => {
  const seller = new PublicKey(BOT_SELLER);
  const domain = new PublicKey(BOT_DOMAIN);

  it("list_domain: listing, seller (signer), domain, escrow, registry, system", () => {
    const ix = listDomainIx({ seller, domain, priceRaw: 1n });
    expect(ix.programId.toBase58()).toBe(DOMAIN_MARKET_PROGRAM_ID.toBase58());
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      BOT_LISTING,
      BOT_SELLER,
      BOT_DOMAIN,
      ESCROW,
      DOMAINS_PROGRAM_ID.toBase58(),
      "11111111111111111111111111111111",
    ]);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([BOT_SELLER]);
  });

  it("cancel_listing: same shape without the system program (nothing is allocated)", () => {
    const ix = cancelListingIx({ seller, domain });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      BOT_LISTING,
      BOT_SELLER,
      BOT_DOMAIN,
      ESCROW,
      DOMAINS_PROGRAM_ID.toBase58(),
    ]);
    expect([...ix.data]).toEqual([41, 183, 50, 232, 230, 233, 157, 70]);
  });

  it("buy_listing: config first, then listing, buyer (signer), seller, domain, fee wallet", () => {
    const buyer = new PublicKey(ADMIN);
    const ix = buyListingIx({ buyer, seller, domain, feeWallet: new PublicKey(FEE_WALLET) });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      MARKET_CONFIG,
      BOT_LISTING,
      ADMIN,
      BOT_SELLER,
      BOT_DOMAIN,
      FEE_WALLET,
      ESCROW,
      DOMAINS_PROGRAM_ID.toBase58(),
      "11111111111111111111111111111111",
    ]);
    // The seller and the fee wallet are paid, so both must be writable.
    expect(ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())).toEqual([
      BOT_LISTING,
      ADMIN,
      BOT_SELLER,
      BOT_DOMAIN,
      FEE_WALLET,
    ]);
    expect([...ix.data]).toEqual([115, 149, 42, 108, 44, 49, 140, 153]);
  });
});

describe("decodeListingAccount", () => {
  it("decodes the live bot.cook listing", () => {
    expect(decodeListingAccount(LISTING_BYTES)).toEqual({
      seller: BOT_SELLER,
      domain: BOT_DOMAIN,
      name: "bot",
      priceRaw: 500_000_000_000_000n,
      createdAt: 1786391354,
    });
  });

  it("reads price and created_at at offsets that depend on the name length", () => {
    // Same account with a 4-character name: every field after the string shifts by one byte.
    const longer = Buffer.from(LISTING_BYTES);
    longer.writeUInt32LE(4, 72);
    longer.write("botx", 76, "utf8");
    longer.writeBigUInt64LE(7n, 80);
    longer.writeBigInt64LE(9n, 88);
    const decoded = decodeListingAccount(longer);
    expect(decoded).toMatchObject({ name: "botx", priceRaw: 7n, createdAt: 9 });
  });

  it("rejects a foreign discriminator instead of returning garbage", () => {
    const junk = Buffer.from(LISTING_BYTES);
    junk[0] ^= 0xff;
    expect(decodeListingAccount(junk)).toBeNull();
    expect(decodeListingAccount(CONFIG_BYTES)).toBeNull();
  });

  it("rejects a truncated account", () => {
    expect(decodeListingAccount(LISTING_BYTES.subarray(0, 80))).toBeNull();
  });
});

describe("decodeMarketConfigAccount", () => {
  it("decodes the live config", () => {
    expect(decodeMarketConfigAccount(CONFIG_BYTES)).toEqual({
      admin: ADMIN,
      feeWallet: FEE_WALLET,
      feeBps: 100,
    });
  });

  it("shares its fee receiver with the name registry", () => {
    // Not a coincidence worth asserting for its own sake — it is the check that catches decoding the
    // fee wallet from the wrong offset, since the registry's own config names the same address.
    expect(decodeMarketConfigAccount(CONFIG_BYTES)?.feeWallet).toBe(FEE_WALLET);
  });

  it("rejects a listing account", () => {
    expect(decodeMarketConfigAccount(LISTING_BYTES)).toBeNull();
  });
});

describe("splitSalePrice", () => {
  it("matches the only completed sale on the deployment (1,000 COOK at 100 bps)", () => {
    expect(splitSalePrice(1_000_000_000_000n, 100)).toEqual({
      feeRaw: 10_000_000_000n,
      sellerReceivesRaw: 990_000_000_000n,
    });
  });

  it("floors the fee, so the remainder always goes to the seller", () => {
    const { feeRaw, sellerReceivesRaw } = splitSalePrice(999n, 100);
    expect(feeRaw).toBe(9n);
    expect(sellerReceivesRaw).toBe(990n);
    expect(feeRaw + sellerReceivesRaw).toBe(999n);
  });

  it("a zero fee leaves the whole price with the seller", () => {
    expect(splitSalePrice(5n, 0)).toEqual({ feeRaw: 0n, sellerReceivesRaw: 5n });
  });

  it("never takes more than the 10% the program allows", () => {
    const { feeRaw } = splitSalePrice(1_000n, MAX_MARKET_FEE_BPS);
    expect(feeRaw).toBe(100n);
  });
});

const listing = (
  name: string,
  priceRaw: bigint,
  createdAt: number,
  seller = BOT_SELLER,
): DecodedListing => ({ seller, domain: BOT_DOMAIN, name, priceRaw, createdAt });

describe("filterSortListings", () => {
  const all = [
    listing("cookies", 325_000n, 300),
    listing("bot", 500_000n, 100),
    listing("me", 1_500_000n, 200, ADMIN),
  ];

  it("sorts newest-first by default", () => {
    expect(filterSortListings(all, {}).map((l) => l.name)).toEqual(["cookies", "me", "bot"]);
  });

  it("sorts cheapest-first on price, and shortest-first on length", () => {
    expect(filterSortListings(all, { sort: "price" }).map((l) => l.name)).toEqual([
      "cookies",
      "bot",
      "me",
    ]);
    expect(filterSortListings(all, { sort: "length" }).map((l) => l.name)).toEqual([
      "me",
      "bot",
      "cookies",
    ]);
  });

  it("matches names as a substring and tolerates the .cook suffix", () => {
    expect(filterSortListings(all, { name: "ook" }).map((l) => l.name)).toEqual(["cookies"]);
    expect(filterSortListings(all, { name: "BOT.cook" }).map((l) => l.name)).toEqual(["bot"]);
    expect(filterSortListings(all, { name: "nope" })).toEqual([]);
  });

  it("filters by seller, max price (inclusive) and max length", () => {
    expect(filterSortListings(all, { seller: ADMIN }).map((l) => l.name)).toEqual(["me"]);
    expect(filterSortListings(all, { maxPriceRaw: 500_000n }).map((l) => l.name)).toEqual([
      "cookies",
      "bot",
    ]);
    expect(filterSortListings(all, { maxLength: 3 }).map((l) => l.name)).toEqual(["me", "bot"]);
  });

  it("does not mutate the input", () => {
    const before = all.map((l) => l.name);
    filterSortListings(all, { sort: "price" });
    expect(all.map((l) => l.name)).toEqual(before);
  });

  it("ignores an empty name filter rather than matching nothing", () => {
    expect(filterSortListings(all, { name: "  " })).toHaveLength(3);
  });
});

describe("floorPriceRaw", () => {
  it("is the cheapest price, or null with no listings", () => {
    expect(floorPriceRaw([listing("a", 5n, 1), listing("b", 2n, 2)])).toBe(2n);
    expect(floorPriceRaw([])).toBeNull();
  });
});

describe("marketSimError", () => {
  it("maps the anchor codes confirmed against the deployment", () => {
    expect(
      marketSimError(["Error Number: 6010. Error Message: Buyer cannot be the seller.."]),
    ).toBe(MARKET_ERRORS[6010]);
    expect(marketSimError(["Error Number: 6004."])).toMatch(/do not own this domain/);
    expect(marketSimError(["Error Number: 6006."])).toMatch(/created the listing/);
  });

  it("turns the system program's 'already in use' into 'already listed'", () => {
    const logs = [
      "Program log: Instruction: ListDomain",
      "Allocate: account Address { address: ECJi…, base: None } already in use",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
    ];
    expect(marketSimError(logs, "bot")).toBe("bot.cook is already listed for sale");
    expect(marketSimError(logs)).toMatch(/already listed for sale/);
  });

  it("explains an insufficient balance with both numbers", () => {
    expect(
      marketSimError(["Transfer: insufficient lamports 3257984251208, need 24750000000000"]),
    ).toBe(
      "insufficient COOK: the wallet holds 3257984251208 lamports, the purchase needs 24750000000000",
    );
  });

  it("falls back to anchor's own message for a code we never reached", () => {
    expect(marketSimError(["Error Number: 6007. Error Message: Listing is not active."])).toBe(
      "Listing is not active",
    );
  });

  it("returns null when there is nothing to translate", () => {
    expect(marketSimError(["Program log: something else entirely"])).toBeNull();
    expect(marketSimError([])).toBeNull();
  });
});
