// MomoSwap launchpad (momoswap.fun) — launch a token on a bonding curve, trade the curve, and claim
// payouts. Non-custodial: the launchpad API builds and partial-signs each transaction (it leases the
// pre-ground `momo` mint the program requires, pins metadata to IPFS, and wraps/unwraps COOK), then
// we simulate it on our RPC, add the wallet signature locally and send + confirm.
//
// ⚠️ Pre-graduation, a holder's tokens are program-tracked **curve shares**, not SPL tokens — they do
// NOT show up in `get_balance` and cannot be swapped with `trade`. Selling back to the curve
// (launchpad_sell) is the only exit until the pool graduates; after graduation the holder claims the
// real SPL token (claim_launchpad) and trades it normally.
import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

import {
  COOK_DECIMALS,
  COOK_MINT,
  COOK_SYMBOL,
  COOKIE_REFERRER,
  explorerTxUrl,
  LAUNCHPAD_ALT_ADDRESS,
  LAUNCHPAD_ALT_KEYS,
  launchpadPoolUrl,
  launchpadTokenUrl,
  PROGRAM_IDS,
} from "../config";
import { confirmSent } from "../confirm";
import { resolveWallet } from "../domains";
import { CookieMcpError } from "../errors";
import { rawToUi, uiToRaw } from "../format";
import { fetchRemoteImage } from "../imageFetch";
import { readImageFile } from "../imageFile";
import { getConnection } from "../rpc";
import { ownPublicKey, requireSigner } from "../wallet";
import type { TxSigner } from "../signer";
import { withProvidedSignatures, type ProvidedSignature } from "../context";
import {
  buildBuyTx,
  buildClaimCreatorFeesTx,
  buildClaimTx,
  buildCreatePoolTx,
  buildSellTx,
  fetchLaunchpadConfig,
  fetchPendingCreatorFees,
  fetchPoolByAddress,
  fetchPoolByMint,
  fetchPools,
  fetchPosition,
  fetchWinnerProof,
  uploadImage,
  type BuiltTx,
  type ClaimKind,
  type CreatePoolParams,
  type ExpiryMode,
  type LaunchpadConfig,
  type LaunchpadMetadata,
  type LaunchpadPool,
  type LaunchpadPosition,
  type PoolStatus,
} from "./api";
import {
  estimateBuy,
  estimateSell,
  graduationProgressPct,
  paymentForTokens,
  spotPriceCook,
  type CurveState,
} from "./curve";
import { poolFeeShareBps, poolTradeFeeBps } from "./fees";
import {
  decodeTokenAmount,
  fetchCreatorFeeVaults,
  fetchPoolPrograms,
  fetchPositionsForPools,
} from "./positions";
import { launchpadErrorMessage, launchpadProgramIdFromTx } from "./program";
import { launchpadSessionToken, resetLaunchpadSession } from "./session";

const MIN_DURATION_SECS = 60;
const MAX_DURATION_SECS = 604_800; // 7 days, enforced on-chain
const DEFAULT_DURATION_SECS = 86_400;
const MAX_NAME_LEN = 32;
const MAX_SYMBOL_LEN = 10;

function programErrorCode(blob: string): number | null {
  const m =
    blob.match(/"Custom"\s*:\s*(\d+)/) ?? blob.match(/custom program error: 0x([0-9a-f]+)/i);
  if (!m) return null;
  const raw = m[1]!;
  return /^0x/i.test(m[0]) || m[0].includes("0x") ? parseInt(raw, 16) : parseInt(raw, 10);
}

/**
 * Turn a failed simulation into an actionable error, translating known program error codes. `programId`
 * is which launchpad deployment produced them — the codes are enum ordinals, so the same number means
 * different things in different builds (see `program.ts`).
 */
/**
 * Anchor's own framework errors (the 2000–3999 constraint/account range) as Anchor itself prints them.
 *
 * Deliberately NOT a hardcoded number → name table. `program.ts` records the lesson the hard way — an
 * error map guessed from anything but the compiled enum mistranslates codes silently — and the
 * framework range is exactly where that risk is worst, because we do not compile Anchor ourselves.
 * Anchor already emits the name, the number AND the message into the logs, so read them from there and
 * the translation cannot be wrong.
 */
export interface AnchorLogError {
  /** The account the constraint was attached to, when Anchor names one (`caused by account: pool`). */
  account?: string;
  /** e.g. `ConstraintSeeds` */
  code: string;
  /** e.g. 2006 */
  number: number;
  /** e.g. `A seeds constraint was violated.` */
  message?: string;
  /** For seeds/address constraints Anchor prints the two values it compared. */
  left?: string;
  right?: string;
}

/** Strip the `Program log: ` / `Program data: ` framing so a log line reads as a sentence. */
function bareLog(line: string): string {
  return line.replace(/^Program (?:log|data): /, "").trim();
}

/**
 * Parse an `AnchorError` out of simulation logs.
 *
 * Anchor prints it as one line — `AnchorError caused by account: pool. Error Code: ConstraintSeeds.
 * Error Number: 2006. Error Message: A seeds constraint was violated.` — optionally followed by
 * `Left:` / `Right:` lines each carrying the compared value on the NEXT line. The account-less form
 * (`AnchorError occurred. Error Code: …`) is also emitted, hence the optional account.
 */
export function anchorLogError(logs: string[] | null): AnchorLogError | null {
  if (!logs?.length) return null;
  const lines = logs.map(bareLog);
  const i = lines.findIndex((l) => l.startsWith("AnchorError"));
  if (i < 0) return null;
  const head = lines[i]!;
  const number = Number(head.match(/Error Number: (\d+)/)?.[1]);
  const code = head.match(/Error Code: ([A-Za-z0-9_]+)/)?.[1];
  if (!code || !Number.isFinite(number)) return null;
  const out: AnchorLogError = {
    code,
    number,
    account: head.match(/caused by account: ([A-Za-z0-9_]+)/)?.[1],
    message: head.match(/Error Message: (.+?)\.?$/)?.[1],
  };
  // `Left:` and `Right:` are labels; the value is on the line after each.
  for (let j = i + 1; j < lines.length; j++) {
    if (/^Left:$/.test(lines[j]!)) out.left = lines[j + 1];
    else if (/^Right:$/.test(lines[j]!)) out.right = lines[j + 1];
  }
  return out;
}

/** One-line rendering of an AnchorError, including the compared values when it has them. */
export function anchorLogSummary(e: AnchorLogError): string {
  const parts = [`${e.code} (${e.number})`];
  if (e.account) parts.push(`on the \`${e.account}\` account`);
  if (e.message) parts.push(`— ${e.message}`);
  if (e.left && e.right) parts.push(`(passed ${e.left}, program expected ${e.right})`);
  return parts.join(" ");
}

/**
 * Pick the lines from a failed simulation that actually say WHY, instead of blindly tailing.
 *
 * `logs.slice(-3)` looks reasonable and is actively misleading: for a constraint violation Anchor's
 * last three lines are `Right:`, a bare pubkey, and `Program … failed: custom program error: 0x…`, so
 * the `AnchorError` line naming the account and the error is cut off, and what surfaces is a pubkey
 * that changes every build and reads as noise. That is what turned momoswap-backend#113 into a
 * brute-force seed hunt (each rebuild leasing a rate-limited vanity mint) rather than a one-run
 * diagnosis. So: start the window at the first line that explains something and keep going.
 */
export function diagnosticLogTail(logs: string[] | null, max = 6): string | undefined {
  if (!logs?.length) return undefined;
  const lines = logs.map(bareLog).filter((l) => l.length > 0);
  const start = lines.findIndex((l) => /^AnchorError|panicked|^Error Code:/.test(l));
  const window = start >= 0 ? lines.slice(start, start + max) : lines.slice(-Math.min(max, 3));
  return window.join(" | ") || undefined;
}

/**
 * A caller-supplied reading of one program error code, for a case where the generic table's wording is
 * wrong in this specific context. Only the codes present here are overridden.
 */
export interface SimCodeHint {
  message: string;
  hint: string;
}

export function launchpadSimError(
  what: string,
  err: unknown,
  logs: string[] | null,
  programId?: string | null,
  codeHints?: Record<number, SimCodeHint>,
): CookieMcpError {
  const blob = `${JSON.stringify(err)} ${logs?.join(" ") ?? ""}`;
  const code = programErrorCode(blob);
  const override = code != null ? codeHints?.[code] : undefined;
  if (override) return new CookieMcpError(override.message, override.hint);
  const known = code != null ? launchpadErrorMessage(code, programId) : undefined;
  if (known) {
    return new CookieMcpError(`${what} would fail: ${known}`, "nothing was sent");
  }
  const anchor = anchorLogError(logs);
  if (anchor) {
    return new CookieMcpError(
      `${what} would fail: ${anchorLogSummary(anchor)}`,
      anchor.account
        ? `the program rejected the \`${anchor.account}\` account it was handed — the launchpad API is ` +
            "building against a different deployment than the one on chain; nothing was sent"
        : "nothing was sent",
    );
  }
  if (/BlockhashNotFound|blockhash/i.test(blob)) {
    return new CookieMcpError(
      `${what} simulation failed: blockhash not found`,
      "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
    );
  }
  if (/insufficient|0x1\b/i.test(blob)) {
    return new CookieMcpError(
      `${what} simulation failed: insufficient funds`,
      "check the wallet's COOK balance (it also pays rent for new accounts and the network fee)",
    );
  }
  const tail = diagnosticLogTail(logs);
  return new CookieMcpError(
    `${what} simulation failed${tail ? `: ${tail}` : ""}`,
    "the pool state may have changed; re-read it and retry — nothing was sent",
  );
}

/**
 * The API's blockhash has to be alive on the node WE send to. It usually is — but the launchpad
 * builds against its own RPC, so a lagging node upstream yields a blockhash that expired before we
 * ever saw it. Fail loudly here rather than at preflight, because at this point nothing is signed and
 * nothing is sent. A read error is not treated as a failure: never block a good send on a flaky probe.
 */
async function assertBlockhashUsable(
  conn: Connection,
  built: BuiltTx,
  what: string,
): Promise<void> {
  let valid: boolean;
  try {
    valid = (await conn.isBlockhashValid(built.blockhash, { commitment: "confirmed" })).value;
  } catch {
    return;
  }
  if (valid) return;
  throw new CookieMcpError(
    `the launchpad built this ${what} transaction against a stale blockhash, so it cannot be sent`,
    "the launchpad API's RPC node is lagging behind the chain — nothing was sent and no funds moved; " +
      "retry in a few minutes, and if it persists the launchpad API needs to be pointed at a synced node",
  );
}

/** Translate a send-time failure so a raw web3 error never reaches the agent untranslated. */
export function sendFailure(what: string, e: unknown): CookieMcpError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Blockhash not found|block height exceeded|Node is behind/i.test(msg)) {
    return new CookieMcpError(
      `the ${what} transaction expired before it could be sent`,
      "the blockhash the launchpad built with is no longer valid on this RPC — nothing was sent; " +
        "retry, and if it persists the launchpad API's node is out of sync with the chain",
    );
  }
  if (/insufficient lamports|insufficient funds/i.test(msg)) {
    return new CookieMcpError(
      `insufficient funds to send the ${what}`,
      "top up native COOK for rent and fees — nothing was sent",
    );
  }
  return new CookieMcpError(
    `the ${what} transaction could not be sent: ${msg}`,
    "nothing was sent",
  );
}

