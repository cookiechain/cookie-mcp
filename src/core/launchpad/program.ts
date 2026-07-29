// Which `cookie_launchpad` deployment we are talking to is a RUNTIME fact, not a constant.
//
// The launchpad has already been redeployed under a new program id once (`7tLQV8D6…` → `momoL7wu…`,
// 2026-07-25) and the old pools stay behind on the old id forever, so both things we derive locally are
// program-scoped: the **PDA seeds** (`UserPosition`, `creator_fee_vault`) and the **anchor error codes**.
//
// A hardcoded program id fails in the worst possible way — the PDAs simply do not exist, so
// `get_launchpad_positions` returns an empty portfolio with no error at all. So we read the id off the
// chain instead: a pool account's `owner` IS, by definition, the program that owns it. The configured
// `PROGRAM_IDS.momoswapLaunchpad` is only the fallback for when we have nothing to read.
import { PublicKey, type Transaction } from "@solana/web3.js";

import { PROGRAM_IDS } from "../config";

/**
 * The pre-audit deployment. Kept by name because its anchor error enum predates `SlippageExceeded`,
 * which shifts every code from 6019 up (see `launchpadErrorMessage`). Any *other* deployment is a
 * post-audit build — the program only moves forward, so unknown ids are treated as current.
 */
export const LAUNCHPAD_PROGRAM_PRE_SLIPPAGE = "7tLQV8D6uUyG9r1nEtQuBMqDb5Nfi9TXxsdVZUtsct2M";

/** The current canonical deployment (`declare_id!` in the launchpad repo). Documentation only. */
export const LAUNCHPAD_PROGRAM_CURRENT = "momoL7wu4TrXjnXMLCLzGsbx8Pm7XGgoYo7FVqDoqcw";

/** Fallback when nothing on-chain is available to read the id from. */
export const CONFIGURED_LAUNCHPAD_PROGRAM_ID = new PublicKey(PROGRAM_IDS.momoswapLaunchpad);

/**
 * Programs that legitimately appear alongside the launchpad in an API-built transaction (the builder
 * adds wCOOK wrap/unwrap, idempotent ATAs, the metadata write and a CU budget). Anything left after
 * removing these is the launchpad itself.
 */
const AMBIENT_PROGRAM_IDS = new Set([
  "11111111111111111111111111111111", // System
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // Metaplex Token Metadata
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo
]);

/**
 * The launchpad program a built transaction actually targets, or null when it can't be told apart.
 * Used for error translation: the codes belong to whichever build the API chose, and the transaction
 * in hand is the exact evidence — no RPC call needed. Returns null rather than guessing when more than
 * one non-ambient program is present, so the caller falls back instead of mistranslating.
 */
export function launchpadProgramIdFromTx(tx: Transaction): string | null {
  const candidates = new Set<string>();
  for (const ix of tx.instructions) {
    const id = ix.programId.toBase58();
    if (!AMBIENT_PROGRAM_IDS.has(id)) candidates.add(id);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

/**
 * Agent-actionable program errors. **One table for every deployment** — the launchpad's error codes are
 * stable across builds because the audit fix appended `SlippageExceeded` to the END of the enum rather
 * than inserting it (`lib.rs`: *"Appended at the end to keep existing error codes stable (audit: only
 * ever append variants)"*), so nothing was ever renumbered.
 *
 * ⚠️ **The launchpad's committed IDL disagrees with its own Rust source and is wrong.** `idl/
 * cookie_launchpad.json` lists `SlippageExceeded` at **6019** and shifts all 27 codes after it
 * (`InsufficientPoolTokens` → 6020, …, `InvalidSessionKey` → 6046), while the source has it at 6046 with
 * 6000–6045 untouched. Anchor codes are the compiled enum discriminants, so **the source wins** and the
 * IDL is stale metadata. MCP previously trusted the IDL and applied a `+1` shift for post-audit builds,
 * which mistranslated every code ≥ 6019 (e.g. reporting "no sale tokens left" as "slippage exceeded").
 * *Lesson: verify an anchor error map against the `#[error_code]` enum in source, never against a
 * checked-in IDL — the IDL can be regenerated wrong and nothing fails loudly when it is.*
 */
const LAUNCHPAD_ERRORS: Record<number, string> = {
  6000: "the launchpad is paused",
  6011: "the pool is not in a tradeable state (it has graduated or expired)",
  6012: "trading has not opened yet for this launch",
  6013: "the launch has ended — the pool is expired",
  6015: "the amount is below the pool's minimum buy",
  6016: "this buy would exceed the pool's per-wallet cap",
  6017: "this buy would exceed the pool's raise cap",
  6019: "the pool has no sale tokens left at this size",
  6020: "you have no bonding-curve position on this pool",
  6021: "you are trying to sell more shares than you hold",
  6022: "the pool's payment vault cannot cover this sell",
  6025: "there is nothing to claim",
  6026: "this has already been claimed",
  6035: "self-referral is not allowed",
  6040: "the anti-snipe window caps how much one wallet can buy right after launch",
  // Appended by the min-out audit fix, so it only exists on post-audit builds. Harmless to keep in the
  // shared table: a pre-audit build can never emit 6046.
  6046: "the trade would return less than the minimum you asked for (slippage) — the curve moved",
};

/**
 * Translate an anchor error code, or undefined when the code isn't one we explain (the caller then
 * shows the raw log tail, which beats a confident wrong answer).
 *
 * `programId` is accepted and ignored: it was used to pick between two numberings, but there is only
 * one — see `LAUNCHPAD_ERRORS`. Kept in the signature because callers derive it from the transaction
 * anyway and a future build that genuinely renumbers would need it back.
 */
export function launchpadErrorMessage(
  code: number,
  _programId?: string | null,
): string | undefined {
  return LAUNCHPAD_ERRORS[code];
}
