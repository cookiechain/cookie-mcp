// Limit orders on Cookie Chain — the Cookiebox escrow program (`L1M1tk…`) filled by a keeper that
// routes through the same aggregator /trade uses, so any pair with a route can rest as an order.
//
// Shape: the Cookiebox aggregator (agg.cookiebox.app) BUILDS the unsigned place/cancel transactions
// with the exact instruction builders its own Trade page uses (`/limit-orders/place-tx`,
// `/limit-orders/cancel-tx`) and pre-signs only the throwaway `base` keypair that seeds the order
// PDA. We do NOT trust that build: before signing, every instruction is decoded against the
// program IDL and checked — fee payer, maker, amounts, kind, pinned token accounts, and that no
// instruction touches a program or an account we did not expect. Then simulate on our RPC, sign,
// send, confirm. Non-custodial; the escrow is the program's, the key never leaves this process.
//
// Fees (Jupiter's model): the maker is paid `takingAmount − makerFee` on each fill (10 bps at launch,
// admin-tunable on the on-chain `Fee` singleton, so it is read live and never hardcoded). The taker
// fee is paid by the filler on top of the maker's price and is 0 while the only filler is the
// Cookiebox keeper.
import anchorPkg, { type Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  VersionedTransaction,
  type MessageV0,
} from "@solana/web3.js";

import limitOrderIdl from "../idl/limit_order.json" with { type: "json" };
import {
  COOKIEBOX_AGG_API_URL,
  COOK_MINT,
  DEFAULT_SLIPPAGE_BPS,
  PROGRAM_IDS,
  explorerTxUrl,
} from "./config";
import { unconfirmedError } from "./confirm";
import { quoteAgg } from "./cookiebox";
import { resolveWallet } from "./domains";
import { CookieMcpError } from "./errors";
import { rawToUi, uiToRaw } from "./format";
import { fetchJson } from "./http";
import { noRouteError } from "./launchpad";
import { getConnection } from "./rpc";
import { resolveMeta, type TokenMeta } from "./trade";
import { ownPublicKey, requireSigner } from "./wallet";
import type { TxSigner } from "./signer";

export const LIMIT_ORDER_PROGRAM_ID = new PublicKey(PROGRAM_IDS.limitOrder);

// The IDL ships its own `address`. A stale copy after a redeploy would make every PDA check here
// pass against the wrong program — fail at import (the boot smoke catches it) instead.
const idlAddress = (limitOrderIdl as { address?: string }).address;
if (idlAddress !== PROGRAM_IDS.limitOrder) {
  throw new Error(
    `src/idl/limit_order.json is for ${idlAddress}, but PROGRAM_IDS.limitOrder is ` +
      `${PROGRAM_IDS.limitOrder} — re-copy the IDL from the program repo`,
  );
}

const ixCoder = new anchorPkg.BorshInstructionCoder(limitOrderIdl as Idl);

/** On-chain `Order.kind`. */
export const ORDER_KIND_LIMIT = 0;
export const ORDER_KIND_STOP = 1;
export type LimitOrderKind = "limit" | "stop";

/** Orders default to a week, as on the Trade page and on Jupiter. `0` = good-til-cancelled. */
export const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 3600;
/** The API's own cap — a typo'd expiry can't pin funds for decades. */
export const MAX_EXPIRY_SECONDS = 365 * 24 * 3600;

/** The place/cancel builds simulate server-side; give them the same headroom as /swap-tx. */
const BUILD_TX_TIMEOUT_MS = 60_000;

// --- PDAs (golden-tested) -----------------------------------------------------------------------

export function orderPda(base: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), base.toBuffer()],
    LIMIT_ORDER_PROGRAM_ID,
  )[0];
}

export function reservePda(order: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reserve"), order.toBuffer()],
    LIMIT_ORDER_PROGRAM_ID,
  )[0];
}

// --- Exact price math (ported from cookiebox `pricing.ts`; all bigint, no floats) -------------------

const BPS = 10_000n;

/** A decimal string as an exact integer plus its scale: "1.25" → { value: 125n, scale: 2 }. */
export function parseDecimalToScaled(s: string): { value: bigint; scale: number } | null {
  const trimmed = s.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "", frac = ""] = trimmed.split(".");
  const digits = `${whole}${frac}`;
  if (digits === "") return null;
  return { value: BigInt(digits), scale: frac.length };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * The `taking_amount` an order carries for a limit price (output per input, human units). Rounds
 * UP so the maker never asks for less than the price they set — identical to what the API and the
 * Trade page compute, which is what lets us verify the built transaction against it.
 */
