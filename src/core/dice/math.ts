// Dice Club's game rules, as pure functions. Each one mirrors the program
// (`programs/cookie_dice/src/math.rs` / `fairness.rs` in the cookiedice repo) bit for bit: a bet is
// quoted here before anything is sent, and every settled roll is re-derived here from the seeds the
// house revealed — so a drift between this file and the program is either a refused bet the agent
// was told would pass, or a "verified" roll that is not what the chain played.
//
// Units: amounts are lamports (bigint); `target` is basis points of the 0–9999 roll space, and a bet
// wins when `roll < target` — so target 5000 is a 50.00% chance.
import { createHash, createHmac } from "node:crypto";

import { CookieMcpError } from "../errors";

export const BPS = 10_000n;
/** Rolls are integers in `[0, ROLL_SPACE)`. */
export const ROLL_SPACE = 10_000n;
export const SEED_BYTES = 32;
/** `MAX_PENDING` in the program: at this many unsettled bets `place_bet` fails `TableStalled`. */
export const MAX_PENDING = 10n;

export interface HouseRules {
  edgeBps: bigint;
  minBetLamports: bigint;
  /** Cap on one bet's PROFIT as a share of the free bankroll, in bps. */
  maxPayoutBps: bigint;
}

/** Largest target at this edge: past it a "win" pays no more than the stake. */
export function maxTargetForEdge(edgeBps: bigint): number {
  return Number(BPS - edgeBps) - 1;
}

/** Payout on a win, stake included: `stake * (10000 - edge) / target`, floored (house side). */
export function payoutLamports(stake: bigint, target: number, edgeBps: bigint): bigint {
  return (stake * (BPS - edgeBps)) / BigInt(target);
}

/** Lamports the vault keeps free, i.e. the house's own money: `vault − locked − rent`, floored at 0. */
export function freeBankroll(vault: bigint, lockedLiability: bigint, rentExempt: bigint): bigint {
  const free = vault - lockedLiability - rentExempt;
  return free > 0n ? free : 0n;
}

/** Most profit one bet may win right now. */
export function maxProfitPerBet(free: bigint, maxPayoutBps: bigint): bigint {
  return (free * maxPayoutBps) / BPS;
}

/**
 * Largest stake the house takes at `target`. Profit is linear in the stake, so this inverts
 * `maxProfitPerBet`; long shots cap far lower than even money. `0n` when not even the minimum fits.
 */
export function maxStakeForTarget(rules: HouseRules, free: bigint, target: number): bigint {
  const denominator = BPS - rules.edgeBps - BigInt(target);
  if (denominator <= 0n) return 0n;
  const stake = (maxProfitPerBet(free, rules.maxPayoutBps) * BigInt(target)) / denominator;
  return stake < rules.minBetLamports ? 0n : stake;
}

export type BetRefusal =
  "paused" | "table-stalled" | "stake-below-minimum" | "target-out-of-range" | "exceeds-bankroll";

export interface BetCheck {
  ok: boolean;
  reason?: BetRefusal;
  payout: bigint;
  profit: bigint;
  /** Largest stake the house would take at this target right now. */
  maxStake: bigint;
}

/**
 * The exact predicate `place_bet` enforces, in the program's order (gate aside — that is an account
 * check, see club.ts). Running it first means a refused bet never costs a fee.
 */
export function checkBet(
  rules: HouseRules,
  state: { paused: boolean; pending: bigint; free: bigint },
  stake: bigint,
  target: number,
): BetCheck {
  const inRange =
    Number.isInteger(target) && target >= 1 && target <= maxTargetForEdge(rules.edgeBps);
  const payout = inRange ? payoutLamports(stake, target, rules.edgeBps) : 0n;
  const profit = payout > stake ? payout - stake : 0n;
  const maxStake = inRange ? maxStakeForTarget(rules, state.free, target) : 0n;
  const refuse = (reason: BetRefusal): BetCheck => ({
    ok: false,
    reason,
    payout,
    profit,
    maxStake,
  });
  if (state.paused) return refuse("paused");
  if (state.pending >= MAX_PENDING) return refuse("table-stalled");
  if (stake < rules.minBetLamports) return refuse("stake-below-minimum");
  if (!inRange) return refuse("target-out-of-range");
  if (profit > maxProfitPerBet(state.free, rules.maxPayoutBps)) return refuse("exceeds-bankroll");
  return { ok: true, payout, profit, maxStake };
}

