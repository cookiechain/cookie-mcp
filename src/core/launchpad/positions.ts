// Reading a wallet's launchpad state across every pool, straight from the chain.
//
// The API exposes positions one pool at a time (`/pools/:pool/position/:owner`), which would be one
// HTTP request per pool. `UserPosition` is a PDA of `["user", pool, owner]` with a fixed layout, so we
// derive the addresses and batch-read them with `getMultipleAccounts` (100 per call) instead — one
// round trip covers 100 pools, and the answer is on-chain truth rather than an indexer's view.
// Same trick for the per-pool `creator_fee_vault` (a plain SPL token account).
import { PublicKey, type Connection } from "@solana/web3.js";

import { PROGRAM_IDS } from "../config";
import type { LaunchpadPosition } from "./api";

export const LAUNCHPAD_PROGRAM_ID = new PublicKey(PROGRAM_IDS.momoswapLaunchpad);

/** Anchor account discriminators (first 8 bytes) from the launchpad IDL. */
export const USER_POSITION_DISCRIMINATOR = Buffer.from([251, 248, 209, 245, 83, 234, 17, 27]);

// UserPosition layout: disc(8) · pool(32) · owner(32) · shares(u64) · total_payment_in(u64) ·
// total_payment_out(u64) · claimed(u8) · winner_claimed(u8) · graduated_tokens_claimed(u8) · bump(u8).
const OFF_POOL = 8;
const OFF_OWNER = 40;
const OFF_SHARES = 72;
const OFF_PAYMENT_IN = 80;
const OFF_PAYMENT_OUT = 88;
const OFF_CLAIMED = 96;
const OFF_WINNER_CLAIMED = 97;
const OFF_GRADUATED_CLAIMED = 98;
const USER_POSITION_MIN_LEN = 100;

/** SPL token account: mint(32) · owner(32) · amount(u64) — we only need the amount. */
const OFF_TOKEN_AMOUNT = 64;
const TOKEN_ACCOUNT_MIN_LEN = 72;

const MAX_ACCOUNTS_PER_CALL = 100;

export function userPositionPda(pool: PublicKey | string, owner: PublicKey | string): PublicKey {
  const p = typeof pool === "string" ? new PublicKey(pool) : pool;
  const o = typeof owner === "string" ? new PublicKey(owner) : owner;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), p.toBuffer(), o.toBuffer()],
    LAUNCHPAD_PROGRAM_ID,
  )[0];
}

export function creatorFeeVaultPda(pool: PublicKey | string): PublicKey {
  const p = typeof pool === "string" ? new PublicKey(pool) : pool;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_fee_vault"), p.toBuffer()],
    LAUNCHPAD_PROGRAM_ID,
  )[0];
}

/**
 * Decode a raw `UserPosition` account, or null when the bytes are not one (wrong discriminator or
 * too short). Never throws — a single odd account must not fail a whole portfolio read.
 */
export function decodeUserPosition(data: Buffer): LaunchpadPosition | null {
  if (data.length < USER_POSITION_MIN_LEN) return null;
  if (!data.subarray(0, 8).equals(USER_POSITION_DISCRIMINATOR)) return null;
  return {
    pool: new PublicKey(data.subarray(OFF_POOL, OFF_POOL + 32)).toBase58(),
    owner: new PublicKey(data.subarray(OFF_OWNER, OFF_OWNER + 32)).toBase58(),
    shares: data.readBigUInt64LE(OFF_SHARES).toString(),
    totalPaymentIn: data.readBigUInt64LE(OFF_PAYMENT_IN).toString(),
    totalPaymentOut: data.readBigUInt64LE(OFF_PAYMENT_OUT).toString(),
    claimed: data[OFF_CLAIMED] === 1,
    winnerClaimed: data[OFF_WINNER_CLAIMED] === 1,
    graduatedTokensClaimed: data[OFF_GRADUATED_CLAIMED] === 1,
  };
}

/** Raw amount held by an SPL token account, or 0n when the account is absent/unreadable. */
export function decodeTokenAmount(data: Buffer | null | undefined): bigint {
  if (!data || data.length < TOKEN_ACCOUNT_MIN_LEN) return 0n;
  return data.readBigUInt64LE(OFF_TOKEN_AMOUNT);
}

/** Split a list into `getMultipleAccounts`-sized chunks (pure — the batching rule in one place). */
export function chunk<T>(items: T[], size = MAX_ACCOUNTS_PER_CALL): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A wallet's curve position in each of `pools`, keyed by pool address. Pools the wallet never bought
 * into are simply absent (their PDA does not exist).
 */
export async function fetchPositionsForPools(
  conn: Connection,
  owner: string,
  pools: string[],
): Promise<Map<string, LaunchpadPosition>> {
  const found = new Map<string, LaunchpadPosition>();
  const pdas = pools.map((pool) => ({ pool, pda: userPositionPda(pool, owner) }));
  for (const batch of chunk(pdas)) {
    const infos = await conn.getMultipleAccountsInfo(batch.map((b) => b.pda));
    infos.forEach((info, i) => {
      if (!info?.data) return;
      const decoded = decodeUserPosition(info.data);
      if (decoded) found.set(batch[i]!.pool, decoded);
    });
  }
  return found;
}

/** Unclaimed creator-fee balance (raw COOK) for each pool, keyed by pool address. */
export async function fetchCreatorFeeVaults(
  conn: Connection,
  pools: string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const pdas = pools.map((pool) => ({ pool, pda: creatorFeeVaultPda(pool) }));
  for (const batch of chunk(pdas)) {
    const infos = await conn.getMultipleAccountsInfo(batch.map((b) => b.pda));
    infos.forEach((info, i) => out.set(batch[i]!.pool, decodeTokenAmount(info?.data)));
  }
  return out;
}
