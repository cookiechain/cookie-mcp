// DCA schedules on Cookie Chain — the standalone Cookiebox DCA program (`DCAkvX8…`), filled by the
// same keeper that fills limit orders, through the same aggregator router `trade` uses.
//
// A DCA is a stop-market order that fires on a clock instead of a price, N times: the WHOLE budget
// is escrowed at open, and each cycle the keeper may release at most one `inAmountPerCycle` slice
// and must pay the proceeds into the account pinned at open. The program — not the keeper — owns
// the schedule, so a stolen keeper key cannot accelerate it, only execute it one slice at a time.
// A missed cycle is DROPPED, never caught up.
//
// Shape is the limit-order one exactly (`limitOrders.ts`): the Cookiebox aggregator builds the
// unsigned open/close transaction with the `/trade` DCA tab's own instruction builders
// (`/dca/open-tx`, `/dca/close-tx`) and pre-signs only the throwaway `base` keypair that seeds the
// schedule PDA. We do NOT trust that build — every instruction is decoded against the IDL and
// checked against OUR numbers before signing, then simulated on our RPC, signed, sent, confirmed.
//
// Fees: each cycle pays the user its proceeds minus the DCA program's own maker fee (10 bps at
// launch, 3 on a stable pair), read live off its `Fee` singleton and reported as `makerFeeBps`.
// The taker fee is 0.
import anchorPkg, { type Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, VersionedTransaction, type MessageV0 } from "@solana/web3.js";

import dcaIdl from "../idl/dca.json" with { type: "json" };
import {
  COOKIEBOX_AGG_API_URL,
  COOK_MINT,
  DEFAULT_SLIPPAGE_BPS,
  PROGRAM_IDS,
  explorerTxUrl,
} from "./config";
import { quoteAgg } from "./cookiebox";
import { resolveWallet } from "./domains";
import { CookieMcpError } from "./errors";
import { rawToUi, uiToRaw } from "./format";
import { fetchJson } from "./http";
import { noRouteError } from "./launchpad";
import {
  apiError as limitApiError,
  makerNetOut,
  normalizePrice,
  priceFromAmounts,
  simulateSignSendConfirm,
  takingAmountForPrice,
} from "./limitOrders";
import { resolveMeta } from "./trade";
import {
  assertHousekeepingIxs,
  decodeMessageIxs,
  housekeepingPrograms,
  otherSignersPresigned,
  refuser,
  same,
} from "./txVerify";
import { ownPublicKey, requireSigner } from "./wallet";

export const DCA_PROGRAM_ID = new PublicKey(PROGRAM_IDS.dca);

// The IDL ships its own `address`. A stale copy after a redeploy would make every PDA check here
// pass against the wrong program — fail at import (the boot smoke catches it) instead.
const idlAddress = (dcaIdl as { address?: string }).address;
if (idlAddress !== PROGRAM_IDS.dca) {
  throw new Error(
    `src/idl/dca.json is for ${idlAddress}, but PROGRAM_IDS.dca is ${PROGRAM_IDS.dca} — ` +
      "re-copy the IDL from the program repo",
  );
}

const ixCoder = new anchorPkg.BorshInstructionCoder(dcaIdl as Idl);

/** Schedule bounds the program enforces at `open_dca` (`programs/dca/src/constants.rs`). */
export const MIN_CYCLE_FREQUENCY = 60;
export const MAX_CYCLE_FREQUENCY = 365 * 24 * 3600;
export const MAX_CYCLES = 1024;
/** The API's cap on how far out a first cycle may be pushed. */
export const MAX_START_DELAY_SECONDS = 365 * 24 * 3600;

/** The open/close builds simulate server-side; give them the same headroom as /swap-tx. */
const BUILD_TX_TIMEOUT_MS = 60_000;

const refuse = refuser("DCA");
const ALLOWED_PROGRAMS = housekeepingPrograms(DCA_PROGRAM_ID);

// --- PDAs (golden-tested) -------------------------------------------------------------------------

export function dcaPda(base: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("dca"), base.toBuffer()], DCA_PROGRAM_ID)[0];
}

export function dcaReservePda(dca: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reserve"), dca.toBuffer()],
    DCA_PROGRAM_ID,
  )[0];
}

