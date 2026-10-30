// Cookiebox Zip (`ZiPzPbbM…`): the on-chain side of a trailing range order. A `RangeOrder` PDA
// at `["range_order", position]` becomes the position NFT's SPL delegate, which the CLMM accepts as
// `position_authority`; a keeper then calls `zip` to move the range's trailing edge up to the
// price (one CPI to `reposition_liquidity_v2`, which withdraws the filled part to the owner) and
// `finish` once the whole range has filled. The program fixes everything except timing and the
// liquidity amount, so the keeper can delay an order but cannot move its funds anywhere else.
//
// This module holds the PDAs, the account decoders and the two instructions an OWNER signs —
// `enable` (start) and `disable` (stop) — plus the owner-paid prerequisites the keeper refuses to
// fund: the owner's payout token accounts and the tick arrays the range spans. The keeper's own
// `zip` / `finish` are deliberately not built here; this server starts and stops orders, it
// never cranks them. Ported from cookiebox `src/solana/zip/zipTx.ts`.
import {
  AnchorProvider,
  BorshAccountsCoder,
  Program as AnchorProgram,
  type Idl,
  type Program,
} from "@coral-xyz/anchor";
import {
  ParsablePosition,
  ParsableWhirlpool,
  PDAUtil,
  PriceMath,
  TICK_ARRAY_SIZE,
  TickUtil,
  WhirlpoolIx,
  type PositionData,
  type WhirlpoolData,
} from "@orca-so/whirlpools-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type Connection,
  type GetProgramAccountsFilter,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { PROGRAM_IDS } from "../config";
import { CookieMcpError } from "../errors";
import { CLMM_PROGRAM_ID } from "../liquidity/clmm";
import zipIdl from "../../idl/zip.json" with { type: "json" };
import whirlpoolIdl from "../../idl/whirlpool.json" with { type: "json" };
import type { ZipDirection } from "./decision";

export const ZIP_PROGRAM_ID = new PublicKey(PROGRAM_IDS.zip);

// The IDL ships its own `address`. A stale copy after a redeploy would make every PDA here derive
// against the wrong program — fail at import (the boot smoke catches it) instead.
const idlAddress = (zipIdl as { address?: string }).address;
if (idlAddress !== PROGRAM_IDS.zip) {
  throw new Error(
    `src/idl/zip.json is for ${idlAddress}, but PROGRAM_IDS.zip is ${PROGRAM_IDS.zip} — ` +
      "re-copy the IDL from the zip repo",
  );
}

// --- programs -------------------------------------------------------------------------------------

/** A provider that can read and build but never signs: the wallet signs through our own sender. */
function readOnlyProvider(conn: Connection): AnchorProvider {
  const wallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  return new AnchorProvider(conn, wallet as never, { commitment: "confirmed" });
}

/** The Zip `Program`, for building `enable` / `disable`. */
export function zipProgram(conn: Connection): Program {
  return new AnchorProgram(
    { ...(zipIdl as Idl), address: ZIP_PROGRAM_ID.toBase58() },
    readOnlyProvider(conn),
  ) as unknown as Program;
}

/** The CLMM `Program` retargeted to Cookie's fork, for the tick-array instruction builder. */
function clmmProgram(conn: Connection): Program {
  return new AnchorProgram(
    { ...(whirlpoolIdl as Idl), address: CLMM_PROGRAM_ID.toBase58() },
    readOnlyProvider(conn),
  ) as unknown as Program;
}

// --- PDAs -----------------------------------------------------------------------------------------

/** `["range_order", position]` — one order per position; also the NFT's delegate. */
export function rangeOrderPda(position: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("range_order"), position.toBuffer()],
    ZIP_PROGRAM_ID,
  )[0];
}

/**
 * `["native_payout", range_order]` — the order's transient wrapped-COOK account. `zip` / `finish`
 * create it, let the CLMM pay the COOK side into it and close it in the same instruction, so the
 * owner receives plain COOK rather than wCOOK. It never exists between transactions.
 */
