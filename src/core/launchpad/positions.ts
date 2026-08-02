// Reading a wallet's launchpad state across every pool, straight from the chain.
//
// The API exposes positions one pool at a time (`/pools/:pool/position/:owner`), which would be one
// HTTP request per pool. `UserPosition` is a PDA of `["user", pool, owner]` with a fixed layout, so we
// derive the addresses and batch-read them with `getMultipleAccounts` (100 per call) instead — two
// round trips cover 100 pools, and the answer is on-chain truth rather than an indexer's view.
// Same trick for the per-pool `creator_fee_vault` (a plain SPL token account).
//
// The first of those two round trips reads the **pool accounts themselves**, purely for their `owner`:
// PDA seeds are program-scoped, and the launchpad has been redeployed under a new program id with the
// old pools left behind on the old one. Deriving every PDA under the pool's own owner is the only
// version-proof way to do this, and it stays correct while both deployments are in play. See
// `program.ts`.
import { PublicKey, type Connection } from "@solana/web3.js";

import type { LaunchpadPosition } from "./api";
import { CONFIGURED_LAUNCHPAD_PROGRAM_ID } from "./program";

export const LAUNCHPAD_PROGRAM_ID = CONFIGURED_LAUNCHPAD_PROGRAM_ID;

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

/**
 * `["user", pool, owner]` under `programId` — the deployment that owns the pool. Defaults to the
 * configured id so a caller that already knows it (or a test) can stay terse.
 */
export function userPositionPda(
  pool: PublicKey | string,
  owner: PublicKey | string,
  programId: PublicKey = LAUNCHPAD_PROGRAM_ID,
): PublicKey {
  const p = typeof pool === "string" ? new PublicKey(pool) : pool;
  const o = typeof owner === "string" ? new PublicKey(owner) : owner;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), p.toBuffer(), o.toBuffer()],
    programId,
  )[0];
}

export function creatorFeeVaultPda(
  pool: PublicKey | string,
  programId: PublicKey = LAUNCHPAD_PROGRAM_ID,
): PublicKey {
  const p = typeof pool === "string" ? new PublicKey(pool) : pool;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_fee_vault"), p.toBuffer()],
    programId,
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
 * Which program owns a pool is **immutable** — an account's owner never changes once it is allocated —
 * so this is cached for the life of the process. A wallet polling its portfolio pays one batched read
 * the first time and nothing after that.
 */
const poolProgramCache = new Map<string, PublicKey>();

/** Test seam: forget what we learned about pool ownership. */
export function resetPoolProgramCache(): void {
  poolProgramCache.clear();
}

/**
 * The program that owns each pool account, keyed by pool address — the ground truth PDA derivation
 * needs. Only pools not already known are read. Pools we can't read are absent *and not cached* (so a
 * transient RPC failure is retried); the caller falls back to the configured id for those, which is the
 * best guess available and no worse than the old hardcoded behaviour.
 */
export async function fetchPoolPrograms(
  conn: Connection,
  pools: string[],
): Promise<Map<string, PublicKey>> {
  const owners = new Map<string, PublicKey>();
  const unknown: string[] = [];
  for (const pool of pools) {
    const cached = poolProgramCache.get(pool);
    if (cached) owners.set(pool, cached);
    else unknown.push(pool);
  }
  for (const batch of chunk(unknown)) {
    const infos = await conn.getMultipleAccountsInfo(batch.map((p) => new PublicKey(p)));
    infos.forEach((info, i) => {
      if (!info?.owner) return;
      poolProgramCache.set(batch[i]!, info.owner);
      owners.set(batch[i]!, info.owner);
    });
  }
  return owners;
}

/**
 * A wallet's curve position in each of `pools`, keyed by pool address. Pools the wallet never bought
 * into are simply absent (their PDA does not exist).
 *
 * `programs` maps a pool to the deployment that owns it (from `fetchPoolPrograms`); pass it to stay
 * correct across a program-id change. Without it every PDA is derived under the configured id.
 */
export async function fetchPositionsForPools(
  conn: Connection,
  owner: string,
  pools: string[],
  programs?: Map<string, PublicKey>,
): Promise<Map<string, LaunchpadPosition>> {
  const found = new Map<string, LaunchpadPosition>();
  const pdas = pools.map((pool) => ({
    pool,
    pda: userPositionPda(pool, owner, programs?.get(pool) ?? LAUNCHPAD_PROGRAM_ID),
  }));
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
  programs?: Map<string, PublicKey>,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const pdas = pools.map((pool) => ({
    pool,
    pda: creatorFeeVaultPda(pool, programs?.get(pool) ?? LAUNCHPAD_PROGRAM_ID),
  }));
  for (const batch of chunk(pdas)) {
    const infos = await conn.getMultipleAccountsInfo(batch.map((b) => b.pda));
    infos.forEach((info, i) => out.set(batch[i]!.pool, decodeTokenAmount(info?.data)));
  }
  return out;
}