/**
 * Check a v0 build's lookup tables against our own pinned address.
 *
 * The response's `lookupTables` is the API telling us how to interpret the transaction it just built,
 * so it cannot be the thing we trust — the accounts an index resolves to are exactly what needs
 * pinning. Returns null when the build is acceptable, or the reason to refuse. Exported for tests
 * because this is the whole security argument for consuming a table at all.
 */
export function altPinMismatch(tables: string[] | undefined, pinned: string): string | null {
  if (!pinned) {
    return (
      "this launch needs a versioned transaction that resolves accounts through the launchpad's " +
      "address lookup table, but no table address is pinned in this build of cookie-mcp, so what those " +
      "accounts resolve to cannot be verified"
    );
  }
  const list = tables ?? [];
  if (list.length === 0) return null; // no table referenced ⇒ nothing to resolve, nothing to pin
  const unexpected = list.filter((t) => t !== pinned);
  if (unexpected.length > 0) {
    return (
      `the launchpad built this transaction against an unexpected address lookup table ` +
      `(${unexpected.join(", ")}); the pinned table is ${pinned}`
    );
  }
  return null;
}

/**
 * Top the creator's wCOOK ATA up to `needRaw`, as a SEPARATE transaction before the launch.
 *
 * The launch bundle creates that ATA (idempotently) but never funds it — the backend's builder says so
 * outright: the dev-buy leg spends from the creator's wCOOK account, "pre-funded by the client's wrap
 * step". There is no room to do it in the same transaction; fitting create + buy at all is what the
 * lookup table exists for. So a dev buy with an empty wCOOK balance simulates as a failed transfer,
 * after the API has already pinned metadata and leased a rate-limited vanity mint.
 *
 * Only ever tops up the shortfall, and only when a dev buy was asked for. Returns the signature when it
 * sent one, or null when the balance already covered it.
 */
async function ensureWrappedCook(
  conn: Connection,
  signer: TxSigner,
  needRaw: bigint,
): Promise<string | null> {
  const owner = signer.publicKey;
  const ata = getAssociatedTokenAddressSync(new PublicKey(COOK_MINT), owner, true);
  let haveRaw = 0n;
  try {
    const bal = await conn.getTokenAccountBalance(ata, "confirmed");
    haveRaw = BigInt(bal.value.amount);
  } catch {
    // No account yet — the idempotent create below covers it, and the shortfall is the full amount.
  }
  if (haveRaw >= needRaw) return null;
  const shortfall = needRaw - haveRaw;

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, new PublicKey(COOK_MINT)),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: shortfall }),
    createSyncNativeInstruction(ata),
  );
  tx.feePayer = owner;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw launchpadSimError("wrapping COOK for the dev buy", sim.value.err, sim.value.logs ?? null);
  }
  await signer.signTransaction(tx, {
    what: "COOK wrap for the dev buy",
    blockhash,
    lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
    step: "intermediate",
    summary: { wrapsCookLamports: shortfall.toString(), into: ata.toBase58() },
  });
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize());
  } catch (e) {
    throw sendFailure("COOK wrap for the dev buy", e);
  }
  return confirmSent(
    conn,
    { signature, blockhash, lastValidBlockHeight },
    "COOK wrap for the dev buy",
  );
}

/**
 * Refuse a dev buy we could never verify — BEFORE any network call.
 *
 * A dev buy forces a versioned build, and a versioned build is only signable if we can pin the lookup
 * table it resolves through. Without a pin the launch is doomed, and finding that out after the build
 * costs a real IPFS pin plus a leased vanity `momo` mint (rate-limited 5 per 600s), which is exactly
 * the waste the backend's own up-front rejection was added to avoid. Same spirit as
 * `assertLogoDecision`: decide what is impossible before spending anything.
 */
export function assertDevBuySupported(hasDevBuy: boolean, pinned: string): void {
  if (!hasDevBuy || pinned) return;
  throw new CookieMcpError(
    "this build of cookie-mcp cannot launch with a dev buy: the launchpad's address lookup table is " +
      "not pinned, so a versioned transaction's accounts could not be verified before signing",
    "launch without the dev buy and buy right after it lands (launchpad_buy), or set " +
      "MOMOSWAP_LAUNCHPAD_ALT to the launchpad's current frozen lookup table — nothing was sent",
  );
}

/**
 * Why a pinned ADDRESS is not the end of the check, and what we verify instead.
 *
 * A v0 build carries table indices, so the table decides what its account slots mean. Matching the
 * address only says the builder used the table we expected — not what that table says right now. A
 * table stays mutable until its authority is dropped, so the honest check is against the live account:
 * the entries we pinned, still there, in the same order, and the account immutable and usable.
 *
 * Pure so every refusal is testable. `table` is what the RPC returned (null when the account is
 * missing). Returns null to proceed, or the reason to refuse.
 */
export function altAccountMismatch(
  table: {
    state: { authority?: PublicKey; addresses: PublicKey[]; deactivationSlot: bigint };
  } | null,
  expected: readonly string[],
): string | null {
  if (!table) return "the launchpad's address lookup table does not exist on chain";
  if (table.state.authority) {
    return (
      `the lookup table is still mutable (authority ${table.state.authority.toBase58()}), so what its ` +
      "indices resolve to could change after this transaction was built"
    );
  }
  // A table can be DEACTIVATED, after which it stops being usable for new transactions once the
  // cooldown passes — and it would otherwise sail past an authority-and-addresses check while the
  // transaction fails on chain for a reason nothing here explained.
  if (table.state.deactivationSlot !== 2n ** 64n - 1n) {
    return "the lookup table has been deactivated, so it can no longer be used to build transactions";
  }
  const have = table.state.addresses;
  for (const [i, want] of expected.entries()) {
    const got = have[i]?.toBase58();
    if (got !== want) {
      return (
        `the lookup table's entry [${i}] is ${got ?? "missing"}, expected ${want} — its contents are ` +
        "not what this build of cookie-mcp pinned"
      );
    }
  }
  return null;
}

/**
 * Read the pinned table and refuse to sign unless it is exactly what we committed to. One RPC call,
 * only on the versioned path, and only before signing — nothing has been sent at this point.
 */
