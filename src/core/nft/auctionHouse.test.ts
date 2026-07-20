import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  buildSellIx,
  buildPublicBuyIx,
  buildExecuteSaleIx,
  buildCancelIx,
  buildDepositIx,
  buildWithdrawIx,
  metadataPda,
  decodeTradeState,
  TRADE_STATE_MIN_LEN,
} from "./auctionHouse";
import { decodeMetadataCreators } from "./index";

// Golden fixtures captured from real Baked Bazaar transactions on Cookie Chain (2026-07). Each builder
// below must reproduce the on-chain instruction byte-for-byte: same data, same account order + set.
const hex = (ix: { data: Buffer | Uint8Array }) => Buffer.from(ix.data).toString("hex");
const keys = (ix: { keys: Array<{ pubkey: PublicKey }> }) =>
  ix.keys.map((k) => k.pubkey.toBase58());

describe("auction house — golden bytes vs on-chain txs", () => {
  it("public_buy (offer) — sig 5Wom17…", () => {
    const ix = buildPublicBuyIx({
      buyer: new PublicKey("3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy"),
      nftMint: new PublicKey("Eiwk3BU5WVXAHyXMsFYPQcqNu8AKdwZiFdQqFpuwkSRL"),
      price: 43000000000000n,
    });
    expect(hex(ix)).toBe("a954da232ace10abffff00b0b9b71b2700000100000000000000");
    expect(keys(ix)).toEqual([
      "3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy",
      "3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy",
      "3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy",
      "So11111111111111111111111111111111111111112",
      "GG2QJt7ow9kP8T6ZRvxFt1FDMkbZiGJpPQ8cWvqonkAe",
      "9WTGHAkzhbYqQm7b5WmBnGttrQmf8wFucjfGqBCvoMM6",
      "2cDUSHLHz7kRqojEPmsJuGRfLLMWfNxsrLjY4gxTc4Ft",
      "ESg7dvoD2tdaGpdu99sU8aGETkZzxzn9TP78FSLrZvYM",
      "EnsbByCrLDxHLMiZSdWa79SKmHsjQ5AaxXMTzRqpS5Nu",
      "5uozrzvkbtWCrtVLN6fxCVFE7tzocoojR5gt6Z2ak6Xy",
      "2kgoX3syr2HVAeVo29c3xi9pg2LpbVpZ5Lkev2NYQMo7",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "11111111111111111111111111111111",
      "SysvarRent111111111111111111111111111111111",
    ]);
  });

  it("sell (list) — sig 2cM6oN…", () => {
    const ix = buildSellIx({
      seller: new PublicKey("3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy"),
      sellerTokenAccount: new PublicKey("2VnXjHVZ9FJ7DwVWqLapkwiF6QNBy2RfAssZzC78ib4v"),
      nftMint: new PublicKey("Hn5FCRxcEC9XykBhs8KQjVYit1yztLwLRsG3bZnRW74x"),
      price: 200000000000000n,
    });
    expect(hex(ix)).toBe("33e685a4017f83adffffff0080f420e6b500000100000000000000");
    expect(keys(ix)).toEqual([
      "3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy",
      "2VnXjHVZ9FJ7DwVWqLapkwiF6QNBy2RfAssZzC78ib4v",
      "F8EQk5s5mbX7ZtPRxPS7s9J7DcgndzhL8vurogDy75s3",
      "ESg7dvoD2tdaGpdu99sU8aGETkZzxzn9TP78FSLrZvYM",
      "EnsbByCrLDxHLMiZSdWa79SKmHsjQ5AaxXMTzRqpS5Nu",
      "5uozrzvkbtWCrtVLN6fxCVFE7tzocoojR5gt6Z2ak6Xy",
      "DXRciCMaURMgo3t6U8vd8WS8FPuM15ksfQRjHgh1D33k",
      "9ujkse2xDDrbmL92qpEbBJ8ZPci9VuU4eeM82H8T1ca5",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "11111111111111111111111111111111",
      "HS2eL9WJbh7pA4i4veK3YDwhGLRjY3uKryvG1NbHRprj",
      "SysvarRent111111111111111111111111111111111",
    ]);
  });

  it("execute_sale (instant buy) — sig 2fSf6W…", () => {
    const ix = buildExecuteSaleIx({
      buyer: new PublicKey("3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy"),
      seller: new PublicKey("Hn1i7bLb7oHpAL5AoyGvkn7YgwmWrVTbVsjXA1LYnELo"),
      sellerTokenAccount: new PublicKey("2KZ23esKixXXgQUyFPxJqFG2h1ZbM4vJBK2or3Ru1ugA"),
      nftMint: new PublicKey("Hn5FCRxcEC9XykBhs8KQjVYit1yztLwLRsG3bZnRW74x"),
      price: 26000000000000n,
      creators: [{ address: "7hmajuVWXD9iQv8LooaSraSJ6CryJv4WJXKU8gd5H6e" }],
      buyerSide: "buy",
    });
    expect(hex(ix)).toBe("254ad99d4f312306fffdff00a0c398a51700000100000000000000");
    expect(keys(ix)).toEqual([
      "3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy",
      "Hn1i7bLb7oHpAL5AoyGvkn7YgwmWrVTbVsjXA1LYnELo",
      "2KZ23esKixXXgQUyFPxJqFG2h1ZbM4vJBK2or3Ru1ugA",
      "Hn5FCRxcEC9XykBhs8KQjVYit1yztLwLRsG3bZnRW74x",
      "F8EQk5s5mbX7ZtPRxPS7s9J7DcgndzhL8vurogDy75s3",
      "So11111111111111111111111111111111111111112",
      "2cDUSHLHz7kRqojEPmsJuGRfLLMWfNxsrLjY4gxTc4Ft",
      "Hn1i7bLb7oHpAL5AoyGvkn7YgwmWrVTbVsjXA1LYnELo",
      "2VnXjHVZ9FJ7DwVWqLapkwiF6QNBy2RfAssZzC78ib4v",
      "ESg7dvoD2tdaGpdu99sU8aGETkZzxzn9TP78FSLrZvYM",
      "EnsbByCrLDxHLMiZSdWa79SKmHsjQ5AaxXMTzRqpS5Nu",
      "5uozrzvkbtWCrtVLN6fxCVFE7tzocoojR5gt6Z2ak6Xy",
      "BB67Nb7jkiDwpiQZYyLDj8qUhVBLfJNwNJ2WCCwixYn8",
      "2iZhKtKZUD1Rp7i5cxvPULgnSpXySgZd51s7ZHpsJLnD",
      "umssvn9YrQ7FBgAgYksZA4NDmooFnyZGxD8dLMay8mV",
      "FRoyKK5dXaWFJDXyWVJ7JPRFFnnxdwX15qypMaGgj7Po",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "11111111111111111111111111111111",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "HS2eL9WJbh7pA4i4veK3YDwhGLRjY3uKryvG1NbHRprj",
      "SysvarRent111111111111111111111111111111111",
      "7hmajuVWXD9iQv8LooaSraSJ6CryJv4WJXKU8gd5H6e",
    ]);
  });

  it("metadata PDA derivation matches on-chain", () => {
    expect(
      metadataPda(new PublicKey("Hn5FCRxcEC9XykBhs8KQjVYit1yztLwLRsG3bZnRW74x")).toBase58(),
    ).toBe("F8EQk5s5mbX7ZtPRxPS7s9J7DcgndzhL8vurogDy75s3");
  });
});