export function takingAmountForPrice(
  makingRaw: bigint,
  price: string,
  inputDecimals: number,
  outputDecimals: number,
): bigint | null {
  const parsed = parseDecimalToScaled(price);
  if (!parsed || parsed.value === 0n || makingRaw <= 0n) return null;
  const numerator = makingRaw * parsed.value * pow10(outputDecimals);
  const denominator = pow10(inputDecimals) * pow10(parsed.scale);
  return (numerator + denominator - 1n) / denominator;
}

/** Display-only inverse: output per input as a float. Never feed it back into an order. */
export function priceFromAmounts(
  makingRaw: bigint,
  takingRaw: bigint,
  inputDecimals: number,
  outputDecimals: number,
): number | null {
  if (makingRaw <= 0n) return null;
  const humanIn = Number(makingRaw) / Number(pow10(inputDecimals));
  const humanOut = Number(takingRaw) / Number(pow10(outputDecimals));
  if (!Number.isFinite(humanIn) || humanIn === 0) return null;
  return humanOut / humanIn;
}

/** How far a price sits from the market rate, in percent (positive = above market). */
export function pctFromMarket(price: number, market: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(market) || market <= 0) return null;
  return ((price - market) / market) * 100;
}

/** What the maker's wallet receives for `takingAmount`: the fee is rounded down, like the program. */
export function makerNetOut(takingAmount: bigint, makerFeeBps: number): bigint {
  return takingAmount - (takingAmount * BigInt(makerFeeBps)) / BPS;
}

/**
 * A price for the API must be a decimal STRING — a JSON number has already been through IEEE754.
 * Agents mostly pass numbers anyway, so accept one when it prints as a plain decimal (`0.75`), and
 * refuse the exponent forms JS uses for very small or very large values rather than guess.
 */
export function normalizePrice(input: string | number): string {
  const s = typeof input === "number" ? String(input) : input.trim();
  if (typeof input === "number" && (!Number.isFinite(input) || /e/i.test(s))) {
    throw new CookieMcpError(
      `price ${String(input)} cannot be represented exactly as a number`,
      'pass the price as a decimal string, e.g. "0.000012"',
    );
  }
  const parsed = parseDecimalToScaled(s);
  if (!parsed || parsed.value === 0n) {
    throw new CookieMcpError(
      `invalid price "${String(input)}"`,
      'price is output per input in human units, as a positive decimal string, e.g. "0.75"',
    );
  }
  return s;
}

/** Unix expiry from a relative lifetime. `0` = never; default one week. */
export function expiryFromSeconds(
  expiresInSeconds: number | undefined,
  now = Math.floor(Date.now() / 1000),
): number | null {
  const s = expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  if (!Number.isInteger(s) || s < 0) {
    throw new CookieMcpError(
      "expiresInSeconds must be a non-negative integer",
      "0 = never expires",
    );
  }
  if (s === 0) return null;
  if (s > MAX_EXPIRY_SECONDS) {
    throw new CookieMcpError(
      "expiresInSeconds is more than a year",
      `the maximum is ${MAX_EXPIRY_SECONDS} (one year); pass 0 for no expiry`,
    );
  }
  return now + s;
}

/**
 * Would this order be actionable the moment it lands? A take-profit whose limit is at or below
 * what the router pays right now fills immediately (a swap, at a worse price than `trade`); a stop
 * whose trigger is at or above the current rate is already triggered and sells at market at once.
 * Both are almost always a mis-typed price or a swapped pair, so `place_limit_order` refuses them
 * unless told otherwise. Pure — tested.
 */
export function fillsImmediately(kind: LimitOrderKind, priced: bigint, marketOut: bigint): boolean {
  return kind === "stop" ? marketOut <= priced : marketOut >= priced;
}

// --- Verifying the aggregator's build before we sign --------------------------------------------

/** Programs a place/cancel transaction may invoke. Anything else is refused before signing. */
export const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set([
  LIMIT_ORDER_PROGRAM_ID.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
]);

// SPL Token instruction tags this flow may legitimately contain.
const TOKEN_IX_TRANSFER = 3;
const TOKEN_IX_CLOSE_ACCOUNT = 9;
const TOKEN_IX_SYNC_NATIVE = 17;
const TOKEN_IX_INITIALIZE_ACCOUNT3 = 18;

export interface DecodedIx {
  programId: PublicKey;
  keys: PublicKey[];
  data: Buffer;
}

/**
 * Flatten a v0 message into plain instructions. Refuses lookup tables: the builds are compiled
 * inline (`fitsInline`), and a table would let the builder repoint accounts we cannot see.
 */
export function decodeMessageIxs(tx: VersionedTransaction): DecodedIx[] {
  const msg = tx.message as MessageV0;
  if (msg.version !== 0) {
    throw new CookieMcpError("unexpected legacy transaction from the aggregator", "retry");
  }
  if (msg.addressTableLookups.length > 0) {
    throw new CookieMcpError(
      "the limit-order build uses an address lookup table — refused before signing",
      "the build should be inline; retry, or report this if it persists",
    );
  }
  const keys = msg.staticAccountKeys;
  return msg.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex]!,
    keys: ix.accountKeyIndexes.map((i) => keys[i]!),
    data: Buffer.from(ix.data),
  }));
}