async function assertAltTrustworthy(conn: Connection, what: string): Promise<void> {
  let table: Awaited<ReturnType<Connection["getAddressLookupTable"]>>["value"];
  try {
    table = (
      await conn.getAddressLookupTable(new PublicKey(LAUNCHPAD_ALT_ADDRESS), {
        commitment: "confirmed",
      })
    ).value;
  } catch (e) {
    // A read failure is not evidence of tampering, but it is also not evidence of safety, and this is
    // the one check standing between a table swap and a signature. Refuse rather than assume.
    throw new CookieMcpError(
      `could not read the launchpad's address lookup table to verify this ${what}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      "nothing was sent — retry; if it persists the RPC may be degraded",
    );
  }
  const mismatch = altAccountMismatch(table, LAUNCHPAD_ALT_KEYS);
  if (mismatch) {
    throw new CookieMcpError(
      `refusing to sign this ${what}: ${mismatch}`,
      "nothing was sent — this should not happen for a frozen table, so treat it as a sign that the " +
        "launchpad moved to a different one and cookie-mcp needs updating",
    );
  }
}

/**
 * Decode whichever shape the API returned. `txVersion` states it, so we never sniff the payload.
 *
 * A v0 payload throws inside `Transaction.from` rather than returning something wrong, so the legacy
 * path stays exactly as strict as it was.
 */
export function deserializeBuilt(built: BuiltTx): Transaction | VersionedTransaction {
  const bytes = Buffer.from(built.transactionBase64, "base64");
  return built.txVersion === 0 ? VersionedTransaction.deserialize(bytes) : Transaction.from(bytes);
}

/**
 * Simulate an API-built, partial-signed legacy transaction, add our signature and send it.
 * The API sets the fee payer and blockhash, so we confirm against the window it returned.
 */
async function submitBuilt(
  built: BuiltTx,
  signer: TxSigner,
  what: string,
  codeHints?: Record<number, SimCodeHint>,
  summary?: Record<string, unknown>,
): Promise<string> {
  if (!built.transactionBase64) {
    throw new CookieMcpError(
      `the launchpad returned no ${what} transaction`,
      "retry; if it persists the launchpad API may be degraded",
    );
  }
  const conn = getConnection();
  let tx: Transaction | VersionedTransaction;
  try {
    tx = deserializeBuilt(built);
  } catch {
    throw new CookieMcpError(
      `the ${what} transaction returned by the launchpad was malformed`,
      "retry; if it persists the launchpad API may be degraded",
    );
  }
  // Before signing anything: a versioned build resolves accounts through a lookup table, and an
  // unverifiable table means we cannot say what we are about to sign.
  if (tx instanceof VersionedTransaction) {
    const mismatch = altPinMismatch(built.lookupTables, LAUNCHPAD_ALT_ADDRESS);
    if (mismatch) {
      throw new CookieMcpError(
        `refusing to sign this ${what}: ${mismatch}`,
        "nothing was sent — update cookie-mcp (or set MOMOSWAP_LAUNCHPAD_ALT) to the launchpad's " +
          "current frozen lookup table",
      );
    }
    // The address matched; now check the table itself still says what we pinned.
    await assertAltTrustworthy(conn, what);
  }

  // The two overloads differ in a way that matters downstream: the LEGACY one rewrites
  // `recentBlockhash` with a fresh one before simulating, the versioned one simulates the message as
  // given (and so needs the API's blockhash to still be valid). `assertBlockhashUsable` below covers
  // both, but for the versioned path it is load-bearing rather than belt-and-braces.
  const sim =
    tx instanceof VersionedTransaction
      ? await conn.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false })
      : await conn.simulateTransaction(tx);
  if (sim.value.err) {
    // The transaction itself says which deployment the API built against, which is what the error
    // codes belong to — no need to ask the chain.
    throw launchpadSimError(
      what,
      sim.value.err,
      sim.value.logs ?? null,
      launchpadProgramIdFromTx(tx),
      codeHints,
    );
  }

  // The simulation above proves the PROGRAM accepts the transaction, but it says nothing about the
  // blockhash: web3.js's legacy `simulateTransaction(Transaction)` overwrites `recentBlockhash` with a
  // fresh one before simulating. The blockhash we actually send is the API's, and the API builds
  // against its own RPC node — when that node lags, the blockhash is already expired on arrival and
  // the send dies at preflight with a raw, untranslated web3 error. Check it while we can still say
  // that nothing was sent. Most of the API-built transactions are co-signed by server-side keypairs
  // (the leased mint and the vaults on a launch), so refreshing the blockhash locally is not an option
  // — it would invalidate their signatures.
  await assertBlockhashUsable(conn, built, what);

  // Legacy takes a variadic; a VersionedTransaction takes an array and merges into the existing
  // signature slots, which is what keeps the API's own partial signatures (the leased mint + vaults).
  await signer.signTransaction(tx, {
    what,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
    ...(summary ? { summary } : {}),
  });
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize());
  } catch (e) {
    throw sendFailure(what, e);
  }
  // A confirm timeout does NOT mean the transaction failed — it may still land, and a blind retry here
  // would buy or launch twice. confirmSent turns that into an explicit warning with the signature.
  return confirmSent(
    conn,
    { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
    what,
  );
}

/** A pool reference is either the pool PDA or the token mint — resolve both to the pool. */
async function resolvePool(ref: string): Promise<LaunchpadPool> {
  try {
    return await fetchPoolByAddress(ref);
  } catch {
    try {
      return (await fetchPoolByMint(ref)).pool;
    } catch {
      throw new CookieMcpError(
        `no launchpad pool found for "${ref}"`,
        "pass the token mint or the pool address of a MomoSwap launch (get_launchpad_pools lists them)",
      );
    }
  }
}

// --- cross-tool handoff -------------------------------------------------------------------------

/**
 * Explain why a mint has no swap route when the reason is the launchpad (pure — the caller supplies
 * the pool). A live curve has no DEX pool at all, so aggregators legitimately find nothing; the agent
 * needs to be sent to the launchpad tools instead of concluding the token is untradeable. Returns
 * null for a graduated pool: that token DOES have a market, so a missing route is a real liquidity
 * problem and the caller's own message is the honest one.
 */
export function launchpadRouteMessage(
  pool: Pick<
    LaunchpadPool,
    | "pubkey"
    | "symbol"
    | "expiryMode"
    | "launchTs"
    | "endTs"
    | "paymentRaisedNet"
    | "graduationTarget"
  > & { status: PoolPhase },
): { error: string; hint: string } | null {
  const sym = pool.symbol || "this token";
  switch (pool.status) {
    case "ended":
      return {
        error: `${sym} has no swap route: its MomoSwap launch window has closed and the pool has not been settled on-chain yet`,
        hint:
          pool.expiryMode === "fair"
            ? "it never graduated, so there is no market; claim_launchpad settles the pool and pays a curve position its pro-rata refund"
            : "it never graduated, so there is no market; once the pool is expired on-chain, claim_launchpad settles a curve position",
      };
    case "live":
      return {
        error: `${sym} has no swap route: it is still trading on its MomoSwap launchpad bonding curve, which DEX aggregators cannot route`,
        hint:
          `buy it with launchpad_buy and sell it with launchpad_sell (pool ${pool.pubkey}) — it becomes ` +
          `swappable only after the launch graduates (${graduationProgressPct(pool.paymentRaisedNet, pool.graduationTarget)}% of the target raised)`,
      };
    case "upcoming":
      return {
        error: `${sym} is not tradeable yet: its MomoSwap launch opens at ${new Date(pool.launchTs * 1000).toISOString()}`,
        hint: "check it with get_launchpad_token, then buy on the curve with launchpad_buy once it opens",
      };
    case "expired":
      return {
        error: `${sym} has no market: its MomoSwap launch expired without reaching the graduation target, so it never got a pool`,
        hint:
          pool.expiryMode === "fair"
            ? "if you bought on the curve, claim_launchpad returns your pro-rata refund"
            : pool.expiryMode === "dead"
              ? "there is no market and no holder payout — unraised funds went to the treasury"
              : "if you placed in the settlement, claim_launchpad pays out your Merkle allocation",
      };
    default:
      return null;
  }
}

/**
 * A swap route lookup came back empty. If one of the mints is a launchpad token whose curve is still
 * the only venue, return an error pointing at the launchpad tools; otherwise null so the caller keeps
 * its own message. **Never throws** — a launchpad lookup must not replace a swap error with a
 * lookup error.
 */
export async function launchpadRouteRedirect(mints: string[]): Promise<CookieMcpError | null> {
  for (const mint of mints) {
    if (!mint || mint === COOK_MINT) continue;
    try {
      const { pool } = await fetchPoolByMint(mint);
      const msg = launchpadRouteMessage({ ...pool, status: poolPhase(pool, nowSeconds()) });
      if (msg) return new CookieMcpError(msg.error, msg.hint);
    } catch {
      /* not a launchpad mint, or the launchpad API is unreachable — fall through */
    }
  }
  return null;
}

/**
 * The error the swap paths (`get_quote`, `trade`) should raise when no route exists: the launchpad
 * redirect when that is the real reason, else the original upstream error, else the generic message.
 * Lives here because only the launchpad can explain the interesting case.
 */
export async function noRouteError(mints: string[], upstream?: unknown): Promise<unknown> {
  // Only second-guess route-shaped failures; a timeout or an outage must surface as itself.
  const msg = upstream instanceof Error ? upstream.message : "";
  const routeShaped = !upstream || /route|liquidity|pool/i.test(msg);
  if (routeShaped) {
    const redirect = await launchpadRouteRedirect(mints);
    if (redirect) return redirect;
  }
  return (
    upstream ??
    new CookieMcpError(
      "no route found for this pair",
      "the pair may lack liquidity; try a smaller amount or a more liquid token",
    )
  );
}

/** The launch token's decimals, read from the mint (falls back to the launchpad default). */
async function tokenDecimals(pool: LaunchpadPool, cfg: LaunchpadConfig): Promise<number> {
  try {
    return (await getMint(getConnection(), new PublicKey(pool.tokenMint))).decimals;
  } catch {
    return cfg.defaultTokenDecimals;
  }
}

// --- reads ---------------------------------------------------------------------------------------

export interface LaunchpadPoolView {
  pool: string;
  mint: string;
  name: string;
  symbol: string;
  /** Derived phase, not the raw API status — see poolPhase (can be `ended`). */
  status: PoolPhase;
  expiryMode: ExpiryMode;
  creator: string;
  metadataUri: string;
  priceCook: number;
  raisedCook: string;
  graduationTargetCook: string;
  graduationProgressPct: number;
  tokensSold: string;
  saleSupply: string;
  participants: number;
  launchAt: string;
  /** When trading closes. Past this, `status` reads `ended` until the pool is settled on-chain. */
  endsAt: string;
  antiSnipe: boolean;
  minBuyCook: string;
  maxBuyPerWalletCook: string | null;
  links: { launchpad: string; token: string };
}

/**
 * The pool's real phase, which is NOT always the API's `status`.
 *
 * On-chain, `buy`/`sell` require `now <= end_ts` and the claim paths require state `Expired`. A pool
 * past `end_ts` but still on-chain `Open` is therefore neither tradeable nor claimable, and taking
 * `status` at face value would have us advertise it as tradeable when every trade reverts, and tell
 * holders to "sell to exit" when they cannot. `ended` names that window.
 *
 * The launchpad API now derives `ended` itself (momoswap-frontend #3), so on a current deployment this
 * agrees with `status` rather than correcting it. It still has to be derived locally: the deployed API
 * predates that release and reports the window as `live`, and the boundary is only knowable from
 * `end_ts` anyway. Same alias either way — `PoolPhase` is `PoolStatus` now that `ended` is in it.
 */
export type PoolPhase = PoolStatus;

export function poolPhase(
  pool: Pick<LaunchpadPool, "status" | "endTs">,
  nowSec: number,
): PoolPhase {
  return pool.status === "live" && nowSec > pool.endTs ? "ended" : pool.status;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Project a raw pool account into the agent-facing view (pure — all inputs are supplied). */
export function mapPoolView(
  pool: LaunchpadPool,
  tokenDecs: number,
  paymentDecs: number = COOK_DECIMALS,
  nowSec: number = nowSeconds(),
): LaunchpadPoolView {
  return {
    pool: pool.pubkey,
    mint: pool.tokenMint,
    name: pool.name,
    symbol: pool.symbol,
    status: poolPhase(pool, nowSec),
    expiryMode: pool.expiryMode,
    creator: pool.creator,
    metadataUri: pool.uri,
    priceCook: spotPriceCook(pool, paymentDecs, tokenDecs),
    raisedCook: rawToUi(pool.paymentRaisedNet, paymentDecs),
    graduationTargetCook: rawToUi(pool.graduationTarget, paymentDecs),
    graduationProgressPct: graduationProgressPct(pool.paymentRaisedNet, pool.graduationTarget),
    tokensSold: rawToUi(pool.tokensSold, tokenDecs),
    saleSupply: rawToUi(pool.saleTokenSupply, tokenDecs),
    participants: Number(pool.participantCount),
    launchAt: new Date(pool.launchTs * 1000).toISOString(),
    endsAt: new Date(pool.endTs * 1000).toISOString(),
    antiSnipe: pool.antiSnipe,
    minBuyCook: rawToUi(pool.minBuy, paymentDecs),
    maxBuyPerWalletCook:
      BigInt(pool.maxBuyPerWallet) > 0n ? rawToUi(pool.maxBuyPerWallet, paymentDecs) : null,
    links: { launchpad: launchpadPoolUrl(pool.pubkey), token: launchpadTokenUrl(pool.tokenMint) },
  };
}

export interface GetLaunchpadPoolsResult {
  count: number;
  status: PoolStatus | "all";
  program: string;
  pools: LaunchpadPoolView[];
}

export async function getLaunchpadPools(args: {
  status?: PoolStatus | "all";
  limit?: number;
}): Promise<GetLaunchpadPoolsResult> {
  const status = args.status ?? "live";
  const [cfg, pools] = await Promise.all([fetchLaunchpadConfig(), fetchPools(status)]);
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  // Most-progressed first — for live pools that's "closest to graduating".
  const sorted = [...pools].sort(
    (a, b) =>
      graduationProgressPct(b.paymentRaisedNet, b.graduationTarget) -
      graduationProgressPct(a.paymentRaisedNet, a.graduationTarget),
  );
  return {
    count: pools.length,
    status,
    // Report the deployment these pools actually live on, not a build-time constant — the launchpad
    // has been redeployed under a new id before. Falls back to the configured id if the read fails.
    program: await resolvePoolsProgramId(sorted[0]?.pubkey),
    pools: sorted.slice(0, limit).map((p) => mapPoolView(p, cfg.defaultTokenDecimals)),
  };
}

/** The program owning `pool`, for reporting. Never throws — a read tool must not fail over a label. */
async function resolvePoolsProgramId(pool: string | undefined): Promise<string> {
  if (!pool) return PROGRAM_IDS.momoswapLaunchpad;
  try {
    const owners = await fetchPoolPrograms(getConnection(), [pool]);
    return owners.get(pool)?.toBase58() ?? PROGRAM_IDS.momoswapLaunchpad;
  } catch {
    return PROGRAM_IDS.momoswapLaunchpad;
  }
}

export interface PositionView {
  owner: string;
  shares: string;
  investedCook: string;
  withdrawnCook: string;
  estimatedValueCook: string | null;
  claimed: { refund: boolean; winnings: boolean; graduatedTokens: boolean };
}

// --- get_launchpad_positions ---------------------------------------------------------------------

/** What the holder can do about a position right now, if anything. */
export interface PositionAction {
  tool: "launchpad_sell" | "claim_launchpad" | "claim_creator_fees";
  kind: ClaimKind | "sell" | "creator_fees";
  reason: string;
}

/**
 * The action a position calls for (pure). Curve shares are not SPL tokens, so "do nothing" is rarely
 * right: after graduation the tokens sit unclaimed, and a Fair expiry leaves a refund on the table.
 * Returns null when the position is settled or there is genuinely nothing to collect.
 */
export function positionAction(
  pool: { status: PoolPhase; expiryMode: ExpiryMode },
  position: Pick<
    LaunchpadPosition,
    "shares" | "claimed" | "winnerClaimed" | "graduatedTokensClaimed"
  >,
): PositionAction | null {
  const hasShares = BigInt(position.shares) > 0n;
  // `ended` = trading closed but nobody has settled the pool on-chain yet. Selling always reverts (past
  // end_ts), but a FAIR refund is actionable: `claim_fair` expires the pool itself. Every other mode has
  // to wait for the expiry transition, so there is still nothing for its holders to do here.
  if (pool.status === "ended") {
    return hasShares && pool.expiryMode === "fair" && !position.claimed
      ? {
          tool: "claim_launchpad",
          kind: "fair",
          reason:
            "the launch window closed in Fair mode — claiming settles the pool and pays your pro-rata refund",
        }
      : null;
  }
  if (pool.status === "graduated") {
    if (hasShares && !position.graduatedTokensClaimed) {
      return {
        tool: "claim_launchpad",
        kind: "graduated_tokens",
        reason: "the pool graduated and your SPL tokens are still unclaimed",
      };
    }
    return null;
  }
  if (pool.status === "live") {
    return hasShares
      ? {
          tool: "launchpad_sell",
          kind: "sell",
          reason: "the curve is still live — you can sell these shares back to it",
        }
      : null;
  }
  if (pool.status !== "expired") return null;
  if (!hasShares) return null;
  if (pool.expiryMode === "fair" && !position.claimed) {
    return {
      tool: "claim_launchpad",
      kind: "fair",
      reason: "the launch expired in Fair mode — your pro-rata refund is unclaimed",
    };
  }
  if (
    (pool.expiryMode === "jackpot" || pool.expiryMode === "survivor") &&
    !position.winnerClaimed
  ) {
    return {
      tool: "claim_launchpad",
      kind: "winner",
      reason: `the launch expired in ${pool.expiryMode} mode — claim_launchpad checks whether you placed in the settlement`,
    };
  }
  return null; // dead mode, or already claimed
}

/** Unclaimed creator vesting on a pool this wallet created (pure). */
export function creatorVestOutstanding(
  pool: Pick<LaunchpadPool, "creatorVestAmount" | "creatorVestClaimed">,
): bigint {
  const total = BigInt(pool.creatorVestAmount);
  const claimed = BigInt(pool.creatorVestClaimed);
  return total > claimed ? total - claimed : 0n;
}

export interface LaunchpadPositionEntry {
  pool: string;
  mint: string;
  symbol: string;
  status: PoolPhase;
  expiryMode: ExpiryMode;
  shares: string;
  investedCook: string;
  withdrawnCook: string;
  /** What selling the remaining shares back to a LIVE curve would pay; null once it isn't live. */
  estimatedValueCook: string | null;
  action: PositionAction | null;
  links: { launchpad: string; token: string };
}

export interface LaunchpadCreatorEntry {
  pool: string;
  mint: string;
  symbol: string;
  status: PoolPhase;
  unclaimedFeesCook: string;
  /** Creator vesting is denominated in the LAUNCH TOKEN, not COOK — hence the explicit name. */
  unclaimedVestTokens: string | null;
  actions: PositionAction[];
}

export interface GetLaunchpadPositionsResult {
  owner: string;
  poolsScanned: number;
  positions: LaunchpadPositionEntry[];
  created: LaunchpadCreatorEntry[];
  totals: {
    investedCook: string;
    withdrawnCook: string;
    liveValueCook: string;
    unclaimedCreatorFeesCook: string;
    actionsPending: number;
  };
  notes: string[];
}

/**
 * Every launchpad position a wallet holds, plus anything it can claim — the view `get_balance` cannot
 * give, because pre-graduation shares are program state rather than SPL tokens. Reads the
 * `UserPosition` PDAs directly in batches (see positions.ts), so cost is ~1 RPC round trip per 100
 * pools rather than one HTTP call each. No key needed when `owner` is passed.
 */
export async function getLaunchpadPositions(args: {
  owner?: string;
  includeClosed?: boolean;
}): Promise<GetLaunchpadPositionsResult> {
  const requested = args.owner?.trim();
  // `owner` accepts a `.cook` name as well as an address; only a name costs a lookup.
  const owner = requested
    ? (await resolveWallet(requested, "owner")).pubkey.toBase58()
    : ownPublicKey();
  if (!owner) {
    throw new CookieMcpError(
      "no wallet to look up",
      "pass `owner` (any address or .cook name), or set COOKIE_PRIVATE_KEY to use your own",
    );
  }

  const conn = getConnection();
  const [cfg, pools] = await Promise.all([fetchLaunchpadConfig(), fetchPools("all")]);
  const decs = cfg.defaultTokenDecimals;
  const poolKeys = pools.map((p) => p.pubkey);
  const created = pools.filter((p) => p.creator === owner);

  // Read each pool's owning program first: PDA seeds are program-scoped, and pools created before a
  // redeploy stay on the old program id forever, so a single hardcoded id would silently miss them.
  const programs = await fetchPoolPrograms(conn, poolKeys);
  const [positions, feeVaults] = await Promise.all([
    fetchPositionsForPools(conn, owner, poolKeys, programs),
    created.length
      ? fetchCreatorFeeVaults(
          conn,
          created.map((p) => p.pubkey),
          programs,
        )
      : new Map(),
  ]);

  let investedRaw = 0n;
  let withdrawnRaw = 0n;
  let liveValueRaw = 0n;
  let actionsPending = 0;

  const now = nowSeconds();
  const entries: LaunchpadPositionEntry[] = [];
  for (const pool of pools) {
    const position = positions.get(pool.pubkey);
    if (!position) continue;
    const phase = poolPhase(pool, now);
    const shares = BigInt(position.shares);
    const action = positionAction({ status: phase, expiryMode: pool.expiryMode }, position);
    if (shares === 0n && !action && !args.includeClosed) continue; // fully exited and settled

    investedRaw += BigInt(position.totalPaymentIn);
    withdrawnRaw += BigInt(position.totalPaymentOut);
    let value: string | null = null;
    if (phase === "live" && shares > 0n) {
      const net = estimateSell(pool, shares, poolTradeFeeBps(pool, cfg)).netRaw;
      liveValueRaw += net;
      value = rawToUi(net, COOK_DECIMALS);
    }
    // A live curve's "sell" is an option, not an outstanding obligation — only claims count as pending.
    if (action && action.tool === "claim_launchpad") actionsPending += 1;

    entries.push({
      pool: pool.pubkey,
      mint: pool.tokenMint,
      symbol: pool.symbol,
      status: phase,
      expiryMode: pool.expiryMode,
      shares: rawToUi(position.shares, decs),
      investedCook: rawToUi(position.totalPaymentIn, COOK_DECIMALS),
      withdrawnCook: rawToUi(position.totalPaymentOut, COOK_DECIMALS),
      estimatedValueCook: value,
      action,
      links: { launchpad: launchpadPoolUrl(pool.pubkey), token: launchpadTokenUrl(pool.tokenMint) },
    });
  }

  let feesRaw = 0n;
  const createdEntries: LaunchpadCreatorEntry[] = [];
  for (const pool of created) {
    const fees = (feeVaults as Map<string, bigint>).get(pool.pubkey) ?? 0n;
    const vest = creatorVestOutstanding(pool);
    if (fees === 0n && vest === 0n && !args.includeClosed) continue;
    feesRaw += fees;
    const actions: PositionAction[] = [];
    if (fees > 0n) {
      actions.push({
        tool: "claim_creator_fees",
        kind: "creator_fees",
        reason: `${rawToUi(fees, COOK_DECIMALS)} ${COOK_SYMBOL} of creator trading fees is unclaimed`,
      });
    }
    // Vesting is linear from graduation, so the claimable slice may be smaller than what is left.
    if (vest > 0n && pool.status === "graduated") {
      actions.push({
        tool: "claim_launchpad",
        kind: "creator_vest",
        reason: `${rawToUi(vest, decs)} ${pool.symbol} of your creator allocation is still vesting/unclaimed — claim the vested portion with kind=creator_vest`,
      });
    }
    actionsPending += actions.length;
    createdEntries.push({
      pool: pool.pubkey,
      mint: pool.tokenMint,
      symbol: pool.symbol,
      status: poolPhase(pool, now),
      unclaimedFeesCook: rawToUi(fees, COOK_DECIMALS),
      unclaimedVestTokens: vest > 0n ? rawToUi(vest, decs) : null,
      actions,
    });
  }

  const notes: string[] = [];
  if (entries.length) {
    notes.push(
      "Shares on a live curve are program state, not SPL tokens — they never appear in get_balance.",
    );
  }
  if (actionsPending) {
    notes.push(`${actionsPending} position(s) have something unclaimed — see each entry's action.`);
  }
  const empty = emptyPositionsNote({
    poolsScanned: pools.length,
    found: entries.length + createdEntries.length,
    includeClosed: args.includeClosed === true,
  });
  if (empty) notes.push(empty);

  return {
    owner,
    poolsScanned: pools.length,
    positions: entries,
    created: createdEntries,
    totals: {
      investedCook: rawToUi(investedRaw, COOK_DECIMALS),
      withdrawnCook: rawToUi(withdrawnRaw, COOK_DECIMALS),
      liveValueCook: rawToUi(liveValueRaw, COOK_DECIMALS),
      unclaimedCreatorFeesCook: rawToUi(feesRaw, COOK_DECIMALS),
      actionsPending,
    },
    notes,
  };
}

/**
 * What to say when the scan turned up nothing — which is two very different situations that used to
 * render as one.
 *
 * `poolsScanned: 0` means the API's pool list came back EMPTY, so not one PDA was read. That is not the
 * same claim as "this wallet holds nothing", and stating the latter is asserting a negative we never
 * checked. Seen live on 2026-09-10: immediately after a launch the pool list lags the chain, so a
 * position opened seconds earlier reported as an empty portfolio — and "Nothing outstanding" gives an
 * agent no way to tell that apart from a genuine zero. `positions.ts` derives PDAs itself but still
 * ENUMERATES from that list, so it inherits the lag no matter how good the on-chain reads are.
 */
export function emptyPositionsNote(args: {
  poolsScanned: number;
  found: number;
  includeClosed: boolean;
}): string | null {
  if (args.poolsScanned === 0) {
    return (
      "The launchpad API returned no pools, so no position could be scanned — this is NOT a statement " +
      "that the wallet holds nothing. The pool list lags the chain right after a launch; re-read in a minute."
    );
  }
  if (args.found > 0) return null;
  return args.includeClosed
    ? "This wallet has never traded on the MomoSwap launchpad."
    : "Nothing outstanding. Pass includeClosed=true to also list fully exited positions.";
}

export interface GetLaunchpadTokenResult extends LaunchpadPoolView {
  fees: { tradePct: number; creatorSharePct: number; referralSharePct: number };
  quote: { cookIn: string; tokensOut: string } | null;
  position: PositionView | null;
  pendingCreatorFeesCook: number | null;
  notes: string[];
}

/** Identity + curve price for a launchpad mint, for callers that only need to describe the token. */
export interface LaunchpadTokenIdentity {
  pool: string;
  status: PoolPhase;
  note: string;
  name: string;
  symbol: string;
  decimals: number;
  metadataUri: string;
  /** Curve spot price in COOK. The curve IS this token's only market pre-graduation. */
  priceCook: number;
}

/**
 * Describe a mint purely from its launchpad pool, for `get_token_info` to fall back on when the
 * Cookiescan registry has never heard of it. **Every launch is in exactly that state for a while**, so
 * this is the normal path for a fresh token, not an edge case.
 * Returns null when the mint is not a launchpad token (or the launchpad API is unreachable).
 */
export async function launchpadTokenIdentity(mint: string): Promise<LaunchpadTokenIdentity | null> {
  try {
    const [cfg, { pool }] = await Promise.all([fetchLaunchpadConfig(), fetchPoolByMint(mint)]);
    const decimals = await tokenDecimals(pool, cfg);
    const status = poolPhase(pool, nowSeconds());
    const msg = launchpadRouteMessage({ ...pool, status });
    return {
      pool: pool.pubkey,
      status,
      // Every phase has a route message except a graduated pool, which trades normally and so needs no
      // explanation beyond "it came from the launchpad".
      note: msg?.hint ?? "this token launched on the MomoSwap launchpad and has graduated",
      name: pool.name,
      symbol: pool.symbol,
      decimals,
      metadataUri: pool.uri,
      priceCook: spotPriceCook(pool, COOK_DECIMALS, decimals),
    };
  } catch {
    return null;
  }
}

export async function getLaunchpadToken(args: {
  ref: string;
  quoteCook?: string | number;
}): Promise<GetLaunchpadTokenResult> {
  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  const decs = await tokenDecimals(pool, cfg);
  const owner = ownPublicKey();

  const [position, pendingCreatorFees] = await Promise.all([
    owner ? fetchPosition(pool.pubkey, owner).catch(() => null) : Promise.resolve(null),
    owner && owner === pool.creator
      ? fetchPendingCreatorFees(pool.pubkey).catch(() => null)
      : Promise.resolve(null),
  ]);

  const view = mapPoolView(pool, decs);
  const phase = poolPhase(pool, nowSeconds());
  const tradeable = phase === "live";

  let quote: { cookIn: string; tokensOut: string } | null = null;
  // Quote from the curve for pools that still have one — including a launch that hasn't opened yet.
  if (args.quoteCook != null && (tradeable || phase === "upcoming")) {
    const cookIn = uiToRaw(args.quoteCook, COOK_DECIMALS);
    const est = estimateBuy(pool, cookIn, poolTradeFeeBps(pool, cfg));
    quote = {
      cookIn: rawToUi(cookIn, COOK_DECIMALS),
      tokensOut: rawToUi(est.tokensOutRaw, decs),
    };
  }

  const notes: string[] = [];
  if (phase === "live") {
    notes.push(
      "Pre-graduation holdings are program-tracked curve shares, not SPL tokens: they do not appear " +
        "in get_balance and cannot be swapped with trade. Use launchpad_sell to exit.",
    );
  }
  if (phase === "graduated") {
    notes.push(
      "This pool graduated — curve buyers claim their real SPL tokens with claim_launchpad, then " +
        "trade them normally with trade/get_quote.",
    );
  }
  if (phase === "ended") {
    notes.push(
      "The launch window has closed but the pool is not settled on-chain yet: trading is over and " +
        (pool.expiryMode === "fair"
          ? "a curve holder can claim their pro-rata refund with claim_launchpad, which settles the pool as part of the claim."
          : pool.expiryMode === "dead"
            ? 'this is a "dead" expiry — unraised funds go to the treasury, so there is nothing to claim.'
            : `a ${pool.expiryMode} payout needs the pool expired and its settlement root published first.`),
    );
  }
  if (phase === "expired") {
    notes.push(
      `This launch expired without graduating; settlement mode is "${pool.expiryMode}"` +
        (pool.expiryMode === "fair"
          ? " — curve buyers can claim a pro-rata refund with claim_launchpad."
          : pool.expiryMode === "dead"
            ? " — unraised funds are swept to the treasury; there is nothing to claim."
            : " — winners claim their Merkle payout with claim_launchpad once the root is set."),
    );
  }

  return {
    ...view,
    // This pool's own snapshotted schedule, not the global one — see ./fees.
    fees: {
      tradePct: poolTradeFeeBps(pool, cfg) / 100,
      creatorSharePct: poolFeeShareBps(pool, cfg, "creator") / 100,
      referralSharePct: poolFeeShareBps(pool, cfg, "referral") / 100,
    },
    quote,
    position: position
      ? {
          owner: position.owner,
          shares: rawToUi(position.shares, decs),
          investedCook: rawToUi(position.totalPaymentIn, COOK_DECIMALS),
          withdrawnCook: rawToUi(position.totalPaymentOut, COOK_DECIMALS),
          estimatedValueCook:
            tradeable && BigInt(position.shares) > 0n
              ? rawToUi(
                  estimateSell(pool, BigInt(position.shares), poolTradeFeeBps(pool, cfg)).netRaw,
                  COOK_DECIMALS,
                )
              : null,
          claimed: {
            refund: position.claimed,
            winnings: position.winnerClaimed,
            graduatedTokens: position.graduatedTokensClaimed,
          },
        }
      : null,
    pendingCreatorFeesCook: pendingCreatorFees,
    notes,
  };
}

// --- deploy_token -------------------------------------------------------------------------------

export interface DeployTokenArgs {
  name: string;
  symbol: string;
  /**
   * External signer only: the wallet's signature over the launchpad login message a previous
   * `deploy_token` call returned in `needs_signature` (`kind: "message"`). Ignored with a local key.
   */
  loginSignature?: ProvidedSignature;
  description?: string;
  imageBase64?: string;
  imageMimeType?: string;
  imageUrl?: string;
  /** Path to a logo on this machine — read and typed here, never routed through the model. */
  imagePath?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  durationSecs?: number;
  expiryMode?: ExpiryMode;
  antiSnipe?: boolean;
  minBuyCook?: string | number;
  maxBuyPerWalletCook?: string | number;
  devBuyCook?: string | number;
  /**
   * Dev buy expressed as a percentage of the TOTAL supply, converted to COOK off the live launch
   * curve. Mutually exclusive with `devBuyCook`.
   */
  devBuyPctOfTotalSupply?: number;
  /** Deliberately launch with no logo. Required to bypass `assertLogoDecision`. */
  noLogo?: boolean;
}

/**
 * The curve every pool opens on — `create_pool` snapshots these off the config verbatim, so a launch
 * can be quoted before the pool exists. `null` on a deploy that does not publish the reserves: never
 * fall back to hardcoded constants, which is the staleness trap that the graduation-target minimum
 * already walked into once.
 */
export function launchCurve(cfg: LaunchpadConfig): CurveState | null {
  const x = cfg.defaultVirtualPaymentReserve;
  const y = cfg.defaultVirtualTokenReserve;
  if (!x || !y || BigInt(x) <= 0n || BigInt(y) <= 0n) return null;
  return {
    virtualPaymentReserve: x,
    virtualTokenReserve: y,
    tokensSold: "0",
    paymentRaisedNet: "0",
  };
}

/**
 * COOK needed to buy `pct` % of the TOTAL supply on a fresh curve (pure).
 *
 * "prebuy 1%" is ambiguous in the wild — the create page quotes a dev buy as a share of the *sale*
 * supply (800M of the 1B minted), so the same words mean two amounts ~338 COOK apart. The parameter
 * name commits to one denominator and `describeDevBuy` reports both, rather than leaving the user to
 * discover which one they got after the launch is irreversible.
 */
export function devBuyCookForSupplyPct(cfg: LaunchpadConfig, pct: number): bigint {
  if (!Number.isFinite(pct) || pct <= 0) {
    throw new CookieMcpError(
      "devBuyPctOfTotalSupply must be greater than 0",
      "e.g. 1 for 1% of the total supply",
    );
  }
  const total = BigInt(cfg.defaultTotalSupply);
  const sale = BigInt(cfg.defaultSaleSupply);
  // Percent in basis points keeps the share exact for the fractions anyone actually asks for.
  const tokens = (total * BigInt(Math.round(pct * 100))) / 10_000n;
  if (tokens <= 0n) {
    throw new CookieMcpError(
      `${pct}% of the supply rounds to zero tokens`,
      "ask for a larger share",
    );
  }
  if (tokens > sale) {
    throw new CookieMcpError(
      `${pct}% of the total supply is more than the whole sale supply`,
      `only ${rawToUi(sale, cfg.defaultTokenDecimals)} of ${rawToUi(total, cfg.defaultTokenDecimals)} tokens are sold on the curve`,
    );
  }
  const curve = launchCurve(cfg);
  if (!curve) {
    throw new CookieMcpError(
      "this launchpad does not publish its launch curve, so a supply share cannot be priced",
      "pass devBuyCook with an explicit COOK amount instead",
    );
  }
  return paymentForTokens(curve, tokens, cfg.tradeFeeBps);
}

/** What a dev buy actually gets, stated against BOTH denominators (pure). */
export function describeDevBuy(cfg: LaunchpadConfig, devBuyRaw: bigint): string | null {
  if (devBuyRaw <= 0n) return null;
  const curve = launchCurve(cfg);
  if (!curve) return null; // a curve the config did not publish — say nothing rather than guess.
  let tokens: bigint;
  try {
    tokens = estimateBuy(curve, devBuyRaw, cfg.tradeFeeBps).tokensOutRaw;
  } catch {
    return null;
  }
  const pct = (of: string) => {
    const d = BigInt(of);
    return d > 0n ? `${((Number(tokens) / Number(d)) * 100).toFixed(3)}%` : "?";
  };
  return (
    `The dev buy of ${rawToUi(devBuyRaw, COOK_DECIMALS)} ${COOK_SYMBOL} bought about ` +
    `${rawToUi(tokens, cfg.defaultTokenDecimals)} tokens — ${pct(cfg.defaultTotalSupply)} of the ` +
    `total supply, ${pct(cfg.defaultSaleSupply)} of the sale supply.`
  );
}

/**
 * Refuse a launch that has no logo unless the caller says it means it (pure).
 *
 * A prose "ALWAYS give the token a logo" in the tool description does not work — it competes with a
 * dozen optional params, and the only consequence used to arrive as a `warning` on the RESULT, i.e.
 * after mint + freeze authority are renounced and the metadata is immutable. A logo cannot be added
 * later, so the check has to happen while the launch can still be stopped. Opting out is one flag.
 */
export function assertLogoDecision(
  args: Pick<DeployTokenArgs, "imageBase64" | "imageUrl" | "imagePath" | "noLogo">,
): void {
  if (args.imageBase64?.trim() || args.imageUrl?.trim() || args.imagePath?.trim() || args.noLogo) {
    return;
  }
  throw new CookieMcpError(
    "this launch has no logo, and a launch is irreversible",
    "pass imagePath (preferred for a file on this machine), imageBase64 (for an image you " +
      "generated, with imageMimeType), or imageUrl; " +
      "the bytes are pinned to IPFS either way. The metadata is immutable, so a logo can never be added later " +
      "and most launchpad UIs will show a blank image. Set noLogo: true to launch anyway.",
  );
}

/** Assemble the off-chain metadata JSON the launchpad pins to IPFS (pure). */
export function buildMetadata(args: DeployTokenArgs, imageUrl?: string): LaunchpadMetadata {
  const extensions: Record<string, string> = {};
  if (args.website?.trim()) extensions.website = args.website.trim();
  if (args.twitter?.trim()) {
    const h = args.twitter.trim().replace(/^@/, "");
    extensions.twitter = /^https?:\/\//i.test(h) ? h : `https://x.com/${h}`;
  }
  if (args.telegram?.trim()) {
    const h = args.telegram.trim().replace(/^@/, "");
    extensions.telegram = /^https?:\/\//i.test(h) ? h : `https://t.me/${h}`;
  }
  return {
    name: args.name.trim(),
    symbol: args.symbol.trim().toUpperCase(),
    ...(args.description?.trim() ? { description: args.description.trim() } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
}

/**
 * The API rejected our session token. It is a bare `"session"` because that is the API's whole error
 * body for a 401 on the launch build — matched exactly rather than by substring so an unrelated
 * message that merely contains the word can't trigger a silent re-login.
 */
function isSessionRejected(e: unknown): boolean {
  return e instanceof CookieMcpError && e.message === "session";
}

/**
 * Run a session-gated build, minting a login token if we don't hold a live one.
 *
 * Retries **once** on a rejected token, because the cached token can expire or be revoked server-side
 * between two launches in the same process and the client cannot tell from the outside. The retry is
 * safe specifically because this wraps a *build*: no transaction has been signed or sent, so the worst
 * case is a second signed login message. Never widen it past a build.
 */
async function withLaunchSession<T>(
  signer: TxSigner,
  build: (session: string) => Promise<T>,
): Promise<T> {
  try {
    return await build(await launchpadSessionToken(signer));
  } catch (e) {
    if (!isSessionRejected(e)) throw e;
    resetLaunchpadSession(signer.publicKey.toBase58());
    try {
      return await build(await launchpadSessionToken(signer));
    } catch (retry) {
      if (!isSessionRejected(retry)) throw retry;
      throw new CookieMcpError(
        "the launchpad rejected this wallet's login session, so the launch could not be built",
        "the launch API requires a wallet-signed session; nothing was spent and no transaction was " +
          "sent. Retry — if it keeps failing, the launchpad's login service is down.",
      );
    }
  }
}

/** Validate + assemble on-chain `PoolParams` (pure). `launchTs` 0 lets the API stamp "now". */
export function buildCreateParams(args: DeployTokenArgs, launchTs = 0): CreatePoolParams {
  const name = args.name?.trim() ?? "";
  const symbol = args.symbol?.trim().toUpperCase() ?? "";
  if (!name || name.length > MAX_NAME_LEN) {
    throw new CookieMcpError(
      `name must be 1–${MAX_NAME_LEN} characters`,
      "shorten the token name (the full name lives in the metadata too)",
    );
  }
  if (!symbol || symbol.length > MAX_SYMBOL_LEN) {
    throw new CookieMcpError(
      `symbol must be 1–${MAX_SYMBOL_LEN} characters`,
      "use a short ticker, e.g. MOMO",
    );
  }
  const durationSecs = args.durationSecs ?? DEFAULT_DURATION_SECS;
  if (!Number.isFinite(durationSecs) || durationSecs < MIN_DURATION_SECS) {
    throw new CookieMcpError(
      `durationSecs must be at least ${MIN_DURATION_SECS}`,
      "this is how long the launch stays open to reach the graduation target",
    );
  }
  if (durationSecs > MAX_DURATION_SECS) {
    throw new CookieMcpError(
      `durationSecs must be at most ${MAX_DURATION_SECS} (7 days)`,
      "pick a shorter launch window",
    );
  }
  const expiryMode = args.expiryMode ?? "fair";
  return {
    name,
    symbol,
    launch_ts: launchTs,
    duration_secs: Math.floor(durationSecs),
    expiry_mode: expiryMode,
    migratable: true,
    anti_snipe: args.antiSnipe ?? true,
    min_buy: (args.minBuyCook != null ? uiToRaw(args.minBuyCook, COOK_DECIMALS) : 0n).toString(),
    max_buy_per_wallet: (args.maxBuyPerWalletCook != null
      ? uiToRaw(args.maxBuyPerWalletCook, COOK_DECIMALS)
      : 0n
    ).toString(),
    // The program rejects a per-pool raise cap below the graduation target, and a cap is never
    // what an agent wants here — leave the raise uncapped.
    max_payment_raise: "0",
  };
}

export interface DeployTokenResult {
  signature: string;
  explorerUrl: string;
  mint: string;
  pool: string | null;
  name: string;
  symbol: string;
  metadataUri: string | null;
  costCook: { creationFee: string; devBuy: string; total: string };
  launch: { opensAt: string; endsAt: string | null; expiryMode: ExpiryMode; antiSnipe: boolean };
  graduationTargetCook: string;
  links: { launchpad: string | null; token: string };
  warning?: string;
  notes: string[];
}

/**
 * Launch a token on the MomoSwap bonding curve. The API pins the metadata, leases a `momo`-suffixed
 * mint (required on-chain) and partial-signs the mint/vault keypairs; we simulate, sign and send.
 * Costs the launchpad's creation fee (read live from `/config`) plus rent and any dev buy.
 */
export async function deployToken(args: DeployTokenArgs): Promise<DeployTokenResult> {
  // The signer is resolved inside the context so an external one can see `loginSignature`.
  return withProvidedSignatures(args.loginSignature ? [args.loginSignature] : undefined, () =>
    deployTokenInner(args),
  );
}

async function deployTokenInner(args: DeployTokenArgs): Promise<DeployTokenResult> {
  const signer = requireSigner();
  const creator = signer.publicKey.toBase58();

  const sources = (["imagePath", "imageBase64", "imageUrl"] as const).filter((k) =>
    args[k]?.trim(),
  );
  if (sources.length > 1) {
    throw new CookieMcpError(
      `pass one logo source, not ${sources.length} (${sources.join(", ")})`,
      "imagePath for a file on this machine, imageBase64 for an image you generated, imageUrl for " +
        "one already hosted",
    );
  }
  if (args.devBuyCook != null && args.devBuyPctOfTotalSupply != null) {
    throw new CookieMcpError(
      "pass either devBuyCook or devBuyPctOfTotalSupply, not both",
      "devBuyPctOfTotalSupply prices the share off the live launch curve for you",
    );
  }
  if (args.imageBase64 && !args.imageMimeType) {
    throw new CookieMcpError(
      "imageMimeType is required with imageBase64",
      'e.g. "image/png" or "image/jpeg"',
    );
  }
  // Before any network call or spend: a logo is unfixable after the fact.
  assertLogoDecision(args);
  // Same rule for a dev buy: if we cannot verify a versioned build, say so before pinning metadata
  // and burning a leased mint on a launch that cannot be signed.
  assertDevBuySupported(
    args.devBuyCook != null || args.devBuyPctOfTotalSupply != null,
    LAUNCHPAD_ALT_ADDRESS,
  );

  const cfg = await fetchLaunchpadConfig();
  if (cfg.paused) {
    throw new CookieMcpError(
      "the launchpad is paused — new launches are disabled",
      "retry later; existing pools can still be traded",
    );
  }
  if (cfg.momoReady !== undefined && cfg.momoReady <= 0) {
    throw new CookieMcpError(
      "the launchpad has no pre-ground `momo` mint available right now",
      "every launch mint must end in `momo`; retry in a few minutes while the grinder refills",
    );
  }

  const params = buildCreateParams(args);
  const devBuyRaw =
    args.devBuyPctOfTotalSupply != null
      ? devBuyCookForSupplyPct(cfg, args.devBuyPctOfTotalSupply)
      : args.devBuyCook != null
        ? uiToRaw(args.devBuyCook, COOK_DECIMALS)
        : 0n;

  // Fund the wCOOK the dev-buy leg will spend, BEFORE the logo is pinned and a vanity mint is leased.
  // The launch bundle creates that account but never funds it, so an unfunded wallet would otherwise
  // fail at simulation having already burned a pin and a rate-limited mint.
  let wrapSignature: string | null = null;
  if (devBuyRaw > 0n) {
    wrapSignature = await ensureWrappedCook(getConnection(), signer, devBuyRaw);
  }

  // Pin the logo first and reference its URL from the metadata JSON (never inline the base64 blob).
  let imageUrl: string | undefined;
  if (args.imageUrl) {
    // Re-pin rather than storing the link: the metadata is immutable, so a URL that later rots
    // would leave the token with a dead logo and no way to replace it.
    const remote = await fetchRemoteImage(args.imageUrl);
    imageUrl = await uploadImage(remote.base64, remote.mimeType);
  } else if (args.imagePath) {
    // Read from disk here, not in the tool layer: a bad path must fail before the session and the
    // config call, alongside every other free failure.
    const file = readImageFile(args.imagePath);
    imageUrl = await uploadImage(file.base64, file.mimeType);
  } else if (args.imageBase64) {
    imageUrl = await uploadImage(args.imageBase64, args.imageMimeType!);
  }
  const metadata = buildMetadata(args, imageUrl);

  const built = await withLaunchSession(signer, (session) =>
    buildCreatePoolTx({
      creator,
      params,
      metadata,
      // A dev buy REQUIRES a versioned build: create + buy in one transaction does not fit a legacy
      // 1232-byte tx, and the legacy path refuses it for any real name/symbol ("leaves no room for the
      // metadata link" — momoswap-backend #112/#120). A plain launch stays legacy, which keeps the
      // v0 path off the common case until it has some mileage.
      ...(devBuyRaw > 0n ? { devBuyCook: devBuyRaw.toString(), txVersion: 0 as const } : {}),
      session,
    }),
  );
  const signature = await submitBuilt(built, signer, "launch", undefined, {
    name: args.name,
    symbol: args.symbol,
    mint: built.mint ?? null,
    ...(devBuyRaw > 0n ? { devBuyCook: rawToUi(devBuyRaw, COOK_DECIMALS) } : {}),
  });

  const mint = built.mint ?? null;
  // The pool PDA is keyed by a random pool_id the API picked, so read it back by mint.
  let pool: LaunchpadPool | null = null;
  if (mint) {
    pool = await fetchPoolByMint(mint)
      .then((r) => r.pool)
      .catch(() => null);
  }
  if (!mint) {
    throw new CookieMcpError(
      "the launch was sent but the launchpad did not report the token mint",
      `the transaction ${signature} confirmed — check ${explorerTxUrl(signature)} for the new mint`,
    );
  }

  const notes = [
    "Buyers hold program-tracked curve shares until the pool graduates; the SPL token is claimed " +
      "after graduation (claim_launchpad).",
  ];
  if (devBuyRaw > 0n) {
    notes.push("The dev buy was bundled into the same transaction, so it is the first trade.");
    if (wrapSignature) {
      // A separate, already-confirmed transaction — say so, so the launch signature is not mistaken
      // for the whole spend.
      notes.push(
        `Wrapped ${rawToUi(devBuyRaw, COOK_DECIMALS)} ${COOK_SYMBOL} to fund the dev buy first, in ` +
          `transaction ${wrapSignature}.`,
      );
    }
    // Always state both denominators: "1% of supply" means two different amounts depending on
    // whether it is read against the minted supply or the 80% actually sold on the curve.
    const share = describeDevBuy(cfg, devBuyRaw);
    if (share) notes.push(share);
  }

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    mint,
    pool: pool?.pubkey ?? null,
    name: params.name,
    symbol: params.symbol,
    metadataUri: pool?.uri ?? null,
    costCook: {
      creationFee: rawToUi(cfg.creationFeeLamports, COOK_DECIMALS),
      devBuy: rawToUi(devBuyRaw, COOK_DECIMALS),
      total: rawToUi(BigInt(cfg.creationFeeLamports) + devBuyRaw, COOK_DECIMALS),
    },
    launch: {
      opensAt: new Date((pool?.launchTs ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      endsAt: pool ? new Date(pool.endTs * 1000).toISOString() : null,
      expiryMode: params.expiry_mode,
      // Report what the POOL says, not what we asked for. A bundled dev buy makes the program force
      // anti_snipe off (the dev buy is protected by being atomic and first, and the opening-window cap
      // would otherwise cap the creator's own buy), so echoing the request claims a protection the
      // launch does not have — and the launch is immutable, so the claim can never be corrected.
      antiSnipe: pool?.antiSnipe ?? params.anti_snipe,
    },
    graduationTargetCook: rawToUi(pool?.graduationTarget ?? cfg.graduationTarget, COOK_DECIMALS),
    links: {
      launchpad: pool ? launchpadPoolUrl(pool.pubkey) : null,
      token: launchpadTokenUrl(mint),
    },
    // Only reachable via noLogo: true now, so state it as the settled consequence rather than a
    // reproach — assertLogoDecision already gave the caller the chance to change its mind.
    ...(imageUrl
      ? {}
      : {
          warning:
            "launched with noLogo — most launchpad UIs will show a blank image, and the metadata is " +
            "immutable so this cannot be changed",
        }),
    notes,
  };
}

// --- curve trading ------------------------------------------------------------------------------

/** Guard that a pool is currently tradeable, with a status-specific hint. */
function assertTradeable(pool: LaunchpadPool, action: string): void {
  const phase = poolPhase(pool, nowSeconds());
  if (phase === "live") return;
  const hint =
    phase === "upcoming"
      ? `trading opens at ${new Date(pool.launchTs * 1000).toISOString()}`
      : phase === "graduated"
        ? "the pool graduated — the token trades on the open market now (use get_quote / trade)"
        : phase === "ended"
          ? // On-chain the pool is still `Open`, so buy/sell revert on `now > end_ts` while the claim
            // paths revert on the state — there is nothing to do until someone calls expire_pool.
            `the launch window closed at ${new Date(pool.endTs * 1000).toISOString()} and the pool has not been settled on-chain yet — claims open once it is expired`
          : "the launch expired — use claim_launchpad to settle your position";
  throw new CookieMcpError(`cannot ${action}: the pool is ${phase}`, hint);
}

export interface LaunchpadBuyResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  spent: { amount: string; symbol: string };
  received: { estimate: string; symbol: string; kind: "curve shares" };
  tradeFee: { amount: string; symbol: string; pct: number };
  priceCookPerToken: number;
  graduationProgressPct: number;
  links: { token: string };
  note: string;
}

/**
 * Who to credit with the referral share of this buy's trade fee — pure.
 *
 * An explicit `referrer` argument always wins, and is the only input that can fail: the caller named
 * a wallet, so naming their own is a mistake worth reporting rather than silently dropping (the
 * program rejects it with `SelfReferral`, 6035).
 *
 * The `COOKIE_REFERRER` fallback is held to the opposite standard — it must never be able to break a
 * buy. Empty (opted out), equal to the buyer, or not a pubkey all resolve to "no referrer", which is
 * the pre-existing behaviour: the program folds the share into the treasury. That matters because
 * the fallback is ambient config the person trading may not have set, so a typo in it must cost them
 * nothing more than the referral itself. The buyer-equals-fallback case is a real one, not a corner:
 * it is exactly what happens when the wallet running the server is also the configured referrer.
 */
export function resolveReferrer(
  explicit: string | undefined,
  buyer: string,
  fallback: string,
): string | null {
  if (explicit) {
    if (explicit === buyer) {
      throw new CookieMcpError(
        "self-referral is not allowed",
        "omit referrer, or pass another wallet's address",
      );
    }
    return explicit;
  }
  if (!fallback || fallback === buyer) return null;
  try {
    new PublicKey(fallback);
  } catch {
    return null;
  }
  return fallback;
}

/** Buy on the bonding curve with COOK. The API wraps the COOK and creates any missing accounts. */
export async function launchpadBuy(args: {
  ref: string;
  amountCook: string | number;
  referrer?: string;
}): Promise<LaunchpadBuyResult> {
  const signer = requireSigner();
  const buyer = signer.publicKey.toBase58();

  let paymentRaw: bigint;
  try {
    paymentRaw = uiToRaw(args.amountCook, COOK_DECIMALS);
  } catch {
    throw new CookieMcpError(
      `invalid amountCook "${args.amountCook}"`,
      "pass a positive COOK amount, e.g. 5",
    );
  }
  if (paymentRaw <= 0n) {
    throw new CookieMcpError("amountCook must be greater than 0", "pass a positive COOK amount");
  }
  const referrer = resolveReferrer(args.referrer, buyer, COOKIE_REFERRER);

  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  assertTradeable(pool, "buy");
  if (BigInt(pool.minBuy) > 0n && paymentRaw < BigInt(pool.minBuy)) {
    throw new CookieMcpError(
      `this pool has a minimum buy of ${rawToUi(pool.minBuy, COOK_DECIMALS)} ${COOK_SYMBOL}`,
      "increase the amount",
    );
  }

  const decs = await tokenDecimals(pool, cfg);
  const feeBps = poolTradeFeeBps(pool, cfg);
  const est = estimateBuy(pool, paymentRaw, feeBps);

  const built = await buildBuyTx({
    buyer,
    pool: pool.pubkey,
    paymentAmount: paymentRaw.toString(),
    referrer,
  });
  const signature = await submitBuilt(built, signer, "buy", undefined, {
    ref: args.ref,
    amountCook: String(args.amountCook),
  });

  // Post-trade curve state, so the reported price/progress reflect this buy.
  const after = {
    ...pool,
    paymentRaisedNet: (BigInt(pool.paymentRaisedNet) + est.netRaw).toString(),
    tokensSold: (BigInt(pool.tokensSold) + est.tokensOutRaw).toString(),
  };

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    spent: { amount: rawToUi(paymentRaw, COOK_DECIMALS), symbol: COOK_SYMBOL },
    received: {
      estimate: rawToUi(est.tokensOutRaw, decs),
      symbol: pool.symbol,
      kind: "curve shares",
    },
    tradeFee: {
      amount: rawToUi(est.feeRaw, COOK_DECIMALS),
      symbol: COOK_SYMBOL,
      pct: feeBps / 100,
    },
    priceCookPerToken: spotPriceCook(after, COOK_DECIMALS, decs),
    graduationProgressPct: graduationProgressPct(after.paymentRaisedNet, pool.graduationTarget),
    links: { token: launchpadTokenUrl(pool.tokenMint) },
    note:
      "These are program-tracked curve shares, not SPL tokens — they will not show in get_balance. " +
      "Sell them back to the curve with launchpad_sell, or claim the real token after graduation.",
  };
}

export interface LaunchpadSellResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  sold: { shares: string; symbol: string };
  received: { estimate: string; symbol: string };
  tradeFee: { amount: string; symbol: string; pct: number };
  remainingShares: string;
  links: { token: string };
}

/** Sell curve shares back to the bonding curve for COOK (unwrapped to native COOK by default). */
export async function launchpadSell(args: {
  ref: string;
  shares: string | number;
  unwrap?: boolean;
}): Promise<LaunchpadSellResult> {
  const signer = requireSigner();
  const seller = signer.publicKey.toBase58();

  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  assertTradeable(pool, "sell");
  const decs = await tokenDecimals(pool, cfg);

  let sharesRaw: bigint;
  try {
    sharesRaw = uiToRaw(args.shares, decs);
  } catch {
    throw new CookieMcpError(
      `invalid shares "${args.shares}"`,
      `pass a positive token amount with at most ${decs} decimals`,
    );
  }
  if (sharesRaw <= 0n) {
    throw new CookieMcpError("shares must be greater than 0", "pass a positive token amount");
  }

  const position = await fetchPosition(pool.pubkey, seller);
  if (!position || BigInt(position.shares) <= 0n) {
    throw new CookieMcpError(
      "you have no curve position on this pool",
      "launchpad_sell only sells shares bought on the bonding curve with launchpad_buy",
    );
  }
  if (sharesRaw > BigInt(position.shares)) {
    throw new CookieMcpError(
      `you hold ${rawToUi(position.shares, decs)} ${pool.symbol} shares, less than the ${rawToUi(sharesRaw, decs)} requested`,
      "lower the amount",
    );
  }

  const feeBps = poolTradeFeeBps(pool, cfg);
  const est = estimateSell(pool, sharesRaw, feeBps);

  const built = await buildSellTx({
    seller,
    pool: pool.pubkey,
    tokenShares: sharesRaw.toString(),
    unwrap: args.unwrap ?? true,
  });
  const signature = await submitBuilt(built, signer, "sell", undefined, {
    ref: args.ref,
    shares: String(args.shares),
  });

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    sold: { shares: rawToUi(sharesRaw, decs), symbol: pool.symbol },
    received: { estimate: rawToUi(est.netRaw, COOK_DECIMALS), symbol: COOK_SYMBOL },
    tradeFee: {
      amount: rawToUi(est.feeRaw, COOK_DECIMALS),
      symbol: COOK_SYMBOL,
      pct: feeBps / 100,
    },
    remainingShares: rawToUi(BigInt(position.shares) - sharesRaw, decs),
    links: { token: launchpadTokenUrl(pool.tokenMint) },
  };
}