export function nativePayoutPda(order: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("native_payout"), order.toBuffer()],
    ZIP_PROGRAM_ID,
  )[0];
}

/** The CLMM position account for a position NFT mint. */
export function positionPdaForMint(positionMint: PublicKey): PublicKey {
  return PDAUtil.getPosition(CLMM_PROGRAM_ID, positionMint).publicKey;
}

// --- RangeOrder -----------------------------------------------------------------------------------

export interface RangeOrder {
  owner: PublicKey;
  position: PublicKey;
  positionMint: PublicKey;
  whirlpool: PublicKey;
  direction: ZipDirection;
  /** The edge only moves once the price is this many tick spacings past it. */
  minStep: number;
  /** Who may `zip`; `null` lets anyone (and exposes the order to griefing — see the README). */
  cranker: PublicKey | null;
  bump: number;
}

/** Anchor's `sha256("account:RangeOrder")[..8]`, as the IDL records it. Filters program reads. */
export const RANGE_ORDER_DISCRIMINATOR = Uint8Array.from([115, 23, 17, 23, 102, 223, 93, 154]);

// The raw coder keeps the IDL's snake_case field names (anchor's `Program` camel-cases them).
const accountsCoder = new BorshAccountsCoder(zipIdl as Idl);

/** Decode a `RangeOrder` account; refuses any other account (discriminator checked). */
export function decodeRangeOrder(data: Buffer): RangeOrder {
  let raw: {
    owner: PublicKey;
    position: PublicKey;
    position_mint: PublicKey;
    whirlpool: PublicKey;
    direction: { aToB?: object; bToA?: object; AToB?: object; BToA?: object };
    min_step: number;
    cranker: PublicKey | null;
    bump: number;
  };
  try {
    raw = accountsCoder.decode("RangeOrder", data);
  } catch {
    throw new CookieMcpError(
      "not a Zip range order account",
      "the account exists but is not a RangeOrder of the Zip program",
    );
  }
  return {
    owner: raw.owner,
    position: raw.position,
    positionMint: raw.position_mint,
    whirlpool: raw.whirlpool,
    direction: "aToB" in raw.direction || "AToB" in raw.direction ? "aToB" : "bToA",
    minStep: raw.min_step,
    cranker: raw.cranker,
    bump: raw.bump,
  };
}

/** `getProgramAccounts` filters for a wallet's orders (or every order when `owner` is null). */
export function rangeOrderFilters(owner: PublicKey | null): GetProgramAccountsFilter[] {
  const filters: GetProgramAccountsFilter[] = [
    { memcmp: { offset: 0, bytes: bs58.encode(RANGE_ORDER_DISCRIMINATOR) } },
  ];
  if (owner) filters.push({ memcmp: { offset: 8, bytes: owner.toBase58() } });
  return filters;
}

export async function listRangeOrders(
  conn: Connection,
  owner: PublicKey | null,
): Promise<{ address: PublicKey; order: RangeOrder }[]> {
  const accounts = await conn.getProgramAccounts(ZIP_PROGRAM_ID, {
    commitment: "confirmed",
    filters: rangeOrderFilters(owner),
  });
  return accounts.map((a) => ({ address: a.pubkey, order: decodeRangeOrder(a.account.data) }));
}

// --- CLMM state -----------------------------------------------------------------------------------

/** Parse a CLMM pool account (the Orca layout; Cookie's fork keeps it). */
export function parsePool(address: PublicKey, info: AccountInfo<Buffer> | null): WhirlpoolData {
  const data =
    info && info.owner.equals(CLMM_PROGRAM_ID) ? ParsableWhirlpool.parse(address, info) : null;
  if (!data) {
    throw new CookieMcpError(
      `no Cookiebox CLMM pool at ${address.toBase58()}`,
      "Zip works on Cookiebox CLMM positions only (pool owner CLMMmWqTt…)",
    );
  }
  return data;
}

