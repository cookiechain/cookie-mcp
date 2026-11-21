// Dice Club (`DiCe5Vcp…`): the on-chain side. A single `House` PDA holds the rules and the seed-chain
// head, a lamport `vault` PDA holds the bankroll, and each pending bet is a `Bet` PDA at
// `["bet", player, nonce_le]` that the house's keeper closes when it settles (revealing the next seed
// of its pre-committed chain) — rent back to the player. `place_bet` is what a player signs;
// `expire_bet` is the permissionless refund of a bet the keeper failed to settle by its deadline.
// `settle_bet` and the authority instructions are the house's and are deliberately not built here.
//
// Ported from cookiedice `src/solana/diceClient.ts` + `src/history/betHistory.ts`.
import {
  AnchorProvider,
  BN,
  BorshCoder,
  EventParser,
  Program as AnchorProgram,
  type Idl,
  type Program,
} from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";

import { PROGRAM_IDS } from "../config";
import diceIdl from "../../idl/cookie_dice.json" with { type: "json" };

export const DICE_PROGRAM_ID = new PublicKey(PROGRAM_IDS.dice);

// A stale IDL after a redeploy would derive every PDA against the wrong program — fail at import
// (the boot smoke catches it) instead.
const idlAddress = (diceIdl as { address?: string }).address;
if (idlAddress !== PROGRAM_IDS.dice) {
  throw new Error(
    `src/idl/cookie_dice.json is for ${idlAddress}, but PROGRAM_IDS.dice is ${PROGRAM_IDS.dice} — ` +
      "re-copy the IDL from the cookiedice repo",
  );
}

/** Compute budget the Dice Club site gives `place_bet` (gate check included it runs ~16k). */
export const PLACE_BET_CU = 60_000;

// --- PDAs -----------------------------------------------------------------------------------------

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, DICE_PROGRAM_ID)[0];

export const houseAddress = (): PublicKey => pda(Buffer.from("house"));
export const vaultAddress = (): PublicKey => pda(Buffer.from("vault"));
export const gateAddress = (): PublicKey => pda(Buffer.from("gate"));

/** `["bet", player, nonce as u64 LE]` — big-endian derives a different address. */
export function betAddress(player: PublicKey, nonce: bigint): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(nonce);
  return pda(Buffer.from("bet"), player.toBuffer(), le);
}

// --- program + decoders ---------------------------------------------------------------------------

/** A provider that builds but never signs: the wallet signs through our own sender. */
function readOnlyProvider(conn: Connection): AnchorProvider {
  const wallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
  };
  return new AnchorProvider(conn, wallet as never, { commitment: "confirmed" });
}

export function diceProgram(conn: Connection): Program {
  return new AnchorProgram(diceIdl as Idl, readOnlyProvider(conn)) as unknown as Program;
}

const coder = new BorshCoder(diceIdl as Idl);

export interface House {
  authority: PublicKey;
  operator: PublicKey;
  treasury: PublicKey;
  seedCommitment: Buffer;
  seedIndex: bigint;
  nextNonce: bigint;
  settledNonce: bigint;
  /** Full payouts (stake + profit) owed to pending bets. */
  lockedLiability: bigint;
  edgeBps: bigint;
  maxPayoutBps: bigint;
  minBetLamports: bigint;
  settleTimeoutSlots: bigint;
  totalBets: bigint;
  totalWagered: bigint;
  totalPaid: bigint;
  expiredCount: bigint;
  paused: boolean;
}

export interface Bet {
  address: PublicKey;
  player: PublicKey;
  nonce: bigint;
  amount: bigint;
  /** Locked at placement: what a win pays, stake included. */
  payout: bigint;
  target: number;
  clientSeed: Buffer;
  placementCommitment: Buffer;
  /** From this slot on the bet can only be refunded (`expire_bet`). */
  deadlineSlot: bigint;
}

export interface Gate {
  /** Verified Metaplex collection a bettor must hold an item of. */
  collection: PublicKey;
  enabled: boolean;
}

const big = (v: { toString(): string }) => BigInt(v.toString());