// --- claims -------------------------------------------------------------------------------------

/**
 * Pick the claim a pool's state calls for (pure):
 * graduated → the real SPL token; expired+fair → pro-rata refund; expired+jackpot/survivor → the
 * Merkle payout. `creator_vest` is never auto-selected — it is the creator's own vesting claim.
 */
export function resolveClaimKind(pool: {
  status: PoolPhase;
  expiryMode: ExpiryMode;
}): ClaimKind | null {
  if (pool.status === "graduated") return "graduated_tokens";
  // `ended` = past end_ts but not yet `Expired` on-chain. `claim_fair` expires the pool itself in that
  // window (audit #2's lazy_expire, lib.rs:566), so a Fair refund is reachable BEFORE settlement — and
  // Fair only: `claim_winner` needs a settlement root, which `set_settlement_root` will only write on an
  // already-`Expired` pool, and Dead has no holder payout at all. On a deployment without lazy_expire the
  // program reverts 6011, which surfaces at simulation before anything is signed — see claimLaunchpad.
  if (pool.status === "ended") return pool.expiryMode === "fair" ? "fair" : null;
  if (pool.status !== "expired") return null;
  if (pool.expiryMode === "fair") return "fair";
  if (pool.expiryMode === "jackpot" || pool.expiryMode === "survivor") return "winner";
  return null; // dead → unraised funds went to the treasury, nothing to claim
}