describe("auction house — instruction data encoding", () => {
  const buyer = new PublicKey("3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy");
  const mint = new PublicKey("Eiwk3BU5WVXAHyXMsFYPQcqNu8AKdwZiFdQqFpuwkSRL");

  it("cancel encodes disc + price + tokenSize (no bumps)", () => {
    const ix = buildCancelIx({
      wallet: buyer,
      tokenAccount: new PublicKey("2VnXjHVZ9FJ7DwVWqLapkwiF6QNBy2RfAssZzC78ib4v"),
      nftMint: mint,
      price: 43000000000000n,
      side: "publicBuy",
    });
    // e8dbdf29dbecdcbe (disc) + price + tokenSize
    expect(hex(ix)).toBe("e8dbdf29dbecdcbe00b0b9b71b2700000100000000000000");
    expect(ix.keys).toHaveLength(8);
  });

  it("deposit encodes disc + escrowBump + amount", () => {
    const ix = buildDepositIx({ wallet: buyer, amount: 43000000000000n });
    const h = hex(ix);
    expect(h.startsWith("f223c68952e1f2b6")).toBe(true); // deposit disc
    expect(h.endsWith("00b0b9b71b270000")).toBe(true); // amount u64 LE
    expect(ix.keys).toHaveLength(11);
  });

  it("withdraw encodes disc + escrowBump + amount, wallet is signer", () => {
    const ix = buildWithdrawIx({ wallet: buyer, amount: 43000000000000n });
    expect(hex(ix).startsWith("b712469c946da122")).toBe(true); // withdraw disc
    expect(ix.keys).toHaveLength(11);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(false);
  });
});

