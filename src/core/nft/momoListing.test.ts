import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type PublicKey,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { buildSellIx } from "./auctionHouse";
import { maxListingFee, verifyMomoListing } from "./momoListing";

const seller = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const feeWallet = Keypair.generate().publicKey;
const PRICE = 250_000_000_000n; // 250 COOK
const FEE = 2_500_000_000n; // 1%
const want = { seller, mint, price: PRICE, feeWallet };

/** The shape momoswap-backend `buildListItem` returns: CU limit, fee, `sell` with the seller writable. */
function momoSell(price = PRICE, owner: PublicKey = seller): TransactionInstruction {
  const ix = buildSellIx({
    seller: owner,
    sellerTokenAccount: getAssociatedTokenAddressSync(mint, owner, true),
    nftMint: mint,
    price,
  });
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys.map((k, i) => (i === 0 ? { ...k, isWritable: true } : k)),
    data: ix.data,
  });
}
function built(ixs: TransactionInstruction[], payer: PublicKey = seller): Transaction {
  const tx = new Transaction({
    feePayer: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  tx.add(...ixs);
  return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
const cu = (units = 150_000) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const fee = (lamports = FEE, to = feeWallet, from = seller) =>
  SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

describe("verifyMomoListing", () => {
  it("accepts MomoSwap's build and returns our own instructions for it", () => {
    const v = verifyMomoListing(built([cu(), fee(), momoSell()]), want);
    expect(v.feeRaw).toBe(FEE);
    expect(v.units).toBe(150_000);
    const ours = buildSellIx({
      seller,
      sellerTokenAccount: getAssociatedTokenAddressSync(mint, seller, true),
      nftMint: mint,
      price: PRICE,
    });
    expect(v.ixs).toHaveLength(3);
    expect(v.ixs[2]!.data.equals(ours.data)).toBe(true);
    expect(v.ixs[2]!.keys.map((k) => k.pubkey.toBase58())).toEqual(
      ours.keys.map((k) => k.pubkey.toBase58()),
    );
  });

  it("accepts a build with no fee", () => {
    expect(verifyMomoListing(built([cu(), momoSell()]), want).feeRaw).toBe(0n);
  });

  it("bounds the fee by MomoSwap's default: 1%, at least 0.001 COOK", () => {
    expect(maxListingFee(PRICE)).toBe(FEE);
    expect(maxListingFee(10_000_000n)).toBe(1_000_000n);
    expect(() => verifyMomoListing(built([cu(), fee(FEE + 1n), momoSell()]), want)).toThrow(
      /its fee is 2500000001, more than the 2500000000/,
    );
  });

  it("refuses a fee to anyone but the NFT program's fee wallet, or from another wallet", () => {
    expect(() =>
      verifyMomoListing(built([cu(), fee(FEE, Keypair.generate().publicKey), momoSell()]), want),
    ).toThrow(/not the NFT program's fee wallet/);
    const other = Keypair.generate().publicKey;
    expect(() =>
      verifyMomoListing(built([cu(), fee(FEE, feeWallet, other), momoSell()]), want),
    ).toThrow(/refusing to sign/);
  });

  it("refuses a listing at another price, or of another wallet's token account", () => {
    expect(() => verifyMomoListing(built([cu(), fee(), momoSell(PRICE - 1n)]), want)).toThrow(
      /not this item at this price/,
    );
    expect(() =>
      verifyMomoListing(built([cu(), fee(), momoSell(PRICE, Keypair.generate().publicKey)]), want),
    ).toThrow(/not this item at this price/);
  });

  it("refuses a compute-unit price, too many units, or anything extra", () => {
    const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 });
    expect(() => verifyMomoListing(built([price, fee(), momoSell()]), want)).toThrow(
      /compute-unit limit alone/,
    );
    expect(() => verifyMomoListing(built([cu(1_400_000), fee(), momoSell()]), want)).toThrow(
      /asks for 1400000 compute units/,
    );
    expect(() => verifyMomoListing(built([cu(), fee(), momoSell(), fee(1n)]), want)).toThrow(
      /refusing to sign/,
    );
  });

  it("refuses a build another wallet pays for", () => {
    expect(() =>
      verifyMomoListing(built([cu(), fee(), momoSell()], Keypair.generate().publicKey), want),
    ).toThrow(/fee payer/);
  });
});
