// What cookie-mcp reads from the NFT launchpad's own accounts, where the MomoSwap API does not say it:
// a drop's held-back creator share (anchor #115) and where the platform's fees go (Config's treasury).
// Decoded with the vendored IDL, so a layout change shows up as a decode failure, not a wrong number.
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { unpackAccount } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";

import nftIdl from "../../idl/momo_nft_launchpad.json" with { type: "json" };
import { NFT_PROGRAM_ID } from "./verify";

const coder = new BorshAccountsCoder(nftIdl as Idl);

/** The program's one `Config` account. */
export function nftConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    new PublicKey(NFT_PROGRAM_ID),
  )[0];
}

/**
 * What a target graduation held back of the creator's share (anchor #115): it is released to the
 * creator vault a part per post-graduation mint, and whatever is left at `deadline` (unix seconds) is
 * forfeited. Null for an account that is not a `Collection`. Pure.
 */
export function decodeCreatorEscrow(data: Buffer): { heldRaw: bigint; deadline: number } | null {
  let raw: { creator_escrow: { toString(): string }; escrow_deadline: { toString(): string } };
  try {
    raw = coder.decode("Collection", data);
  } catch {
    return null;
  }
  return {
    heldRaw: BigInt(raw.creator_escrow.toString()),
    deadline: Number(raw.escrow_deadline.toString()),
  };
}

/** `Config.treasury_payment`: the token account the program's platform fees are paid into. Pure. */
export function decodeConfigTreasury(data: Buffer): PublicKey | null {
  try {
    return (coder.decode("Config", data) as { treasury_payment: PublicKey }).treasury_payment;
  } catch {
    return null;
  }
}

export async function readCreatorEscrow(
  conn: Connection,
  collectionAddress: string,
): Promise<{ heldRaw: bigint; deadline: number } | null> {
  const info = await conn.getAccountInfo(new PublicKey(collectionAddress));
  return info?.owner.toBase58() === NFT_PROGRAM_ID ? decodeCreatorEscrow(info.data) : null;
}

/**
 * The wallet that owns the NFT program's fee treasury: where MomoSwap's own platform fees land, and
 * the default home of its Baked Bazaar listing fee. Null when either account cannot be read.
 */
export async function readNftFeeWallet(conn: Connection): Promise<PublicKey | null> {
  const config = await conn.getAccountInfo(nftConfigPda());
  if (!config || config.owner.toBase58() !== NFT_PROGRAM_ID) return null;
  const treasury = decodeConfigTreasury(config.data);
  if (!treasury) return null;
  const info = await conn.getAccountInfo(treasury);
  if (!info) return null;
  try {
    return unpackAccount(treasury, info, info.owner).owner;
  } catch {
    return null;
  }
}