/**
 * Win chance in percent (`49.5`, `"50"`, `"12.25%"`) → target bps. At most two decimals: the roll
 * space is 0.00–99.99, so `33.333` has no exact target and is refused rather than silently rounded.
 */
export function chanceToTarget(chance: string | number): number {
  const s = String(chance).trim().replace(/%$/, "").trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new CookieMcpError(
      `chance must be a percentage with at most two decimals, got ${String(chance)}`,
      'pass the win chance in percent, e.g. chance: 50 (even odds, ~1.98x) or chance: "12.5"',
    );
  }
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Target bps → percent string: 5000 → "50", 1250 → "12.5", 4433 → "44.33". */
export function targetToChance(target: number): string {
  return (target / 100).toFixed(2).replace(/\.?0+$/, "");
}

/** Payout ÷ stake, for display only. */
export function multiplier(target: number, edgeBps: bigint): number {
  return Math.floor((Number(BPS - edgeBps) / target) * 10_000) / 10_000;
}

// --- fairness -------------------------------------------------------------------------------------

export function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * `roll = be_u64(hmac_sha256(key = serverSeed, clientSeed ‖ nonce_le)[0..8]) % 10000` — `derive_roll`
 * in `fairness.rs`. The pinned cross-language vector is in math.test.ts.
 */
export function deriveRoll(serverSeed: Uint8Array, clientSeed: Uint8Array, nonce: bigint): number {
  const msg = Buffer.alloc(SEED_BYTES + 8);
  Buffer.from(clientSeed).copy(msg, 0);
  msg.writeBigUInt64LE(nonce, SEED_BYTES);
  const mac = createHmac("sha256", Buffer.from(serverSeed)).update(msg).digest();
  return Number(mac.readBigUInt64BE(0) % ROLL_SPACE);
}

/**
 * A client seed: 64 hex chars are used as-is; any other text is hashed (`sha256(utf8)`, as the Dice
 * Club site's "use your own seed" does); omitted → 32 random bytes. The player's seed is what stops
 * a house holding the whole seed chain from knowing a roll before the bet is placed.
 */
export function clientSeedFrom(input?: string): Buffer {
  const s = input?.trim() ?? "";
  if (!s) return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(SEED_BYTES)));
  const hex = s.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  return sha256(new TextEncoder().encode(s));
}

export interface RollProof {
  serverSeed: Uint8Array;
  clientSeed: Uint8Array;
  /** What `sha256(serverSeed)` must equal: the chain head when the bet settled. */
  commitment: Uint8Array;
  nonce: bigint;
  target: number;
  /** The payout a win owes, when known (`roll_dice` quoted it); checked against `paid` on a win. */
  winPayout?: bigint;
  /** What the event claims. */
  roll: number;
  won: boolean;
  paid: bigint;
}

export interface RollCheck {
  /** The revealed seed opens the commitment it was pinned to. */
  revealValid: boolean;
  /** Our own derivation of the roll. */
  roll: number;
  won: boolean;
  /** Roll, outcome and amount paid all match what the chain published. */
  matchesChain: boolean;
}

/** Re-derive a settled roll from its proof; never trust the event's own `roll` / `won`. */
export function verifyRoll(p: RollProof): RollCheck {
  const revealValid = sha256(p.serverSeed).equals(Buffer.from(p.commitment));
  const roll = deriveRoll(p.serverSeed, p.clientSeed, p.nonce);
  const won = roll < p.target;
  const expectedPaid = !won ? 0n : (p.winPayout ?? p.paid);
  return {
    revealValid,
    roll,
    won,
    matchesChain: roll === p.roll && won === p.won && expectedPaid === p.paid,
  };
}

/** Roll bps → "0.00"–"99.99", the scale the game shows. */
export function formatRoll(roll: number): string {
  return (roll / 100).toFixed(2);
}