// The raw `BorshCoder` keeps the IDL's snake_case field names, for accounts and events alike (only
// `Program.account` camelCases them).
export function decodeHouse(data: Buffer): House {
  const r = coder.accounts.decode("House", data);
  return {
    authority: r.authority,
    operator: r.operator,
    treasury: r.treasury,
    seedCommitment: Buffer.from(r.seed_commitment),
    seedIndex: big(r.seed_index),
    nextNonce: big(r.next_nonce),
    settledNonce: big(r.settled_nonce),
    lockedLiability: big(r.locked_liability),
    edgeBps: BigInt(r.edge_bps),
    maxPayoutBps: BigInt(r.max_payout_bps),
    minBetLamports: big(r.min_bet),
    settleTimeoutSlots: big(r.settle_timeout_slots),
    totalBets: big(r.total_bets),
    totalWagered: big(r.total_wagered),
    totalPaid: big(r.total_paid),
    expiredCount: big(r.expired_count),
    paused: r.paused,
  };
}

export function decodeBet(address: PublicKey, data: Buffer): Bet {
  const r = coder.accounts.decode("Bet", data);
  return {
    address,
    player: r.player,
    nonce: big(r.nonce),
    amount: big(r.amount),
    payout: big(r.payout),
    target: r.target,
    clientSeed: Buffer.from(r.client_seed),
    placementCommitment: Buffer.from(r.placement_commitment),
    deadlineSlot: big(r.deadline_slot),
  };
}

export function decodeGate(data: Buffer): Gate {
  const r = coder.accounts.decode("Gate", data);
  return { collection: r.collection, enabled: r.enabled };
}

/** Memcmp filters for one player's pending bets (Bet layout: disc 8 | player 32 | nonce 8 | …). */
export function playerBetFilters(player: PublicKey) {
  return [
    { memcmp: { offset: 0, bytes: bs58.encode(coder.accounts.accountDiscriminator("Bet")) } },
    { memcmp: { offset: 8, bytes: player.toBase58() } },
  ];
}

/** Every pending bet of a player, oldest first. */
export async function fetchPlayerBets(conn: Connection, player: PublicKey): Promise<Bet[]> {
  const rows = await conn.getProgramAccounts(DICE_PROGRAM_ID, {
    commitment: "confirmed",
    filters: playerBetFilters(player),
  });
  return rows
    .map((r) => decodeBet(r.pubkey, r.account.data))
    .sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0));
}

// --- instructions ---------------------------------------------------------------------------------

/**
 * `place_bet`, with a compute-budget ix in front. The bet PDA comes from `nextNonce`, so a house read
 * that went stale (someone else bet in between) fails the `init` constraint — it never lands on the
 * wrong account. `pass` is the player's club NFT (token account + metadata); the program reads it
 * only while the gate is on.
 */
export async function buildPlaceBetTx(
  program: Program,
  args: {
    player: PublicKey;
    nonce: bigint;
    amount: bigint;
    target: number;
    clientSeed: Buffer;
    pass: { tokenAccount: PublicKey; metadata: PublicKey } | null;
  },
): Promise<Transaction> {
  // `null` for an optional account makes Anchor pass the program id in its slot ("None").
  const accounts: Record<string, PublicKey | null> = {
    player: args.player,
    house: houseAddress(),
    vault: vaultAddress(),
    bet: betAddress(args.player, args.nonce),
    systemProgram: SystemProgram.programId,
    gate: gateAddress(),
    passToken: args.pass?.tokenAccount ?? null,
    passMetadata: args.pass?.metadata ?? null,
  };
  const ix = await program.methods
    .placeBet(new BN(args.amount.toString()), args.target, Array.from(args.clientSeed))
    .accountsStrict(accounts as never)
    .instruction();
  return new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: PLACE_BET_CU }))
    .add(ix);
}