// --- Cycle arithmetic (mirrors the program and cookiebox's `projection.ts`) --------------------------

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * `ceil(total / perCycle)` — what the program derives, which is not always the count the caller had
 * in mind: rounding the slice up can retire the budget a cycle early (10 over 6 cycles is 2 per
 * cycle, so 5 cycles). Every result reports THIS number.
 */
export function cycleCountFor(total: bigint, perCycle: bigint): number {
  if (total <= 0n || perCycle <= 0n) return 0;
  return Number(ceilDiv(total, perCycle));
}

/** The slice to put on chain for "spend `total` over `cycles` cycles". Rounds UP. */
export function perCycleFor(total: bigint, cycles: number): bigint | null {
  if (total <= 0n || !Number.isInteger(cycles) || cycles <= 0) return null;
  return ceilDiv(total, BigInt(cycles));
}

// --- Verifying the aggregator's build before we sign ------------------------------------------------

export interface ExpectedOpen {
  owner: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inDeposited: bigint;
  inAmountPerCycle: bigint;
  cycleFrequency: number;
  /** Per-cycle band for one FULL slice, in raw output units. `0n` = that side unbounded. */
  minOut: bigint;
  maxOut: bigint;
  /** Unix seconds for the first cycle, `0` = now. */
  startAt: number;
  /** Native COOK input paid by wrapping: the program pins our wallet as the refund destination. */
  refundNative: boolean;
  /** Native COOK output to be unwrapped: our wallet, not an ATA, is the pinned payout. */
  payoutNative: boolean;
  /** The schedule address the API reported. */
  dca: PublicKey;
}

/**
 * The open transaction the aggregator built, checked against what we asked for. Throws a
 * `CookieMcpError` (nothing signed) on any mismatch.
 */
export function assertOpenTxTrustworthy(tx: VersionedTransaction, exp: ExpectedOpen): void {
  const ixs = decodeMessageIxs(tx, "DCA");
  const msg = tx.message as MessageV0;
  if (!same(msg.staticAccountKeys[0]!, exp.owner)) throw refuse("fee payer is not our wallet");

  const programIxs = ixs.filter((ix) => same(ix.programId, DCA_PROGRAM_ID));
  if (programIxs.length !== 1) throw refuse(`${programIxs.length} DCA instructions`);
  const ix = programIxs[0]!;
  const decoded = ixCoder.decode(ix.data);
  if (!decoded || decoded.name !== "open_dca") {
    throw refuse(`program instruction ${decoded?.name ?? "unknown"}`);
  }
  // The raw coder keeps the IDL's snake_case names (anchor's Program camel-cases them).
  const a = decoded.data as {
    in_deposited: { toString(): string };
    in_amount_per_cycle: { toString(): string };
    cycle_frequency: { toNumber(): number };
    min_out_amount: { toString(): string };
    max_out_amount: { toString(): string };
    start_at: { toNumber(): number };
    refund_native: boolean;
  };
  if (BigInt(a.in_deposited.toString()) !== exp.inDeposited) throw refuse("deposited amount");
  if (BigInt(a.in_amount_per_cycle.toString()) !== exp.inAmountPerCycle) {
    throw refuse("amount per cycle");
  }
  if (a.cycle_frequency.toNumber() !== exp.cycleFrequency) throw refuse("cycle frequency");
  // The band is the user's only protection against the rate a cycle fills at — an API that widened
  // it would be handing the keeper room the caller never granted.
  if (BigInt(a.min_out_amount.toString()) !== exp.minOut) throw refuse("minimum output per cycle");
  if (BigInt(a.max_out_amount.toString()) !== exp.maxOut) throw refuse("maximum output per cycle");
  // `open_dca` clamps `start_at.max(now)`, so a start time we did not ask for would fire at once.
  if (a.start_at.toNumber() !== exp.startAt) throw refuse("start time");
  if (a.refund_native !== exp.refundNative) throw refuse("refund flag");

  // open_dca accounts, in IDL order.
  const [base, user, dca, reserve, userInput, userOutput, inputMint, outputMint] = ix.keys;
  if (
    !base ||
    !user ||
    !dca ||
    !reserve ||
    !userInput ||
    !userOutput ||
    !inputMint ||
    !outputMint
  ) {
    throw refuse("account list too short");
  }
  if (!same(user, exp.owner)) throw refuse("user is not our wallet");
  if (!same(inputMint, exp.inputMint) || !same(outputMint, exp.outputMint)) throw refuse("mints");
  if (!same(dca, dcaPda(base)) || !same(dca, exp.dca)) throw refuse("schedule address");
  if (!same(reserve, dcaReservePda(dca))) throw refuse("reserve address");
  // The budget leaves OUR token account for the reserve, so `user_input_account` is always our ATA;
  // `refund_native` then makes the program pin our wallet as the refund destination instead.
  const inAta = getAssociatedTokenAddressSync(exp.inputMint, exp.owner, true);
  const outAta = getAssociatedTokenAddressSync(exp.outputMint, exp.owner, true);
  if (!same(userInput, inAta)) throw refuse("input account is not our token account");
  if (!same(userOutput, exp.payoutNative ? exp.owner : outAta)) throw refuse("payout account");

  const presigned = otherSignersPresigned(tx, exp.owner, refuse);
  if (presigned.length !== 1 || !same(presigned[0]!, base)) throw refuse("unexpected extra signer");
  assertHousekeepingIxs(ixs, exp.owner, [], { allowedPrograms: ALLOWED_PROGRAMS, refuse });
}