function refuse(what: string): CookieMcpError {
  return new CookieMcpError(
    `the aggregator's limit-order build did not match the request (${what}) — refused before signing`,
    "nothing was signed or sent; retry, and report this if it persists",
  );
}

function same(a: PublicKey, b: PublicKey): boolean {
  return a.equals(b);
}

/**
 * Checks shared by place and cancel: known programs only, our wallet as fee payer, and every
 * System / Token / ATA instruction moving value only between our own accounts.
 */
function assertHousekeepingIxs(ixs: DecodedIx[], owner: PublicKey, allowedTemps: PublicKey[]) {
  const wcookAta = getAssociatedTokenAddressSync(new PublicKey(COOK_MINT), owner, true);
  const isOurs = (k: PublicKey) => same(k, owner) || allowedTemps.some((t) => same(t, k));
  for (const ix of ixs) {
    const pid = ix.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(pid)) throw refuse(`instruction for unexpected program ${pid}`);
    if (same(ix.programId, SystemProgram.programId)) {
      const legacy = {
        programId: ix.programId,
        data: ix.data,
        keys: ix.keys.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })),
      };
      const type = SystemInstruction.decodeInstructionType(legacy);
      if (type === "Transfer") {
        const t = SystemInstruction.decodeTransfer(legacy);
        // The only lamport transfer a placement makes is the wrap into our own wCOOK ATA.
        if (!same(t.fromPubkey, owner) || !same(t.toPubkey, wcookAta)) {
          throw refuse("a lamport transfer not into our own wCOOK account");
        }
      } else if (type === "Create") {
        const c = SystemInstruction.decodeCreateAccount(legacy);
        // A partial unwrap on cancel funds a throwaway native token account we hold the key to.
        if (!same(c.fromPubkey, owner) || !allowedTemps.some((t) => same(t, c.newAccountPubkey))) {
          throw refuse("a system create-account for an unexpected account");
        }
      } else {
        throw refuse(`system instruction ${type}`);
      }
    } else if (same(ix.programId, TOKEN_PROGRAM_ID)) {
      const tag = ix.data[0];
      if (tag === TOKEN_IX_SYNC_NATIVE || tag === TOKEN_IX_INITIALIZE_ACCOUNT3) continue;
      if (tag === TOKEN_IX_TRANSFER) {
        // [source, destination, authority]: only we may authorise a transfer, and only into an
        // account of ours (the unwrap temp).
        if (!same(ix.keys[2]!, owner) || !isOurs(ix.keys[1]!)) {
          throw refuse("a token transfer to an account that is not ours");
        }
      } else if (tag === TOKEN_IX_CLOSE_ACCOUNT) {
        // [account, destination, authority]: the rent/lamports must come back to us.
        if (!same(ix.keys[1]!, owner) || !same(ix.keys[2]!, owner)) {
          throw refuse("a token account close paying someone else");
        }
      } else {
        throw refuse(`token instruction ${tag}`);
      }
    } else if (same(ix.programId, ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // [payer, ata, owner, mint, system, token]: an idempotent create for one of our own ATAs.
      if (!same(ix.keys[0]!, owner) || !same(ix.keys[2]!, owner)) {
        throw refuse("an associated-token-account create for another wallet");
      }
    }
  }
}

/** Every signer slot the message requires must be either ours (we sign) or already pre-signed. */
function otherSignersPresigned(tx: VersionedTransaction, owner: PublicKey): PublicKey[] {
  const msg = tx.message as MessageV0;
  const n = msg.header.numRequiredSignatures;
  const presigned: PublicKey[] = [];
  for (let i = 0; i < n; i++) {
    const key = msg.staticAccountKeys[i]!;
    if (same(key, owner)) continue;
    const sig = tx.signatures[i];
    if (!sig || sig.every((b) => b === 0)) {
      throw refuse(`signer ${key.toBase58()} has not pre-signed`);
    }
    presigned.push(key);
  }
  return presigned;
}

export interface ExpectedPlace {
  owner: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  makingAmount: bigint;
  /** The on-chain `taking_amount`: the limit for a TP, the hidden floor for a stop. */
  takingAmount: bigint;
  /** 0 for a plain limit. */
  triggerTakingAmount: bigint;
  kind: LimitOrderKind;
  expiredAt: number | null;
  /** Native COOK input paid by wrapping (`wrapSol`): the refund is pinned to our wallet. */
  refundNative: boolean;
  /** Native COOK output to be unwrapped (`unwrapSol`): our wallet, not an ATA, is the payout. */
  payoutNative: boolean;
  /** The order address the API reported. */
  order: PublicKey;
}