/**
 * What a Fair-mode refund pays out, in raw payment units: the program's own formula,
 * `mul_div(expiry_liquidity, shares, total_expiry_shares)` (`claim_fair`, lib.rs:579) applied to the
 * snapshot the pool froze when it expired. Floor division, matching `mul_div`.
 *
 * Pure so it can be tested: returns null when there is nothing to compute from — an unexpired pool has
 * a zeroed snapshot, and the program itself rejects a zero claim (`NothingToClaim`).
 */
export function fairRefundRaw(
  pool: { expiryLiquidity: string; totalExpiryShares: string },
  sharesRaw: bigint,
): bigint | null {
  let liquidity: bigint;
  let totalShares: bigint;
  try {
    liquidity = BigInt(pool.expiryLiquidity);
    totalShares = BigInt(pool.totalExpiryShares);
  } catch {
    return null;
  }
  if (sharesRaw <= 0n || totalShares <= 0n || liquidity <= 0n) return null;
  if (sharesRaw > totalShares) return null; // a share of more than the whole snapshot is nonsense
  const refund = (liquidity * sharesRaw) / totalShares;
  return refund > 0n ? refund : null;
}

/**
 * The snapshot a Fair refund is divided out of (pure).
 *
 * An `Expired` pool carries it already. A pool still in the `ended` window has `expiry_liquidity` and
 * `total_expiry_shares` at ZERO — the program only writes them at the expiry transition — so estimating
 * from the pool alone yields nothing exactly when `claim_fair` is about to do the transition itself.
 * `lazy_expire` (lib.rs:2177) sets `expiry_liquidity = payment_vault.amount` and `total_expiry_shares =
 * total_active_shares`, so the pre-image is knowable: pass the vault balance read BEFORE the claim, since
 * the claim drains it. Null when it could not be read — the estimate is best-effort, never load-bearing.
 */