/** The close transaction, checked the same way: our schedule, refund to us, nothing else. */
export function assertCloseTxTrustworthy(
  tx: VersionedTransaction,
  exp: { owner: PublicKey; dca: PublicKey; inputMint: PublicKey; refundNative: boolean },
): void {
  const ixs = decodeMessageIxs(tx, "DCA");
  const msg = tx.message as MessageV0;
  if (!same(msg.staticAccountKeys[0]!, exp.owner)) throw refuse("fee payer is not our wallet");

  const programIxs = ixs.filter((ix) => same(ix.programId, DCA_PROGRAM_ID));
  if (programIxs.length !== 1) throw refuse(`${programIxs.length} DCA instructions`);
  const ix = programIxs[0]!;
  const decoded = ixCoder.decode(ix.data);
  if (!decoded || decoded.name !== "close_dca") {
    throw refuse(`program instruction ${decoded?.name ?? "unknown"}`);
  }
  // close_dca accounts: [dca, user, reserve, user_input_account, input_mint, token_program].
  const [dca, user, reserve, userInput] = ix.keys;
  if (!dca || !user || !reserve || !userInput) throw refuse("account list too short");
  if (!same(dca, exp.dca)) throw refuse("schedule address");
  if (!same(user, exp.owner)) throw refuse("user is not our wallet");
  if (!same(reserve, dcaReservePda(dca))) throw refuse("reserve address");
  // The refund goes to the account pinned at open: our wallet for a native-refund schedule, our
  // ATA otherwise. Either way it must be ours.
  const expectedRefund = exp.refundNative
    ? exp.owner
    : getAssociatedTokenAddressSync(exp.inputMint, exp.owner, true);
  if (!same(userInput, expectedRefund)) throw refuse("refund account is not ours");

  // A partial unwrap co-signs with a throwaway native account the API pre-signed for us.
  const temps = otherSignersPresigned(tx, exp.owner, refuse);
  assertHousekeepingIxs(ixs, exp.owner, temps, { allowedPrograms: ALLOWED_PROGRAMS, refuse });
}

// --- Aggregator API types ---------------------------------------------------------------------------

export interface AggDcaSchedule {
  dca: string;
  user: string;
  inputMint: string;
  outputMint: string;
  inDeposited: string;
  inUsed: string;
  inRemaining: string;
  outReceived: string;
  inAmountPerCycle: string;
  cycleFrequency: number;
  nextCycleAt: number;
  cyclesTotal: number;
  cyclesRemaining: number;
  spentPct: number;
  averagePrice: number | null;
  minOutAmount: string;
  maxOutAmount: string;
  minOutAmountNet: string;
  makerFeeBps: number;
  payoutNative: boolean;
  refundNative: boolean;
  waiting: boolean;
  createdAt: number;
}

