import { describe, it, expect } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";

import { filterSortListings, toListingView, decodeMetadataCreators } from "./index";
import type { BazaarListing } from "./bazaar";

function listing(over: Partial<BazaarListing>): BazaarListing {
  return {
    publicKey: "TS" + (over.nftMint ?? "x"),
    seller: "sellerX",
    nftMint: "mintX",
    price: "1000000000",
    status: "Active",
    sellerTokenAccount: "staX",
    ...over,
  };
}

describe("filterSortListings", () => {
  const listings = [
    listing({ nftMint: "m1", price: "3000000000", status: "Active", createdAt: 100 }),
    listing({ nftMint: "m2", price: "1000000000", status: "Active", createdAt: 300 }),
    listing({ nftMint: "m3", price: "2000000000", status: "Sold", createdAt: 200 }),
    listing({ nftMint: "m4", price: "500000000", status: "active", createdAt: 250, seller: "bob" }),
  ];

  it("keeps only active listings (case-insensitive) and sorts newest-first by default", () => {
    const out = filterSortListings(listings, {});
    expect(out.map((l) => l.nftMint)).toEqual(["m2", "m4", "m1"]); // m3 (Sold) dropped
  });

  it("sorts cheapest-first for sort=price", () => {
    const out = filterSortListings(listings, { sort: "price" });
    expect(out.map((l) => l.nftMint)).toEqual(["m4", "m2", "m1"]); // 0.5, 1, 3 COOK
  });

  it("filters by seller", () => {
    const out = filterSortListings(listings, { seller: "bob" });
    expect(out.map((l) => l.nftMint)).toEqual(["m4"]);
  });

  it("filters by collection key or symbol", () => {
    const withColl = [
      listing({ nftMint: "c1", metadata: { collection: { key: "GORI" } } }),
      listing({ nftMint: "c2", metadata: { symbol: "GORI" } }),
      listing({ nftMint: "c3", metadata: { symbol: "OTHER" } }),
    ];
    const out = filterSortListings(withColl, { collection: "GORI" });
    expect(out.map((l) => l.nftMint).sort()).toEqual(["c1", "c2"]);
  });
});

describe("toListingView", () => {
  it("converts lamport price to COOK and surfaces metadata", () => {
    const v = toListingView(
      listing({
        nftMint: "m1",
        price: "2500000000",
        seller: "alice",
        publicKey: "tradeState1",
        metadata: { name: "Cookie #1", symbol: "GORI", image: "img", collection: { key: "GORI" } },
      }),
    );
    expect(v.mint).toBe("m1");
    expect(v.price).toBe("2.5"); // 2.5 COOK @ 9 decimals
    expect(v.priceLamports).toBe("2500000000");
    expect(v.name).toBe("Cookie #1");
    expect(v.collection).toBe("GORI");
    expect(v.listing).toBe("tradeState1");
    expect(v.url).toBe("https://bakedbazaar.art/nft/m1");
  });
});

// Metaplex Token Metadata borsh: key(1) + updateAuthority(32) + mint(32) + name(4+len) +
// symbol(4+len) + uri(4+len) + sellerFee(2) + creators(option u8; if 1: u32 count then
// {pubkey(32), verified(1), share(1)} each).
function encodeMetadata(
  creators: { address: PublicKey; verified: boolean; share: number }[] | null,
): Buffer {
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const parts: Buffer[] = [
    Buffer.from([4]), // key
    Keypair.generate().publicKey.toBuffer(), // updateAuthority
    Keypair.generate().publicKey.toBuffer(), // mint
    str("Cookie"),
    str("GORI"),
    str("https://example/uri.json"),
    Buffer.from([0x84, 0x03]), // seller_fee_basis_points = 900 (u16 LE)
  ];
  if (!creators) {
    parts.push(Buffer.from([0])); // Option::None
  } else {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(creators.length);
    parts.push(Buffer.from([1]), count);
    for (const c of creators) {
      parts.push(c.address.toBuffer(), Buffer.from([c.verified ? 1 : 0, c.share]));
    }
  }
  return Buffer.concat(parts);
}

describe("decodeMetadataCreators", () => {
  it("decodes creators with their verified flag and royalty share", () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const data = encodeMetadata([
      { address: a, verified: true, share: 70 },
      { address: b, verified: false, share: 30 },
    ]);
    const out = decodeMetadataCreators(data);
    expect(out).toEqual([
      { address: a.toBase58(), verified: true, share: 70 },
      { address: b.toBase58(), verified: false, share: 30 },
    ]);
  });

  it("returns [] when the metadata has no creators", () => {
    expect(decodeMetadataCreators(encodeMetadata(null))).toEqual([]);
  });

  it("returns [] on malformed/truncated data instead of throwing", () => {
    expect(decodeMetadataCreators(Buffer.alloc(4))).toEqual([]);
  });
});
