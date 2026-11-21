import { PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { metadataPda, TOKEN_METADATA_PROGRAM } from "../nft/auctionHouse";
import { findClubPass, isMemberMetadata, parseMetadataCollection } from "./club";

const CHADS = new PublicKey("FCnYz1C8NLnfGFL6VuwTjL182P2NqbbB6dYqoYYDwn2y");
const CHAD_1 = new PublicKey("27UCqk3GkBD4hYwwas84MFhe3w1JnQxUFiDbF6NJmVH9");

// Live Token Metadata account of Cookie Chads #1 (same bytes as cookiedice's gate.rs fixture).
const CHAD_1_METADATA = Buffer.from(
  "049cb5796aaf78964c269970122a3fb92f7705c9198ec7004c080cf440a662dfce1083ee7daaf35f37178290bc78f809" +
    "962d86a4d5f082fa284c85a0eac99146e820000000436f6f6b6965204368616473202331000000000000000000000000" +
    "00000000000a00000043484144530000000000c8000000697066733a2f2f62616679626569676a707132676176343673" +
    "687a6c33377264336570696536643534697370776d6d3333346c7867327a707466756f37777a7a62792f302e6a736f6e" +
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000000000000000000000000000000000f4010101000000d3bb4bb7408a1c55b0dd" +
    "3a110a870c5e9a9b7ce59db1e5af84890f8e663055710064000001ff01000101d30882d30592b5d162f07da29d0c640b" +
    "0cd7210a4fb11e5d0c119f2cac1522160000000000000000000000000000000000000000000000000000000000000000" +
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000000000000000000000000000000001",
  "hex",
);

/** The fixture with its collection's `verified` flag flipped off. */
function unverified(): Buffer {
  const b = Buffer.from(CHAD_1_METADATA);
  const at = b.indexOf(CHADS.toBuffer());
  b[at - 1] = 0;
  return b;
}

describe("parseMetadataCollection (gate.rs parse_metadata)", () => {
  it("reads the live Chad #1 metadata", () => {
    const md = parseMetadataCollection(CHAD_1_METADATA);
    expect(md?.mint.equals(CHAD_1)).toBe(true);
    expect(md?.name).toBe("Cookie Chads #1");
    expect(md?.collection?.verified).toBe(true);
    expect(md?.collection?.key.equals(CHADS)).toBe(true);
  });

  it("returns null for truncated or non-metadata bytes", () => {
    expect(parseMetadataCollection(CHAD_1_METADATA.subarray(0, 100))).toBeNull();
    expect(parseMetadataCollection(Buffer.from([1, 2, 3]))).toBeNull();
  });
});

describe("isMemberMetadata", () => {
  const md = parseMetadataCollection(CHAD_1_METADATA);
  it("accepts a verified item of the collection", () => {
    expect(isMemberMetadata(md, CHAD_1, CHADS)).toBe(true);
  });
  it("refuses an unverified collection claim (anyone can write one)", () => {
    expect(isMemberMetadata(parseMetadataCollection(unverified()), CHAD_1, CHADS)).toBe(false);
  });
  it("refuses metadata of another mint, or another collection", () => {
    expect(isMemberMetadata(md, PublicKey.default, CHADS)).toBe(false);
    expect(isMemberMetadata(md, CHAD_1, PublicKey.default)).toBe(false);
  });
});

describe("findClubPass", () => {
  const owner = new PublicKey("zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok");
  const tokenAccount = (n: number) => new PublicKey(Buffer.alloc(32, n));
  const fungible = new PublicKey(Buffer.alloc(32, 9));
  const parsed = (mint: PublicKey, decimals: number, amount: string) => ({
    data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { decimals, amount } } } },
  });

  function conn(metadata: Buffer, metadataOwner = TOKEN_METADATA_PROGRAM): Connection {
    return {
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          { pubkey: tokenAccount(1), account: parsed(fungible, 6, "5000") },
          { pubkey: tokenAccount(2), account: parsed(CHAD_1, 0, "0") },
          { pubkey: tokenAccount(3), account: parsed(CHAD_1, 0, "1") },
        ],
      }),
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        expect(keys.map((k) => k.toBase58())).toEqual([metadataPda(CHAD_1).toBase58()]);
        return [{ owner: metadataOwner, data: metadata }];
      },
    } as unknown as Connection;
  }

  it("finds the held NFT and names the accounts place_bet needs", async () => {
    const pass = await findClubPass(conn(CHAD_1_METADATA), owner, CHADS);
    expect(pass?.name).toBe("Cookie Chads #1");
    expect(pass?.tokenAccount.equals(tokenAccount(3))).toBe(true);
    expect(pass?.metadata.equals(metadataPda(CHAD_1))).toBe(true);
  });

  it("finds nothing when the metadata is unverified or not owned by Token Metadata", async () => {
    expect(await findClubPass(conn(unverified()), owner, CHADS)).toBeNull();
    expect(await findClubPass(conn(CHAD_1_METADATA, owner), owner, CHADS)).toBeNull();
  });
});