/**
 * The placement transaction the aggregator built, checked against what we asked for. Throws a
 * `CookieMcpError` (nothing signed) on any mismatch. Returns the decoded `initialize_order` args.
 */
export function assertPlaceTxTrustworthy(tx: VersionedTransaction, exp: ExpectedPlace): void {
  const ixs = decodeMessageIxs(tx);
  const msg = tx.message as MessageV0;
  if (!same(msg.staticAccountKeys[0]!, exp.owner)) throw refuse("fee payer is not our wallet");

  const programIxs = ixs.filter((ix) => same(ix.programId, LIMIT_ORDER_PROGRAM_ID));
  if (programIxs.length !== 1) throw refuse(`${programIxs.length} limit-order instructions`);
  const ix = programIxs[0]!;
  const decoded = ixCoder.decode(ix.data);
  if (!decoded || decoded.name !== "initialize_order") {
    throw refuse(`program instruction ${decoded?.name ?? "unknown"}`);
  }
  // The raw coder keeps the IDL's snake_case names (anchor's Program camel-cases them).
  const a = decoded.data as {
    making_amount: { toString(): string };
    taking_amount: { toString(): string };
    expired_at: { toNumber(): number } | null;
    kind: number;
    refund_native: boolean;
    trigger_taking_amount: { toString(): string };
  };
  if (BigInt(a.making_amount.toString()) !== exp.makingAmount) throw refuse("making amount");
  if (BigInt(a.taking_amount.toString()) !== exp.takingAmount) throw refuse("taking amount");
  if (BigInt(a.trigger_taking_amount.toString()) !== exp.triggerTakingAmount) {
    throw refuse("stop trigger");
  }
  const kind = exp.kind === "stop" ? ORDER_KIND_STOP : ORDER_KIND_LIMIT;
  if (a.kind !== kind) throw refuse("order kind");
  const expiredAt = a.expired_at == null ? null : a.expired_at.toNumber();
  if (expiredAt !== exp.expiredAt) throw refuse("expiry");

  // initialize_order accounts, in IDL order.
  const [base, maker, order, reserve, makerInput, makerOutput, inputMint, outputMint] = ix.keys;
  if (
    !base ||
    !maker ||
    !order ||
    !reserve ||
    !makerInput ||
    !makerOutput ||
    !inputMint ||
    !outputMint
  ) {
    throw refuse("account list too short");
  }
  if (!same(maker, exp.owner)) throw refuse("maker is not our wallet");
  if (!same(inputMint, exp.inputMint) || !same(outputMint, exp.outputMint)) throw refuse("mints");
  const expectedOrder = orderPda(base);
  if (!same(order, expectedOrder) || !same(order, exp.order)) throw refuse("order address");
  if (!same(reserve, reservePda(order))) throw refuse("reserve address");
  // The input leaves OUR token account for the reserve, so `makerInput` is always our ATA for the
  // input mint; with `refund_native` (native input only) the program then pins our wallet as the
  // refund destination instead. `makerOutput` is pinned as given: our ATA for the output mint, or
  // our wallet itself for a native COOK payout.
  const inAta = getAssociatedTokenAddressSync(exp.inputMint, exp.owner, true);
  const outAta = getAssociatedTokenAddressSync(exp.outputMint, exp.owner, true);
  if (!same(makerInput, inAta)) throw refuse("input account is not our token account");
  if (!same(makerOutput, exp.payoutNative ? exp.owner : outAta)) throw refuse("payout account");
  if (a.refund_native !== exp.refundNative) throw refuse("refund flag");

  const presigned = otherSignersPresigned(tx, exp.owner);
  if (presigned.length !== 1 || !same(presigned[0]!, base)) throw refuse("unexpected extra signer");
  assertHousekeepingIxs(ixs, exp.owner, []);
}

/** The cancel transaction, checked the same way: our order, refund to us, nothing else. */
export function assertCancelTxTrustworthy(
  tx: VersionedTransaction,
  exp: { owner: PublicKey; order: PublicKey },
): void {
  const ixs = decodeMessageIxs(tx);
  const msg = tx.message as MessageV0;
  if (!same(msg.staticAccountKeys[0]!, exp.owner)) throw refuse("fee payer is not our wallet");

  const programIxs = ixs.filter((ix) => same(ix.programId, LIMIT_ORDER_PROGRAM_ID));
  if (programIxs.length !== 1) throw refuse(`${programIxs.length} limit-order instructions`);
  const ix = programIxs[0]!;
  const decoded = ixCoder.decode(ix.data);
  if (!decoded || decoded.name !== "cancel_order") {
    throw refuse(`program instruction ${decoded?.name ?? "unknown"}`);
  }
  // cancel_order accounts: [order, maker, reserve, makerInputAccount, inputMint, tokenProgram].
  const [order, maker, reserve] = ix.keys;
  if (!order || !maker || !reserve) throw refuse("account list too short");
  if (!same(order, exp.order)) throw refuse("order address");
  if (!same(maker, exp.owner)) throw refuse("maker is not our wallet");
  if (!same(reserve, reservePda(order))) throw refuse("reserve address");

  // A partial unwrap co-signs with a throwaway native account the API pre-signed for us.
  const temps = otherSignersPresigned(tx, exp.owner);
  assertHousekeepingIxs(ixs, exp.owner, temps);
}

