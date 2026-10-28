// MomoSwap's own Baked Bazaar listing (`POST /v1/nft/tx/list`), the fallback `list_nft` takes when the
// direct Auction House `sell` does not simulate. MomoSwap builds the same `sell` behind a listing fee
// paid to the NFT program's fee wallet, in one transaction: momoswap-backend `listing-tx.ts` (the fee is
// `NFT_LISTING_FEE_BPS` of the price, default 1%, at least 0.001 COOK).
//
// The build is never signed as it comes. It is held instruction by instruction to what we would build
// ourselves — a compute-unit limit, at most one fee transfer from us to the program's fee wallet within
// the fee bound, then a `sell` identical to `buildSellIx` for this wallet, item and price — and then
// rebuilt from our own instructions, so nothing from the API reaches the signature but two numbers we
// bounded: the CU limit and the fee.
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { CookieMcpError } from "../errors";
import { buildSellIx } from "./auctionHouse";

/** MomoSwap's default listing fee: 1% of the price, at least 0.001 COOK (`listing-tx.ts`). */
export const MOMO_LISTING_FEE_BPS = 100n;
export const MOMO_LISTING_FEE_MIN_RAW = 1_000_000n;
/** The most compute a listing build may ask for (MomoSwap asks 150k; the `sell` takes ~67k). */
export const MOMO_LISTING_MAX_CU = 400_000;

/** The most a listing at `price` may charge: MomoSwap's default fee, never more. Pure. */
export function maxListingFee(price: bigint): bigint {
  const fee = (price * MOMO_LISTING_FEE_BPS) / 10_000n;
  return fee < MOMO_LISTING_FEE_MIN_RAW ? MOMO_LISTING_FEE_MIN_RAW : fee;
}

export interface VerifiedListing {
  /** The CU limit the build asked for (bounded). */
  units: number;
  /** The fee it pays, 0 when it pays none (bounded). */
  feeRaw: bigint;
  /** Our own instructions for the same listing: what gets signed. */
  ixs: TransactionInstruction[];
}

function refuse(detail: string): CookieMcpError {
  return new CookieMcpError(
    `refusing to sign MomoSwap's listing: its build does not match the request (${detail})`,
    "nothing was signed or sent; list_nft's direct Baked Bazaar listing failed too — retry later",
  );
}

/**
 * Hold MomoSwap's listing build to this wallet listing `mint` at `price`, paying at most
 * {@link maxListingFee} to `feeWallet` (the NFT program's fee wallet, read from the chain). Returns
 * our own instructions for it. Pure.
 */
export function verifyMomoListing(
  tx: Transaction,
  want: { seller: PublicKey; mint: PublicKey; price: bigint; feeWallet: PublicKey },
): VerifiedListing {
  if (!tx.feePayer?.equals(want.seller)) {
    throw refuse(`its fee payer is ${tx.feePayer?.toBase58() ?? "missing"}, not this wallet`);
  }
  const ixs = [...tx.instructions];
  const sellerTokenAccount = getAssociatedTokenAddressSync(want.mint, want.seller, true);
  const ours = buildSellIx({
    seller: want.seller,
    sellerTokenAccount,
    nftMint: want.mint,
    price: want.price,
  });

  // 1. The compute-unit limit: SetComputeUnitLimit (2) only, never a price (a fee drain).
  const cu = ixs.shift();
  if (
    !cu?.programId.equals(ComputeBudgetProgram.programId) ||
    cu.data.length !== 5 ||
    cu.data[0] !== 2 ||
    cu.keys.length !== 0
  ) {
    throw refuse("it does not open with a compute-unit limit alone");
  }
  const units = cu.data.readUInt32LE(1);
  if (units > MOMO_LISTING_MAX_CU) throw refuse(`it asks for ${units} compute units`);

  // 2. The fee, when there is one: System transfer (2) from us to the fee wallet, within the bound.
  let feeRaw = 0n;
  if (ixs.length === 2) {
    const fee = ixs.shift()!;
    if (
      !fee.programId.equals(SystemProgram.programId) ||
      fee.data.length !== 12 ||
      fee.data.readUInt32LE(0) !== 2 ||
      fee.keys.length !== 2
    ) {
      throw refuse("its second instruction is not a plain transfer");
    }
    if (!fee.keys[0]!.pubkey.equals(want.seller)) throw refuse("its fee is paid by another wallet");
    if (!fee.keys[1]!.pubkey.equals(want.feeWallet)) {
      throw refuse(
        `its fee goes to ${fee.keys[1]!.pubkey.toBase58()}, not the NFT program's fee wallet`,
      );
    }
    feeRaw = fee.data.readBigUInt64LE(4);
    const max = maxListingFee(want.price);
    if (feeRaw > max) throw refuse(`its fee is ${feeRaw}, more than the ${max} MomoSwap charges`);
  }

  // 3. The `sell`: our own instruction, byte for byte (MomoSwap marks the seller writable; it pays the
  //    trade states' rent, and as the fee payer it is writable either way).
  const sell = ixs.shift();
  if (!sell || ixs.length > 0) throw refuse("it is not a fee and one Baked Bazaar listing");
  const sameKeys =
    sell.keys.length === ours.keys.length &&
    sell.keys.every(
      (k, i) =>
        k.pubkey.equals(ours.keys[i]!.pubkey) &&
        k.isSigner === ours.keys[i]!.isSigner &&
        (i === 0 || k.isWritable === ours.keys[i]!.isWritable),
    );
  if (!sell.programId.equals(ours.programId) || !sameKeys || !sell.data.equals(ours.data)) {
    throw refuse("its listing is not this item at this price, from this wallet's token account");
  }

  return {
    units,
    feeRaw,
    ixs: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...(feeRaw > 0n
        ? [
            SystemProgram.transfer({
              fromPubkey: want.seller,
              toPubkey: want.feeWallet,
              lamports: feeRaw,
            }),
          ]
        : []),
      new TransactionInstruction({
        programId: ours.programId,
        keys: ours.keys.map((k, i) => (i === 0 ? { ...k, isWritable: true } : k)),
        data: ours.data,
      }),
    ],
  };
}