export function fairClaimSnapshot(
  pool: {
    status: PoolPhase;
    expiryLiquidity: string;
    totalExpiryShares: string;
    totalActiveShares: string;
  },
  vaultAmountRaw: bigint | null,
): { expiryLiquidity: string; totalExpiryShares: string } | null {
  if (pool.status !== "ended") return pool;
  if (vaultAmountRaw == null || vaultAmountRaw <= 0n) return null;
  return {
    expiryLiquidity: vaultAmountRaw.toString(),
    totalExpiryShares: pool.totalActiveShares,
  };
}

export interface ClaimLaunchpadResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  kind: ClaimKind;
  claimed: { estimate: string; symbol: string } | null;
  links: { token: string };
  note?: string;
}

/**
 * Claim what a launch owes you: the SPL token after graduation, a Fair-mode refund, a
 * Jackpot/Survivor Merkle payout, or (creators) the vested creator allocation.
 */
export async function claimLaunchpad(args: {
  ref: string;
  kind?: ClaimKind | "auto";
}): Promise<ClaimLaunchpadResult> {
  const signer = requireSigner();
  const claimant = signer.publicKey.toBase58();

  const [cfg, pool] = await Promise.all([fetchLaunchpadConfig(), resolvePool(args.ref)]);
  const decs = await tokenDecimals(pool, cfg);

  const phase = poolPhase(pool, nowSeconds());
  const requested = args.kind && args.kind !== "auto" ? args.kind : null;
  const kind = requested ?? resolveClaimKind({ status: phase, expiryMode: pool.expiryMode });
  if (!kind) {
    throw new CookieMcpError(
      `there is nothing to claim on this pool (status ${phase}${
        phase === "expired" ? `, ${pool.expiryMode} mode` : ""
      })`,
      phase === "live"
        ? "claims open after the pool graduates or expires; sell on the curve to exit now"
        : phase === "ended"
          ? // Trading is closed but the pool is still `Open` on-chain. A Fair refund no longer lands here
            // (claim_fair expires the pool itself), so this is a Dead / Jackpot / Survivor pool, and
            // neither of those can be claimed until the pool is actually `Expired`.
            pool.expiryMode === "dead"
            ? `the launch window closed at ${new Date(pool.endTs * 1000).toISOString()} and this is a Dead-mode expiry — unraised funds are swept to the treasury, so there is no holder payout at any point`
            : `the launch window closed at ${new Date(pool.endTs * 1000).toISOString()} but the pool is not settled on-chain yet — a ${pool.expiryMode} payout needs the pool expired and its settlement root published. Expiry is permissionless and normally happens within seconds; re-read the pool shortly`
          : phase === "upcoming"
            ? "the launch has not opened yet — there is nothing to claim"
            : "Dead-mode expiries sweep unraised funds to the treasury — there is no holder payout",
    );
  }

  // The API pre-validates fair/winner/graduated_tokens against the position, but not creator_vest —
  // that one only fails at the program's `has_one = creator` constraint, which reads as a raw anchor
  // error. Check it here so a non-creator (or a pool with no vest) gets a real explanation.
  if (kind === "creator_vest") {
    if (pool.creator !== claimant) {
      throw new CookieMcpError(
        "only the launch's creator can claim the creator vest",
        `the pool's creator is ${pool.creator}`,
      );
    }
    if (BigInt(pool.creatorVestAmount) <= 0n) {
      throw new CookieMcpError(
        "this pool has no creator vest to claim",
        "the creator allocation is only set aside at graduation — this pool has not graduated",
      );
    }
    if (BigInt(pool.creatorVestClaimed) >= BigInt(pool.creatorVestAmount)) {
      throw new CookieMcpError(
        "the whole creator vest has already been claimed",
        `${rawToUi(pool.creatorVestAmount, decs)} ${pool.symbol} was vested and fully claimed`,
      );
    }
  }

  let amount: string | undefined;
  let proof: number[][] | undefined;
  if (kind === "winner") {
    const win = await fetchWinnerProof(pool.pubkey, claimant);
    if (!win) {
      throw new CookieMcpError(
        "this wallet has no winning allocation in the pool's settlement",
        `${pool.expiryMode} mode pays out only the top wallets, and only once the settlement root is set`,
      );
    }
    amount = win.amount;
    proof = win.proof;
  }

  // A Fair refund has to be measured BEFORE the claim lands: `claim_fair` sets `user.shares = 0`
  // (lib.rs:585), so reading the position afterwards always yields 0. `claim_graduated_tokens` leaves
  // shares in place, which is why that branch can read them after.
  // Same reason the payment vault has to be read first when the pool is not yet settled: the claim both
  // snapshots it and pays out of it, so afterwards it no longer describes what the refund was divided by.
  const [sharesBefore, vaultBefore] = await Promise.all([
    kind === "fair"
      ? fetchPosition(pool.pubkey, claimant)
          .then((p) => (p ? BigInt(p.shares) : null))
          .catch(() => null)
      : Promise.resolve(null),
    kind === "fair" && phase === "ended"
      ? getConnection()
          .getAccountInfo(new PublicKey(pool.paymentVault))
          .then((info) => decodeTokenAmount(info?.data))
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const built = await buildClaimTx({
    kind,
    claimant,
    pool: pool.pubkey,
    ...(amount ? { amount } : {}),
    ...(proof ? { proof } : {}),
  });
  // A Fair claim on an `ended` pool relies on the program expiring it for us (audit #2's lazy_expire).
  // A deployment without that fix reverts `InvalidPoolState` (6011) — and the generic reading of 6011,
  // "the pool has graduated or expired", is exactly backwards here: it has done neither, which is the
  // problem. This lands at SIMULATION, so nothing is signed, sent or spent either way.
  const codeHints =
    phase === "ended" && kind === "fair"
      ? {
          6011: {
            message:
              "the pool has not been settled on-chain yet, and this deployment cannot settle it as part of the claim",
            hint: "expiry is permissionless and normally happens within seconds of the launch window closing — re-read the pool and retry; nothing was sent",
          },
        }
      : undefined;
  const signature = await submitBuilt(built, signer, "claim", codeHints);

  // Report what landed: shares → SPL tokens 1:1 for graduated claims, COOK for payouts. Best-effort —
  // the claim already succeeded, so a failed estimate must never turn into a thrown error.
  let claimed: { estimate: string; symbol: string } | null = null;
  if (kind === "graduated_tokens") {
    const position = await fetchPosition(pool.pubkey, claimant).catch(() => null);
    if (position) claimed = { estimate: rawToUi(position.shares, decs), symbol: pool.symbol };
  } else if (kind === "winner" && amount) {
    claimed = { estimate: rawToUi(amount, COOK_DECIMALS), symbol: COOK_SYMBOL };
  } else if (kind === "fair" && sharesBefore != null) {
    const snapshot = fairClaimSnapshot({ ...pool, status: phase }, vaultBefore);
    const refund = snapshot ? fairRefundRaw(snapshot, sharesBefore) : null;
    if (refund != null) {
      claimed = { estimate: rawToUi(refund, COOK_DECIMALS), symbol: COOK_SYMBOL };
    }
  }

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    kind,
    claimed,
    links: { token: launchpadTokenUrl(pool.tokenMint) },
    ...(kind === "graduated_tokens"
      ? { note: "The SPL token is now in your wallet — trade it with trade / get_quote." }
      : {}),
  };
}

export interface ClaimCreatorFeesResult {
  signature: string;
  explorerUrl: string;
  pool: string;
  mint: string;
  symbol: string;
  claimed: { amount: string; symbol: string };
  links: { token: string };
}

/**
 * Sweep the creator's share of trading fees (35% of the 1% trade fee at time of writing) from a
 * launch you created. Requires the wallet to be the pool's creator; unwraps to native COOK.
 */
export async function claimCreatorFees(args: {
  ref: string;
  unwrap?: boolean;
}): Promise<ClaimCreatorFeesResult> {
  const signer = requireSigner();
  const creator = signer.publicKey.toBase58();

  const pool = await resolvePool(args.ref);
  if (pool.creator !== creator) {
    throw new CookieMcpError(
      "this wallet did not create that launch, so it has no creator fees to claim",
      `the pool's creator is ${pool.creator}`,
    );
  }

  const pending = await fetchPendingCreatorFees(pool.pubkey);
  if (!(pending > 0)) {
    throw new CookieMcpError(
      "no creator fees to claim yet",
      "creator fees accrue as the pool is traded (35% of the trade fee) — check back after some volume",
    );
  }

  const built = await buildClaimCreatorFeesTx({
    creator,
    pool: pool.pubkey,
    unwrap: args.unwrap ?? true,
  });
  const signature = await submitBuilt(built, signer, "creator-fee claim");

  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    pool: pool.pubkey,
    mint: pool.tokenMint,
    symbol: pool.symbol,
    claimed: { amount: String(pending), symbol: COOK_SYMBOL },
    links: { token: launchpadTokenUrl(pool.tokenMint) },
  };
}

export type { ClaimKind, ExpiryMode, PoolStatus, LaunchpadPosition };