interface AggOpenTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  dca: string;
  reserve: string;
  inDeposited: string;
  inAmountPerCycle: string;
  cycles: number;
  cycleFrequency: number;
  startAt: number;
  minOut: string;
  maxOut: string;
  makerFeeBps: number;
  payoutNative: boolean;
  refundNative: boolean;
  wrappedLamports: string;
}

interface AggCloseTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  dca: string;
  refundAmount: string;
  unwrappedLamports: string;
}

/** Re-hint the aggregator's failures; the DCA-specific 422s on top of the shared ones. */
export function dcaApiError(e: unknown, action: string): CookieMcpError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/DCA schedules are disabled/i.test(msg)) {
    return new CookieMcpError(
      "DCA is not switched on yet on the Cookiebox aggregator",
      "nothing was sent; use place_limit_order or trade meanwhile, and try again later",
    );
  }
  if (/Token-2022/i.test(msg)) {
    return new CookieMcpError(
      `${action} failed: DCA does not support Token-2022 mints`,
      "the keeper signs every cycle with the classic token program, so the schedule could never fill — use trade instead",
    );
  }
  if (/bonding-curve/i.test(msg)) {
    return new CookieMcpError(
      `${action} failed: DCA does not support MomoSwap bonding-curve tokens`,
      "a cycle fills through the router, which cannot buy on a curve — use trade, or wait for the token to graduate",
    );
  }
  if (/not a mint/i.test(msg)) {
    return new CookieMcpError(
      `${action} failed: that address is not a token mint`,
      "check the mints with search_tokens — a wallet address is a common typo here",
    );
  }
  if (/schedule not found/i.test(msg)) {
    return new CookieMcpError(
      "no such DCA schedule — it may have finished (a finished schedule closes itself) or been closed already",
      "run get_dca_schedules to see what is still running",
    );
  }
  if (/not the user of this schedule/i.test(msg)) {
    return new CookieMcpError(
      "this schedule belongs to another wallet",
      "only its owner can close it; check get_wallet and get_dca_schedules",
    );
  }
  return limitApiError(e, action);
}

// --- Reads --------------------------------------------------------------------------------------------

export interface DcaScheduleView {
  dca: string;
  /** `running`, `due` (a cycle is ready), `overdue` (a cycle was MISSED — never caught up). */
  status: "running" | "due" | "overdue" | "filling";
  input: {
    mint: string;
    symbol: string | null;
    deposited: string;
    spent: string;
    remaining: string;
  };
  output: { mint: string; symbol: string | null; received: string };
  /** One slice, in UI units of the input token. */
  perCycle: string;
  cycleSeconds: number;
  cyclesTotal: number;
  cyclesRemaining: number;
  spentPct: number;
  nextCycleAt: string;
  /** Seconds until the next cycle; NEGATIVE means overdue by that much. */
  nextCycleInSeconds: number;
  /** What the schedule has actually bought at so far, output per input. null before cycle one. */
  averagePrice: number | null;
  /** Per-cycle band for one FULL slice, in UI output units. null = that side unbounded. */
  minPerCycle: string | null;
  /** The band's floor after the maker fee — what would actually land in the wallet. */
  minPerCycleNet: string | null;
  maxPerCycle: string | null;
  makerFeeBps: number;
  payoutNative: boolean;
  refundNative: boolean;
  createdAt: string;
}

/** Pure — tested. */
export function formatSchedule(
  s: AggDcaSchedule,
  input: { sym: string | null; dec: number },
  output: { sym: string | null; dec: number },
  now = Math.floor(Date.now() / 1000),
): DcaScheduleView {
  const delta = s.nextCycleAt - now;
  return {
    dca: s.dca,
    // Overdue is called out rather than shown as a late countdown: the program DROPS a missed
    // cycle instead of catching it up, so it is a real loss, not a delay.
    status: s.waiting ? "filling" : delta > 0 ? "running" : delta > -300 ? "due" : "overdue",
    input: {
      mint: s.inputMint,
      symbol: input.sym,
      deposited: rawToUi(s.inDeposited, input.dec),
      spent: rawToUi(s.inUsed, input.dec),
      remaining: rawToUi(s.inRemaining, input.dec),
    },
    output: {
      mint: s.outputMint,
      symbol: output.sym,
      received: rawToUi(s.outReceived, output.dec),
    },
    perCycle: rawToUi(s.inAmountPerCycle, input.dec),
    cycleSeconds: s.cycleFrequency,
    cyclesTotal: s.cyclesTotal,
    cyclesRemaining: s.cyclesRemaining,
    spentPct: s.spentPct,
    nextCycleAt: new Date(s.nextCycleAt * 1000).toISOString(),
    nextCycleInSeconds: delta,
    averagePrice: s.averagePrice,
    minPerCycle: s.minOutAmount === "0" ? null : rawToUi(s.minOutAmount, output.dec),
    minPerCycleNet: s.minOutAmount === "0" ? null : rawToUi(s.minOutAmountNet, output.dec),
    maxPerCycle: s.maxOutAmount === "0" ? null : rawToUi(s.maxOutAmount, output.dec),
    makerFeeBps: s.makerFeeBps,
    payoutNative: s.payoutNative,
    refundNative: s.refundNative,
    createdAt: new Date(s.createdAt * 1000).toISOString(),
  };
}