/** Parse a CLMM position account. */
export function parsePosition(address: PublicKey, info: AccountInfo<Buffer> | null): PositionData {
  const data =
    info && info.owner.equals(CLMM_PROGRAM_ID) ? ParsablePosition.parse(address, info) : null;
  if (!data) {
    throw new CookieMcpError(
      `no Cookiebox CLMM position at ${address.toBase58()}`,
      "pass the position NFT mint (as shown on cookiebox.app/position/<mint>) or the position account",
    );
  }
  return data;
}

/** The CLMM's tick → sqrt price (Q64.64), as a bigint for the decision math. */
export function sqrtAt(tick: number): bigint {
  return BigInt(PriceMath.tickIndexToSqrtPriceX64(tick).toString());
}

// --- tick arrays ----------------------------------------------------------------------------------

export type TickArrayRef = { startTick: number; address: PublicKey };

export function tickArrayFor(
  whirlpool: PublicKey,
  tick: number,
  tickSpacing: number,
): TickArrayRef {
  const startTick = TickUtil.getStartTickIndex(tick, tickSpacing);
  return {
    startTick,
    address: PDAUtil.getTickArray(CLMM_PROGRAM_ID, whirlpool, startTick).publicKey,
  };
}

/**
 * The most tick arrays an order's range may span. A full range at spacing 64 spans 158; at spacing 2
 * it spans ~5040, which would be hundreds of transactions at start and thousands of accounts to read
 * on every listing (rpc.cookiescan.io refuses a 2000-key read).
 */
export const MAX_RANGE_TICK_ARRAYS = 200;

/** How many tick arrays a range spans, without deriving their addresses. */
export function rangeTickArrayCount(lower: number, upper: number, tickSpacing: number): number {
  const first = TickUtil.getStartTickIndex(lower, tickSpacing);
  const last = TickUtil.getStartTickIndex(upper, tickSpacing);
  return (last - first) / (TICK_ARRAY_SIZE * tickSpacing) + 1;
}

/**
 * Every tick array a range spans, lowest first. The trailing edge only ever moves inside the range
 * the order started with, so these are all the arrays the order can ever need. Check
 * `rangeTickArrayCount` against `MAX_RANGE_TICK_ARRAYS` first.
 */
export function rangeTickArrays(
  whirlpool: PublicKey,
  lower: number,
  upper: number,
  tickSpacing: number,
): TickArrayRef[] {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  const last = TickUtil.getStartTickIndex(upper, tickSpacing);
  const out: TickArrayRef[] = [];
  for (let start = TickUtil.getStartTickIndex(lower, tickSpacing); start <= last; start += span) {
    out.push(tickArrayFor(whirlpool, start, tickSpacing));
  }
  return out;
}

/** Keys per `getMultipleAccountsInfo` call: the standard RPC limit. */
const ACCOUNTS_PER_READ = 100;

/** Which of `arrays` do not exist on chain yet, in the order given. */
export async function missingTickArrays(
  conn: Pick<Connection, "getMultipleAccountsInfo">,
  arrays: TickArrayRef[],
): Promise<TickArrayRef[]> {
  const unique = [...new Map(arrays.map((a) => [a.address.toBase58(), a])).values()];
  const reads: Promise<(AccountInfo<Buffer> | null)[]>[] = [];
  for (let i = 0; i < unique.length; i += ACCOUNTS_PER_READ) {
    reads.push(
      conn.getMultipleAccountsInfo(unique.slice(i, i + ACCOUNTS_PER_READ).map((a) => a.address)),
    );
  }
  const infos = (await Promise.all(reads)).flat();
  return unique.filter((_, i) => !infos[i]);
}

/**
 * A dynamic tick array as `initialize_dynamic_tick_array` creates it: discriminator, start tick,
 * whirlpool, tick bitmap and 88 one-byte uninitialised ticks. This CLMM stores every array that way
 * (a fixed 9988-byte array costs 37x the rent and none exists on chain), so this is the whole rent an
 * array costs — about 0.002 COOK.
 */