// --- Aggregator API types -----------------------------------------------------------------------

export interface LimitOrderFees {
  makerFeeBps: number;
  makerStableFeeBps: number;
  takerFeeBps: number;
  takerStableFeeBps: number;
}

export interface AggLimitOrder {
  order: string;
  maker: string;
  inputMint: string;
  outputMint: string;
  makingAmount: string;
  takingAmount: string;
  netTakingAmount: string;
  makerFeeBps: number;
  oriMakingAmount: string;
  oriTakingAmount: string;
  filledPct: number;
  price: number | null;
  kind: LimitOrderKind;
  triggerTakingAmount: string | null;
  floorPrice: number | null;
  expiredAt: number | null;
  createdAt: number;
  payoutNative: boolean;
  refundNative: boolean;
  waiting: boolean;
}

interface AggPlaceTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  order: string;
  reserve: string;
  makingAmount: string;
  takingAmount: string;
  netTakingAmount: string;
  makerFeeBps: number;
  triggerTakingAmount: string | null;
  expiredAt: number | null;
  kind: LimitOrderKind;
  payoutNative: boolean;
  refundNative: boolean;
  wrappedLamports: string;
}

interface AggCancelTx {
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  order: string;
  refundAmount: string;
  unwrappedLamports: string;
}

/** Re-hint the aggregator's own failures so an agent knows whether to retry, fix inputs, or stop. */
function apiError(e: unknown, action: string): CookieMcpError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/disabled/i.test(msg)) {
    return new CookieMcpError(
      "limit orders are switched off on the Cookiebox aggregator right now",
      "nothing was sent; try again later — the program and your existing orders are unaffected",
    );
  }
  if (/AccountNotInitialized|3012/.test(msg)) {
    return new CookieMcpError(
      `${action} failed: the wallet has no token account for the input mint`,
      "you hold none of the input token — check get_balance and the mint address",
    );
  }
  if (/AccountNotFound/.test(msg)) {
    return new CookieMcpError(
      `${action} failed: the wallet has no COOK on chain`,
      "the fee payer account does not exist yet — fund the wallet with COOK first (see get_wallet)",
    );
  }
  if (/insufficient|0x1\b/i.test(msg)) {
    return new CookieMcpError(
      `${action} failed: insufficient funds`,
      "check the wallet holds the full input amount plus a little COOK for fees and rent",
    );
  }
  if (/not found/i.test(msg) && /order/i.test(msg)) {
    return new CookieMcpError(
      "order not found — already filled, cancelled or expired",
      "run get_limit_orders to see what is still open",
    );
  }
  if (/not the maker/i.test(msg)) {
    return new CookieMcpError(
      "this order belongs to another wallet",
      "only the maker can cancel; check get_wallet and get_limit_orders",
    );
  }
  return e instanceof CookieMcpError ? e : new CookieMcpError(`${action} failed: ${msg}`);
}

// --- Reads ----------------------------------------------------------------------------------------

/** Live fee schedule, or null when the aggregator build in production predates the route. */
export async function fetchLimitOrderFees(): Promise<LimitOrderFees | null> {
  try {
    return await fetchJson<LimitOrderFees>(`${COOKIEBOX_AGG_API_URL}/limit-orders/fees`);
  } catch {
    return null;
  }
}

export interface LimitOrderView {
  order: string;
  kind: LimitOrderKind;
  /** `open`, `filling` (a keeper fill is mid-flight), or `expired` (cancel to get the input back). */
  status: "open" | "filling" | "expired";
  input: { mint: string; symbol: string | null; remaining: string; original: string };
  output: {
    mint: string;
    symbol: string | null;
    /** Gross output the program enforces for the remaining input (a stop: its hidden floor). */
    minReceive: string;
    /** What actually lands in the wallet after the maker fee. */
    netAfterFee: string;
  };
  /** Output per input, human units. For a stop this is the TRIGGER. Display only. */
  price: number | null;
  /** Stop only: the program-enforced floor as a price — a safety net, not what the maker gets. */
  floorPrice: number | null;
  filledPct: number;
  makerFeeBps: number;
  expiresAt: string | null;
  createdAt: string;
  /** A fill pays native COOK to the wallet rather than wCOOK to a token account. */
  payoutNative: boolean;
  /** A cancel/expiry refunds native COOK to the wallet; nothing to unwrap. */
  refundNative: boolean;
}