export async function getDcaSchedules(args: { owner?: string }): Promise<{
  owner: string;
  ownerName?: string;
  count: number;
  schedules: DcaScheduleView[];
}> {
  let owner: string;
  let ownerName: string | undefined;
  if (args.owner) {
    const r = await resolveWallet(args.owner, "owner");
    owner = r.pubkey.toBase58();
    ownerName = r.name ?? undefined;
  } else {
    const own = ownPublicKey();
    if (!own) {
      throw new CookieMcpError(
        "no wallet configured and no owner given",
        "pass `owner` (address or .cook name), or set COOKIE_PRIVATE_KEY to list your own schedules",
      );
    }
    owner = own;
  }
  const { schedules } = await fetchJson<{ user: string; schedules: AggDcaSchedule[] }>(
    `${COOKIEBOX_AGG_API_URL}/dca?user=${owner}`,
  ).catch((e) => {
    throw dcaApiError(e, "listing DCA schedules");
  });
  const views = await Promise.all(
    schedules.map(async (s) => {
      const { input, output } = await resolveMeta(s.inputMint, s.outputMint);
      return formatSchedule(s, input, output);
    }),
  );
  return {
    owner,
    ...(ownerName ? { ownerName } : {}),
    count: views.length,
    schedules: views,
  };
}

// --- Writes -------------------------------------------------------------------------------------------

export interface OpenDcaResult {
  signature: string;
  explorerUrl: string;
  dca: string;
  reserve: string;
  input: { mint: string; symbol: string | null; deposited: string; perCycle: string };
  output: { mint: string; symbol: string | null };
  /** As the PROGRAM derives it (`ceil(deposited / perCycle)`) — not always the count asked for. */
  cycles: number;
  cycleSeconds: number;
  startsAt: string;
  /** Per-cycle band for one full slice, in UI output units; null = unbounded. */
  minPerCycle: string | null;
  minPerCycleNet: string | null;
  maxPerCycle: string | null;
  makerFeeBps: number;
  /** The router's executable rate for ONE slice at open, for reference. */
  market: { rate: number } | null;
  payoutNative: boolean;
  refundNative: boolean;
  /** Native COOK wrapped into wCOOK inside the open, in COOK. */
  wrappedCook: string;
  note: string;
}