export const DYNAMIC_TICK_ARRAY_MIN_LEN = 8 + 4 + 32 + 16 + TICK_ARRAY_SIZE;

/**
 * Idempotent `initialize_dynamic_tick_array` for each array, rent paid by `funder`. Part of the start
 * flow, at the OWNER's expense, for every array the range spans: the keeper creates none (a hostile
 * owner could otherwise pin a full-range dust position to it and bill it one array per step). Arrays
 * cannot be closed, so this is paid once per pool and range; a later order over the same range pays
 * nothing.
 */
export function buildTickArrayInitIxs(
  conn: Connection,
  p: { whirlpool: PublicKey; arrays: TickArrayRef[]; funder: PublicKey },
): TransactionInstruction[] {
  const clmm = clmmProgram(conn);
  return p.arrays.flatMap(
    (t) =>
      WhirlpoolIx.initDynamicTickArrayIx(clmm as never, {
        whirlpool: p.whirlpool,
        tickArrayPda: PDAUtil.getTickArray(CLMM_PROGRAM_ID, p.whirlpool, t.startTick),
        startTick: t.startTick,
        funder: p.funder,
        idempotent: true,
      }).instructions,
  );
}

/**
 * How many tick-array inits fit in one legacy transaction next to the enable instruction and two
 * payout-account creates, leaving 128 bytes for what a wallet may add (a compute-budget instruction).
 * Sized for the worst case, Token-2022 on one side and the classic program on the other (both token
 * programs in the key list): 9 fit a classic pair but leave a mixed one 108 bytes. A wider range
 * takes several transactions: `enableTransactions` puts the inits first and `enable` in the last one.
 */
export const TICK_ARRAY_INITS_PER_TX = 8;

/** Instruction lists, one per transaction, for `inits` followed by the enable instructions. */
export function enableTransactions(
  inits: TransactionInstruction[],
  enable: TransactionInstruction[],
): TransactionInstruction[][] {
  const txs: TransactionInstruction[][] = [];
  for (let i = 0; i < inits.length; i += TICK_ARRAY_INITS_PER_TX) {
    txs.push(inits.slice(i, i + TICK_ARRAY_INITS_PER_TX));
  }
  if (txs.length === 0) return [enable];
  txs[txs.length - 1]!.push(...enable);
  return txs;
}

// --- the position NFT -----------------------------------------------------------------------------

export interface PositionNft {
  /** The token account holding the NFT. */
  address: PublicKey;
  /** Whose wallet holds it. */
  holder: PublicKey;
  /** Its SPL delegate, if any — an open order sets this to the `RangeOrder`. */
  delegate: PublicKey | null;
  /** SPL Token or Token-2022, whichever minted the NFT. */
  tokenProgram: PublicKey;
}

/** Decode the fields above from a raw SPL token account (same base layout under Token-2022). */
export function decodePositionNft(
  address: PublicKey,
  info: Pick<AccountInfo<Buffer>, "data" | "owner">,
): PositionNft {
  const d = info.data;
  if (d.length < 165) {
    throw new CookieMcpError("position token account is malformed", "this is a bug");
  }
  // SPL token account: owner at 32, delegate COption<Pubkey> at 72 (tag u32, key at 76).
  return {
    address,
    holder: new PublicKey(d.subarray(32, 64)),
    delegate: d.readUInt32LE(72) === 1 ? new PublicKey(d.subarray(76, 108)) : null,
    tokenProgram: info.owner,
  };
}

/** Where the position NFT sits now: the single token account holding it, or null if none does. */
export async function findPositionNft(
  conn: Connection,
  positionMint: PublicKey,
): Promise<PositionNft | null> {
  const largest = await conn.getTokenLargestAccounts(positionMint, "confirmed");
  const holder = largest.value.find((a) => a.amount === "1");
  if (!holder) return null;
  const info = await conn.getAccountInfo(holder.address, "confirmed");
  if (!info) return null;
  return decodePositionNft(holder.address, info);
}

// --- payout accounts ------------------------------------------------------------------------------