/** `expire_bet`: refunds the stake of the queue-head bet once its deadline passed. Anyone may crank. */
export async function buildExpireBetTx(
  program: Program,
  cranker: PublicKey,
  bet: Pick<Bet, "address" | "player">,
): Promise<Transaction> {
  const ix = await program.methods
    .expireBet()
    .accountsStrict({
      cranker,
      house: houseAddress(),
      vault: vaultAddress(),
      player: bet.player,
      bet: bet.address,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return new Transaction().add(ix);
}

// --- events ---------------------------------------------------------------------------------------

/** One `BetResolved`: a settle (seed revealed) or an expiry (stake refunded, no seed). */
export interface ResolvedEvent {
  player: string;
  nonce: bigint;
  amount: bigint;
  target: number;
  /** Lamports paid to the player: payout on a win, 0 on a loss, the stake on an expiry. */
  paid: bigint;
  clientSeed: Buffer;
  commitment: Buffer;
  placementCommitment: Buffer;
  /** All zeroes on an expiry. */
  serverSeed: Buffer;
  seedIndex: bigint;
  roll: number;
  won: boolean;
  expired: boolean;
}

const parser = new EventParser(DICE_PROGRAM_ID, coder);

/**
 * `BetResolved` events in a transaction's logs. Anchor 0.31 keeps the IDL's spelling for event names
 * AND fields (`"BetResolved"`, `client_seed`) — matching the camelCase forms silently finds nothing
 * (a live bug the Dice Club site shipped with once).
 */
export function parseResolvedEvents(logs: string[]): ResolvedEvent[] {
  const out: ResolvedEvent[] = [];
  for (const ev of parser.parseLogs(logs)) {
    if (ev.name !== "BetResolved") continue;
    const d = ev.data as Record<string, any>;
    out.push({
      player: (d.player as PublicKey).toBase58(),
      nonce: big(d.nonce),
      amount: big(d.amount),
      target: Number(d.target),
      paid: big(d.payout),
      clientSeed: Buffer.from(d.client_seed),
      commitment: Buffer.from(d.commitment),
      placementCommitment: Buffer.from(d.placement_commitment),
      serverSeed: Buffer.from(d.server_seed),
      seedIndex: big(d.seed_index),
      roll: Number(big(d.roll)),
      won: Boolean(d.won),
      expired: Boolean(d.expired),
    });
  }
  return out;
}

// --- errors ---------------------------------------------------------------------------------------

/**
 * `DiceError` in `programs/cookie_dice/src/errors.rs` — positional from 6000, appended only. Taken
 * from the SOURCE enum, not the IDL (a checked-in IDL can lag an upgrade).
 */
export const DICE_ERRORS: Record<number, { name: string; hint: string }> = {
  6000: { name: "HousePaused", hint: "the house has paused the table; try again later" },
  6001: {
    name: "StakeBelowMinimum",
    hint: "raise the stake to at least the table minimum (get_dice_table)",
  },
  6002: {
    name: "TargetOutOfRange",
    hint: "pick a chance inside the table's range (get_dice_table)",
  },
  6003: {
    name: "ExceedsBankroll",
    hint: "the bet could win more than the bankroll allows — lower the stake or raise the chance (get_dice_table maxStake)",
  },
  6004: { name: "OutOfOrderSettlement", hint: "only the oldest pending bet can be resolved" },
  6005: { name: "SeedCommitmentMismatch", hint: "house-side error" },
  6006: {
    name: "TimeoutNotReached",
    hint: "the bet has not reached its deadline yet — the keeper may still settle it; wait",
  },
  6007: { name: "BetsPending", hint: "house-side error" },
  6008: { name: "VaultUnderfunded", hint: "house-side error" },
  6009: { name: "InvalidHouseParams", hint: "house-side error" },
  6010: { name: "MathOverflow", hint: "lower the stake" },
  6011: {
    name: "NotAClubMember",
    hint: "Dice Club is members-only: the wallet must hold a verified NFT of the club's collection",
  },
  6012: {
    name: "TableStalled",
    hint: "10 bets are already waiting for the keeper, so the table is closed until it catches up; try again in a minute",
  },
  6013: {
    name: "SettleDeadlinePassed",
    hint: "the bet is past its deadline and can only be refunded",
  },
  6014: { name: "NotTheNominee", hint: "house-side error" },
};

/** The `DiceError` a failed simulation hit, from its `{InstructionError:[i,{Custom:n}]}` or logs. */
export function diceErrorOf(
  err: unknown,
  logs: string[] = [],
): { code: number; name: string; hint: string } | null {
  const custom = (err as { InstructionError?: [number, { Custom?: number }] } | null)
    ?.InstructionError?.[1]?.Custom;
  let code = typeof custom === "number" ? custom : null;
  if (code === null) {
    const m = logs.join("\n").match(/Error Number: (\d+)/);
    if (m) code = Number(m[1]);
  }
  if (code === null || !DICE_ERRORS[code]) return null;
  return { code, ...DICE_ERRORS[code] };
}