/** Pure — tested. */
export function formatLimitOrder(
  o: AggLimitOrder,
  input: TokenMeta,
  output: TokenMeta,
  now = Math.floor(Date.now() / 1000),
): LimitOrderView {
  const expired = o.expiredAt != null && o.expiredAt <= now;
  return {
    order: o.order,
    kind: o.kind,
    status: o.waiting ? "filling" : expired ? "expired" : "open",
    input: {
      mint: o.inputMint,
      symbol: input.sym,
      remaining: rawToUi(o.makingAmount, input.dec),
      original: rawToUi(o.oriMakingAmount, input.dec),
    },
    output: {
      mint: o.outputMint,
      symbol: output.sym,
      minReceive: rawToUi(o.takingAmount, output.dec),
      netAfterFee: rawToUi(o.netTakingAmount, output.dec),
    },
    price: o.price,
    floorPrice: o.kind === "stop" ? o.floorPrice : null,
    filledPct: o.filledPct,
    makerFeeBps: o.makerFeeBps,
    expiresAt: o.expiredAt == null ? null : new Date(o.expiredAt * 1000).toISOString(),
    createdAt: new Date(o.createdAt * 1000).toISOString(),
    payoutNative: o.payoutNative,
    refundNative: o.refundNative,
  };
}

export async function getLimitOrders(args: { owner?: string }): Promise<{
  owner: string;
  ownerName?: string;
  fees: LimitOrderFees | null;
  count: number;
  orders: LimitOrderView[];
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
        "pass `owner` (address or .cook name), or set COOKIE_PRIVATE_KEY to list your own orders",
      );
    }
    owner = own;
  }
  const [{ orders }, fees] = await Promise.all([
    fetchJson<{ maker: string; orders: AggLimitOrder[] }>(
      `${COOKIEBOX_AGG_API_URL}/limit-orders?maker=${owner}`,
    ).catch((e) => {
      throw apiError(e, "listing orders");
    }),
    fetchLimitOrderFees(),
  ]);
  const views = await Promise.all(
    orders.map(async (o) => {
      const { input, output } = await resolveMeta(o.inputMint, o.outputMint);
      return formatLimitOrder(o, input, output);
    }),
  );
  return {
    owner,
    ...(ownerName ? { ownerName } : {}),
    fees,
    count: views.length,
    orders: views,
  };
}

// --- Writes ---------------------------------------------------------------------------------------