/**
 * Where `zip` / `finish` pay each side: the owner's associated token account, or for wrapped COOK
 * the order's transient account (`nativePayoutPda`). `ownerAtas` are the owner's accounts among them,
 * which must exist before the keeper will touch the order; the program refuses anything else.
 */
export function payoutAccounts(p: {
  order: PublicKey;
  owner: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
}): {
  payoutA: PublicKey;
  payoutB: PublicKey;
  ownerAtas: { mint: PublicKey; address: PublicKey }[];
} {
  const side = (mint: PublicKey, tokenProgram: PublicKey) =>
    mint.equals(NATIVE_MINT)
      ? { address: nativePayoutPda(p.order), ownerAta: false }
      : {
          address: getAssociatedTokenAddressSync(mint, p.owner, true, tokenProgram),
          ownerAta: true,
        };
  const a = side(p.mintA, p.tokenProgramA);
  const b = side(p.mintB, p.tokenProgramB);
  return {
    payoutA: a.address,
    payoutB: b.address,
    ownerAtas: [
      { mint: p.mintA, ...a },
      { mint: p.mintB, ...b },
    ]
      .filter((s) => s.ownerAta)
      .map((s) => ({ mint: s.mint, address: s.address })),
  };
}

/**
 * Idempotent creates for the owner's payout accounts, paid by the owner. Part of the start flow: the
 * keeper never pays that rent, because rent paid for an account the owner controls is rent the owner
 * can take back (close, let the keeper recreate, repeat). None for wrapped COOK, which pays out as
 * plain COOK through the order's transient account.
 */
export function buildPayoutAtaIxs(p: {
  owner: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  tokenProgramA: PublicKey;
  tokenProgramB: PublicKey;
}): TransactionInstruction[] {
  return [[p.mintA, p.tokenProgramA] as const, [p.mintB, p.tokenProgramB] as const]
    .filter(([mint]) => !mint.equals(NATIVE_MINT))
    .map(([mint, tokenProgram]) =>
      createAssociatedTokenAccountIdempotentInstruction(
        p.owner,
        getAssociatedTokenAddressSync(mint, p.owner, true, tokenProgram),
        p.owner,
        mint,
        tokenProgram,
      ),
    );
}

// --- owner instructions ---------------------------------------------------------------------------

/** The owner starts an order; `cranker` pins who may `zip` it (`null` lets anyone). */
export function buildEnableIx(p: {
  program: Program;
  owner: PublicKey;
  whirlpool: PublicKey;
  position: PublicKey;
  nft: PublicKey;
  nftTokenProgram: PublicKey;
  direction: ZipDirection;
  minStep: number;
  cranker: PublicKey | null;
}): Promise<TransactionInstruction> {
  return p.program.methods
    .enable({ [p.direction]: {} }, p.minStep, p.cranker)
    .accountsStrict({
      owner: p.owner,
      whirlpool: p.whirlpool,
      position: p.position,
      positionTokenAccount: p.nft,
      rangeOrder: rangeOrderPda(p.position),
      tokenProgram: p.nftTokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * The owner (or whoever holds the NFT now) cancels an order. With the NFT account it also revokes the
 * delegation; without it the order just closes (NFT sold, or the position already closed). Rent goes
 * to the order's owner either way.
 */
export function buildDisableIx(p: {
  program: Program;
  signer: PublicKey;
  owner: PublicKey;
  position: PublicKey;
  nft: { address: PublicKey; tokenProgram: PublicKey } | null;
}): Promise<TransactionInstruction> {
  return p.program.methods
    .disable()
    .accountsStrict({
      signer: p.signer,
      owner: p.owner,
      rangeOrder: rangeOrderPda(p.position),
      // Anchor's optional accounts: `null` means "not provided" (the program id is sent in the slot).
      positionTokenAccount: (p.nft?.address ?? null) as never,
      tokenProgram: (p.nft?.tokenProgram ?? null) as never,
    })
    .instruction();
}