export async function openDca(args: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  cycles?: number;
  amountPerCycle?: string | number;
  cycleSeconds: number;
  minPrice?: string | number;
  maxPrice?: string | number;
  startAt?: number;
  wrapSol?: boolean;
  unwrapSol?: boolean;
  skipMarketCheck?: boolean;
}): Promise<OpenDcaResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  if (args.inputMint === args.outputMint) {
    throw new CookieMcpError("inputMint and outputMint are the same", "pick two different tokens");
  }
  let inputMint: PublicKey;
  let outputMint: PublicKey;
  try {
    inputMint = new PublicKey(args.inputMint);
    outputMint = new PublicKey(args.outputMint);
  } catch {
    throw new CookieMcpError("invalid mint address", "pass base58 mint addresses");
  }
  if ((args.cycles === undefined) === (args.amountPerCycle === undefined)) {
    throw new CookieMcpError(
      "pass exactly one of `cycles` or `amountPerCycle`",
      "`cycles` splits the budget for you (rounding the slice UP); `amountPerCycle` sets the slice directly",
    );
  }

  const { input, output } = await resolveMeta(args.inputMint, args.outputMint);
  let inDeposited: bigint;
  try {
    inDeposited = uiToRaw(args.amount, input.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is the WHOLE budget in UI units of the input token (max ${input.dec} decimals)`,
    );
  }
  if (inDeposited <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive budget");
  }

  let inAmountPerCycle: bigint | null;
  if (args.amountPerCycle !== undefined) {
    try {
      inAmountPerCycle = uiToRaw(args.amountPerCycle, input.dec);
    } catch {
      throw new CookieMcpError(
        `invalid amountPerCycle "${args.amountPerCycle}"`,
        `the slice is a UI amount of the input token (max ${input.dec} decimals)`,
      );
    }
  } else {
    inAmountPerCycle = perCycleFor(inDeposited, args.cycles!);
  }
  if (!inAmountPerCycle || inAmountPerCycle <= 0n) {
    throw new CookieMcpError(
      "the amount per cycle rounds to zero",
      "raise the budget or lower the number of cycles",
    );
  }
  if (inAmountPerCycle > inDeposited) {
    throw new CookieMcpError(
      "amountPerCycle is larger than the whole budget",
      "a cycle can never release more than what is escrowed — lower it, or raise `amount`",
    );
  }
  // The count the PROGRAM will derive, which is not always the one asked for: rounding the slice
  // up can retire the budget a cycle early (10 over 6 cycles is 2 per cycle, so 5 cycles).
  const cycles = cycleCountFor(inDeposited, inAmountPerCycle);
  if (cycles > MAX_CYCLES) {
    throw new CookieMcpError(
      `that is ${cycles} cycles, more than the program's ${MAX_CYCLES}`,
      "raise amountPerCycle, or lower `cycles`",
    );
  }
  if (
    !Number.isInteger(args.cycleSeconds) ||
    args.cycleSeconds < MIN_CYCLE_FREQUENCY ||
    args.cycleSeconds > MAX_CYCLE_FREQUENCY
  ) {
    throw new CookieMcpError(
      `cycleSeconds must be a whole number between ${MIN_CYCLE_FREQUENCY} and ${MAX_CYCLE_FREQUENCY}`,
      "e.g. 3600 hourly, 86400 daily, 604800 weekly",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  let startAt = 0;
  if (args.startAt !== undefined && args.startAt !== 0) {
    if (!Number.isInteger(args.startAt)) {
      throw new CookieMcpError("startAt must be whole unix SECONDS", "not milliseconds");
    }
    // `open_dca` clamps `start_at.max(now)`, so a past timestamp fires the first cycle at once —
    // the one thing a caller who set a start time opted out of.
    if (args.startAt <= now) {
      throw new CookieMcpError(
        "startAt is in the past",
        "omit it to start now, or pass a future time",
      );
    }
    if (args.startAt > now + MAX_START_DELAY_SECONDS) {
      throw new CookieMcpError("startAt is more than a year away", "pick a nearer first cycle");
    }
    startAt = args.startAt;
  }

  // The band is quoted per FULL slice, in raw output units — what the program stores. Converting
  // here (rather than letting the API redo it) keeps it in lockstep with the rate we quoted.
  const minPrice = args.minPrice === undefined ? null : normalizePrice(args.minPrice);
  const maxPrice = args.maxPrice === undefined ? null : normalizePrice(args.maxPrice);
  const minOut =
    minPrice == null
      ? 0n
      : (takingAmountForPrice(inAmountPerCycle, minPrice, input.dec, output.dec) ?? 0n);
  const maxOut =
    maxPrice == null
      ? 0n
      : (takingAmountForPrice(inAmountPerCycle, maxPrice, input.dec, output.dec) ?? 0n);
  if (minPrice != null && minOut <= 0n) {
    throw new CookieMcpError(
      "minPrice rounds to zero output for one cycle",
      "raise minPrice or the amount per cycle",
    );
  }
  if (maxPrice != null && maxOut <= 0n) {
    throw new CookieMcpError(
      "maxPrice rounds to zero output for one cycle",
      "raise maxPrice or the amount per cycle",
    );
  }
  if (minOut > 0n && maxOut > 0n && minOut > maxOut) {
    throw new CookieMcpError(
      "minPrice is above maxPrice, so no cycle could ever fill",
      "swap them, or drop one side",
    );
  }

  // The keeper fills a cycle through the aggregator's router, so its executable quote for ONE
  // SLICE is the only rate that means anything — a band set against a mid price is a band the
  // keeper can never satisfy, and a skipped cycle is never caught up.
  let market: OpenDcaResult["market"] = null;
  if (!args.skipMarketCheck) {
    let route;
    try {
      route = await quoteAgg(
        args.inputMint,
        args.outputMint,
        inAmountPerCycle.toString(),
        DEFAULT_SLIPPAGE_BPS,
        owner.toBase58(),
      );
    } catch (e) {
      throw await noRouteError([args.inputMint, args.outputMint], e);
    }
    if (!route) {
      const redirected = await noRouteError([args.inputMint, args.outputMint]);
      if (redirected instanceof CookieMcpError && !/no route found/.test(redirected.message)) {
        throw redirected; // launchpad token: point at the curve tools
      }
      throw new CookieMcpError(
        "no route exists between these tokens, so no cycle could ever fill",
        "check the mints with search_tokens; pass skipMarketCheck: true to open it anyway",
      );
    }
    const marketOut = BigInt(route.grossOutAmount ?? route.totalOutAmount);
    const rate = priceFromAmounts(inAmountPerCycle, marketOut, input.dec, output.dec);
    market = rate == null ? null : { rate };
    const slice = rawToUi(inAmountPerCycle, input.dec);
    const marketStr = rawToUi(marketOut, output.dec);
    if (minOut > 0n && minOut > marketOut) {
      throw new CookieMcpError(
        `one cycle of ${slice} ${input.sym ?? "input"} buys about ${marketStr} ${output.sym ?? "output"} right now, below your minPrice — every cycle would be SKIPPED, and a skipped cycle is never caught up`,
        "lower minPrice (it is a floor against a bad fill, not a target), or pass skipMarketCheck: true if you are deliberately waiting for a better rate",
      );
    }
    if (maxOut > 0n && maxOut < marketOut) {
      throw new CookieMcpError(
        `one cycle of ${slice} ${input.sym ?? "input"} buys about ${marketStr} ${output.sym ?? "output"} right now, ABOVE your maxPrice — every cycle would be skipped`,
        "raise maxPrice (it only guards against an implausibly good fill on a manipulated pool), or pass skipMarketCheck: true",
      );
    }
  }

  let built: AggOpenTx;
  try {
    built = await fetchJson<AggOpenTx>(`${COOKIEBOX_AGG_API_URL}/dca/open-tx`, {
      method: "POST",
      body: JSON.stringify({
        owner: owner.toBase58(),
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        inDeposited: inDeposited.toString(),
        inAmountPerCycle: inAmountPerCycle.toString(),
        cycleFrequency: args.cycleSeconds,
        ...(minOut > 0n ? { minOut: minOut.toString() } : {}),
        ...(maxOut > 0n ? { maxOut: maxOut.toString() } : {}),
        ...(startAt ? { startAt } : {}),
        ...(args.wrapSol === undefined ? {} : { wrapSol: args.wrapSol }),
        ...(args.unwrapSol === undefined ? {} : { unwrapSol: args.unwrapSol }),
      }),
      timeoutMs: BUILD_TX_TIMEOUT_MS,
    });
  } catch (e) {
    throw dcaApiError(e, "opening the schedule");
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  // What we asked for, not what the API echoed: wrapping native COOK ⇒ the refund is pinned to our
  // wallet; unwrapping a COOK output ⇒ so is the payout.
  const refundNative = (args.wrapSol ?? true) && args.inputMint === COOK_MINT;
  const payoutNative = (args.unwrapSol ?? true) && args.outputMint === COOK_MINT;
  assertOpenTxTrustworthy(tx, {
    owner,
    inputMint,
    outputMint,
    inDeposited,
    inAmountPerCycle,
    cycleFrequency: args.cycleSeconds,
    minOut,
    maxOut,
    startAt,
    refundNative,
    payoutNative,
    dca: new PublicKey(built.dca),
  });

  const { signature } = await simulateSignSendConfirm(tx, signer, built, "DCA open", {
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: String(args.amount),
    cycles,
    dca: built.dca,
  });

  const feeBps = built.makerFeeBps;
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    dca: built.dca,
    reserve: built.reserve,
    input: {
      mint: args.inputMint,
      symbol: input.sym,
      deposited: rawToUi(inDeposited, input.dec),
      perCycle: rawToUi(inAmountPerCycle, input.dec),
    },
    output: { mint: args.outputMint, symbol: output.sym },
    cycles,
    cycleSeconds: args.cycleSeconds,
    startsAt: new Date((startAt || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    minPerCycle: minOut > 0n ? rawToUi(minOut, output.dec) : null,
    minPerCycleNet: minOut > 0n ? rawToUi(makerNetOut(minOut, feeBps), output.dec) : null,
    maxPerCycle: maxOut > 0n ? rawToUi(maxOut, output.dec) : null,
    makerFeeBps: feeBps,
    market,
    payoutNative,
    refundNative,
    wrappedCook: rawToUi(built.wrappedLamports ?? "0", 9),
    note:
      `the whole budget is escrowed now; the keeper releases ${rawToUi(inAmountPerCycle, input.dec)} ` +
      `${input.sym ?? "input"} every ${args.cycleSeconds}s and pays the proceeds minus the maker fee. ` +
      "A cycle outside the band (or with no route) is SKIPPED, never caught up. Close any time with " +
      "close_dca to get the unspent remainder back; a finished schedule closes itself.",
  };
}

export interface CloseDcaResult {
  signature: string;
  explorerUrl: string;
  dca: string;
  /** The unspent remainder returned to the pinned input account. */
  refund: { mint: string; symbol: string | null; amount: string };
  /** COOK unwrapped back to the wallet inside the close (a wCOOK-funded schedule). */
  unwrappedCook: string;
  /** Cycles that will now never run. */
  cyclesCancelled: number;
}

export async function closeDca(args: {
  dca: string;
  unwrapSol?: boolean;
}): Promise<CloseDcaResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  let dca: PublicKey;
  try {
    dca = new PublicKey(args.dca);
  } catch {
    throw new CookieMcpError("invalid schedule address", "pass the `dca` from get_dca_schedules");
  }

  // Look the schedule up first so the result can name what came back (and so a stranger's
  // schedule fails with a sentence, not a 403).
  const { schedules } = await fetchJson<{ schedules: AggDcaSchedule[] }>(
    `${COOKIEBOX_AGG_API_URL}/dca?user=${owner.toBase58()}`,
  ).catch((e) => {
    throw dcaApiError(e, "looking the schedule up");
  });
  const mine = schedules.find((s) => s.dca === args.dca);
  if (!mine) {
    throw new CookieMcpError(
      "no DCA schedule with that address belongs to this wallet",
      "it may have finished (a finished schedule closes itself) or be another wallet's — run get_dca_schedules",
    );
  }

  let built: AggCloseTx;
  try {
    built = await fetchJson<AggCloseTx>(`${COOKIEBOX_AGG_API_URL}/dca/close-tx`, {
      method: "POST",
      body: JSON.stringify({
        owner: owner.toBase58(),
        dca: args.dca,
        ...(args.unwrapSol === undefined ? {} : { unwrapSol: args.unwrapSol }),
      }),
      timeoutMs: BUILD_TX_TIMEOUT_MS,
    });
  } catch (e) {
    throw dcaApiError(e, "closing the schedule");
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  assertCloseTxTrustworthy(tx, {
    owner,
    dca,
    inputMint: new PublicKey(mine.inputMint),
    refundNative: mine.refundNative,
  });

  const { signature } = await simulateSignSendConfirm(tx, signer, built, "DCA close", { dca });
  const { input } = await resolveMeta(mine.inputMint, mine.outputMint);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    dca: args.dca,
    refund: {
      mint: mine.inputMint,
      symbol: input.sym,
      amount: rawToUi(built.refundAmount ?? mine.inRemaining, input.dec),
    },
    unwrappedCook: rawToUi(built.unwrappedLamports ?? "0", 9),
    cyclesCancelled: mine.cyclesRemaining,
  };
}