describe("trade-state decode", () => {
  it("decodes a serialized trade state (self-describing account)", () => {
    const buf = Buffer.alloc(TRADE_STATE_MIN_LEN);
    const ah = new PublicKey("EnsbByCrLDxHLMiZSdWa79SKmHsjQ5AaxXMTzRqpS5Nu");
    const buyer = new PublicKey("3ssNbwaSv9KZLVNVYFADGauwYuGKpqAPvCxtACsF1qPy");
    const tokenMint = new PublicKey("Eiwk3BU5WVXAHyXMsFYPQcqNu8AKdwZiFdQqFpuwkSRL");
    ah.toBuffer().copy(buf, 8);
    buyer.toBuffer().copy(buf, 40);
    tokenMint.toBuffer().copy(buf, 72);
    buf.writeBigUInt64LE(1n, 168);
    buf.writeBigUInt64LE(43000000000000n, 176);
    const ts = decodeTradeState(buf)!;
    expect(ts.auctionHouse).toBe(ah.toBase58());
    expect(ts.buyer).toBe(buyer.toBase58());
    expect(ts.tokenMint).toBe(tokenMint.toBase58());
    expect(ts.buyPrice).toBe(43000000000000n);
    expect(ts.tokenSize).toBe(1n);
  });

  it("returns null for a too-short buffer", () => {
    expect(decodeTradeState(Buffer.alloc(10))).toBeNull();
  });
});

describe("metadata creator decode", () => {
  it("parses creators from a borsh metadata buffer", () => {
    const creator = new PublicKey("7hmajuVWXD9iQv8LooaSraSJ6CryJv4WJXKU8gd5H6e");
    const parts: Buffer[] = [];
    parts.push(Buffer.alloc(1 + 32 + 32)); // key + updateAuthority + mint
    const str = (s: string) => {
      const b = Buffer.from(s);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      return Buffer.concat([len, b]);
    };
    parts.push(str("Name"), str("SYM"), str("https://uri"));
    parts.push(Buffer.from([100, 0])); // seller_fee_basis_points
    parts.push(Buffer.from([1])); // creators option = Some
    const count = Buffer.alloc(4);
    count.writeUInt32LE(1);
    parts.push(count, creator.toBuffer(), Buffer.from([1, 100])); // verified + share
    const creators = decodeMetadataCreators(Buffer.concat(parts));
    expect(creators).toEqual([{ address: creator.toBase58(), verified: true, share: 100 }]);
  });

  it("returns [] when creators option is None", () => {
    const parts: Buffer[] = [Buffer.alloc(65)];
    const str = (s: string) => {
      const b = Buffer.from(s);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      return Buffer.concat([len, b]);
    };
    parts.push(str("N"), str("S"), str("U"), Buffer.from([0, 0, 0]));
    expect(decodeMetadataCreators(Buffer.concat(parts))).toEqual([]);
  });
});