async function simulateSignSendConfirm(
  tx: VersionedTransaction,
  signer: TxSigner,
  built: { blockhash: string; lastValidBlockHeight: number },
  what: string,
  summary?: Record<string, unknown>,
): Promise<{ signature: string; confirmed: boolean }> {
  const conn = getConnection();
  const sim = await conn.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "confirmed",
  });
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    throw apiError(
      new Error(`${JSON.stringify(sim.value.err)} ${logs.slice(-4).join(" | ")}`),
      `${what} simulation`,
    );
  }
  await signer.signTransaction(tx, {
    what,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
    ...(summary ? { summary } : {}),
  });
  const signature = await conn.sendRawTransaction(Buffer.from(tx.serialize()));
  try {
    const conf = await conn.confirmTransaction({ signature, ...built }, "confirmed");
    if (conf.value.err) {
      throw new CookieMcpError(
        `the ${what} landed but failed on-chain: ${JSON.stringify(conf.value.err)}`,
        `nothing moved (only the tx fee was spent) — see ${explorerTxUrl(signature)}`,
      );
    }
    return { signature, confirmed: true };
  } catch (e) {
    if (e instanceof CookieMcpError) throw e;
    throw unconfirmedError(what, signature, {
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

export interface PlaceLimitOrderResult {
  signature: string;
  explorerUrl: string;
  order: string;
  kind: LimitOrderKind;
  input: { mint: string; symbol: string | null; amount: string };
  output: {
    mint: string;
    symbol: string | null;
    /** TP: the gross output the order demands. Stop: the estimate at the trigger. */
    atPrice: string;
    /** After the maker fee. For a stop this is the estimate at the trigger, not a guarantee. */
    netAfterFee: string;
  };
  /** Output per input, as placed. For a stop this is the trigger. */
  price: string;
  /** Stop only: the program-enforced floor as a price (what a compromised keeper could pay at worst). */
  floorPrice?: number | null;
  makerFeeBps: number;
  /** The router's executable rate at placement, and how far the order sits from it. */
  market: { rate: number; pctFromMarket: number | null } | null;
  expiresAt: string | null;
  payoutNative: boolean;
  refundNative: boolean;
  /** Native COOK wrapped into wCOOK inside the placement, in COOK. */
  wrappedCook: string;
  note: string;
}

export async function placeLimitOrder(args: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  price: string | number;
  kind?: LimitOrderKind;
  expiresInSeconds?: number;
  floorPrice?: string | number;
  wrapSol?: boolean;
  unwrapSol?: boolean;
  skipMarketCheck?: boolean;
}): Promise<PlaceLimitOrderResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const kind: LimitOrderKind = args.kind ?? "limit";
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
  if (args.floorPrice !== undefined && kind !== "stop") {
    throw new CookieMcpError('floorPrice only applies to kind "stop"', "omit it for a limit order");
  }

  const { input, output } = await resolveMeta(args.inputMint, args.outputMint);
  let makingAmount: bigint;
  try {
    makingAmount = uiToRaw(args.amount, input.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is a UI amount of the input token (max ${input.dec} decimals)`,
    );
  }
  if (makingAmount <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive input amount");
  }
  const price = normalizePrice(args.price);
  const priced = takingAmountForPrice(makingAmount, price, input.dec, output.dec);
  if (!priced) {
    throw new CookieMcpError(
      "price rounds to zero output for this amount",
      "raise the price or the amount",
    );
  }
  const floorPrice = args.floorPrice === undefined ? null : normalizePrice(args.floorPrice);
  const expiredAt = expiryFromSeconds(args.expiresInSeconds);

  // The keeper fills through the aggregator's router, so its executable quote is the only market
  // rate that means anything here — a mid price would misplace the order by the pool fee + impact.
  let market: PlaceLimitOrderResult["market"] = null;
  if (!args.skipMarketCheck) {
    let route;
    try {
      route = await quoteAgg(
        args.inputMint,
        args.outputMint,
        makingAmount.toString(),
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
        "no route exists between these tokens right now, so the keeper could not fill this order",
        "check the mints with search_tokens; pass skipMarketCheck: true to place it anyway (it rests until a route appears)",
      );
    }
    const marketOut = BigInt(route.grossOutAmount ?? route.totalOutAmount);
    const rate = priceFromAmounts(makingAmount, marketOut, input.dec, output.dec);
    const limitRate = priceFromAmounts(makingAmount, priced, input.dec, output.dec);
    market = {
      rate: rate ?? NaN,
      pctFromMarket: rate != null && limitRate != null ? pctFromMarket(limitRate, rate) : null,
    };
    if (fillsImmediately(kind, priced, marketOut)) {
      const marketStr = rawToUi(marketOut, output.dec);
      throw new CookieMcpError(
        kind === "stop"
          ? `the market already pays ${marketStr} ${output.sym ?? "output"} for this amount — at or below the stop trigger, so it would sell at market immediately`
          : `the market already pays ${marketStr} ${output.sym ?? "output"} for this amount — at or above this limit, so it would fill immediately at a worse rate than a swap`,
        kind === "stop"
          ? "a stop trigger must sit BELOW the current rate; use trade to sell now, or lower the trigger. Pass skipMarketCheck: true to place it anyway"
          : "a limit must sit ABOVE the current rate; use trade to swap now, or raise the price. Pass skipMarketCheck: true to place it anyway",
      );
    }
  }

  let built: AggPlaceTx;
  try {
    built = await fetchJson<AggPlaceTx>(`${COOKIEBOX_AGG_API_URL}/limit-orders/place-tx`, {
      method: "POST",
      body: JSON.stringify({
        owner: owner.toBase58(),
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        makingAmount: makingAmount.toString(),
        price,
        kind,
        ...(expiredAt == null ? {} : { expiredAt }),
        ...(floorPrice == null ? {} : { floorPrice }),
        ...(args.wrapSol === undefined ? {} : { wrapSol: args.wrapSol }),
        ...(args.unwrapSol === undefined ? {} : { unwrapSol: args.unwrapSol }),
      }),
      timeoutMs: BUILD_TX_TIMEOUT_MS,
    });
  } catch (e) {
    throw apiError(e, "placing the order");
  }

  // Verify the build against OUR numbers — not the API's echo — before anything is signed.
  const takingAmount = BigInt(built.takingAmount);
  const triggerTakingAmount = BigInt(built.triggerTakingAmount ?? "0");
  if (kind === "stop") {
    if (triggerTakingAmount !== priced) throw refuse("stop trigger differs from the price given");
    const expectedFloor =
      floorPrice == null
        ? null
        : takingAmountForPrice(makingAmount, floorPrice, input.dec, output.dec);
    if (expectedFloor != null && takingAmount !== expectedFloor) throw refuse("stop floor");
    if (takingAmount > priced) throw refuse("stop floor above its trigger");
  } else if (takingAmount !== priced || triggerTakingAmount !== 0n) {
    throw refuse("taking amount differs from the price given");
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  const order = new PublicKey(built.order);
  // What we asked for, not what the API echoed (older agg builds echo neither flag): wrapping
  // native COOK ⇒ the refund is pinned to our wallet; unwrapping a COOK output ⇒ so is the payout.
  const refundNative = (args.wrapSol ?? true) && args.inputMint === COOK_MINT;
  const payoutNative = (args.unwrapSol ?? true) && args.outputMint === COOK_MINT;
  assertPlaceTxTrustworthy(tx, {
    owner,
    inputMint,
    outputMint,
    makingAmount,
    takingAmount,
    triggerTakingAmount,
    kind,
    expiredAt,
    refundNative,
    payoutNative,
    order,
  });

  const { signature } = await simulateSignSendConfirm(tx, signer, built, "limit-order placement", {
    kind,
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: String(args.amount),
    order,
  });

  const feeBps = built.makerFeeBps;
  const shown = kind === "stop" ? triggerTakingAmount : takingAmount;
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: built.order,
    kind,
    input: { mint: args.inputMint, symbol: input.sym, amount: rawToUi(makingAmount, input.dec) },
    output: {
      mint: args.outputMint,
      symbol: output.sym,
      atPrice: rawToUi(shown, output.dec),
      netAfterFee: rawToUi(makerNetOut(shown, feeBps), output.dec),
    },
    price,
    ...(kind === "stop"
      ? { floorPrice: priceFromAmounts(makingAmount, takingAmount, input.dec, output.dec) }
      : {}),
    makerFeeBps: feeBps,
    market,
    expiresAt: expiredAt == null ? null : new Date(expiredAt * 1000).toISOString(),
    payoutNative,
    refundNative,
    wrappedCook: rawToUi(built.wrappedLamports ?? "0", 9),
    note:
      kind === "stop"
        ? "stop-market: once the router's rate falls to the trigger the keeper sells at market and passes the proceeds through (minus the maker fee); the floor is only the program's guarantee against a rogue keeper. Cancel any time with cancel_limit_order."
        : "the keeper fills once the router's rate reaches the price (partial fills possible); the wallet receives the limit minus the maker fee. Cancel any time with cancel_limit_order; an expired order must also be cancelled to get the input back.",
  };
}

export interface CancelLimitOrderResult {
  signature: string;
  explorerUrl: string;
  order: string;
  refund: { mint: string; symbol: string | null; amount: string };
  /** COOK unwrapped back to the wallet inside the cancel (a wCOOK-refund order). */
  unwrappedCook: string;
}

export async function cancelLimitOrder(args: {
  order: string;
  unwrapSol?: boolean;
}): Promise<CancelLimitOrderResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  let order: PublicKey;
  try {
    order = new PublicKey(args.order);
  } catch {
    throw new CookieMcpError("invalid order address", "pass the `order` from get_limit_orders");
  }

  // Look the order up first so the result can name what came back (and so a stranger's order
  // fails with a sentence, not a 403).
  const { orders } = await fetchJson<{ orders: AggLimitOrder[] }>(
    `${COOKIEBOX_AGG_API_URL}/limit-orders?maker=${owner.toBase58()}`,
  ).catch((e) => {
    throw apiError(e, "looking the order up");
  });
  const mine = orders.find((o) => o.order === args.order);
  if (!mine) {
    throw new CookieMcpError(
      "no open order with that address belongs to this wallet",
      "it may be filled, cancelled or another wallet's — run get_limit_orders",
    );
  }

  let built: AggCancelTx;
  try {
    built = await fetchJson<AggCancelTx>(`${COOKIEBOX_AGG_API_URL}/limit-orders/cancel-tx`, {
      method: "POST",
      body: JSON.stringify({
        owner: owner.toBase58(),
        order: args.order,
        ...(args.unwrapSol === undefined ? {} : { unwrapSol: args.unwrapSol }),
      }),
      timeoutMs: BUILD_TX_TIMEOUT_MS,
    });
  } catch (e) {
    throw apiError(e, "cancelling the order");
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  assertCancelTxTrustworthy(tx, { owner, order });

  const { signature } = await simulateSignSendConfirm(tx, signer, built, "limit-order cancel", {
    order,
  });
  const { input } = await resolveMeta(mine.inputMint, mine.outputMint);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    order: args.order,
    refund: {
      mint: mine.inputMint,
      symbol: input.sym,
      amount: rawToUi(built.refundAmount ?? mine.makingAmount, input.dec),
    },
    unwrappedCook: rawToUi(built.unwrappedLamports ?? "0", 9),
  };
}
