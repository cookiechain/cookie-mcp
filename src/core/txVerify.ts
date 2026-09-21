// Verifying an UNSIGNED transaction that the Cookiebox aggregator built for us, before we sign it.
//
// Both escrow flows here work the same way (see `limitOrders.ts`): the aggregator compiles the
// transaction with the very builders its own Trade page uses and pre-signs the throwaway `base`
// keypair; we decode every instruction and refuse on any mismatch. The program-specific checks
// (which instruction, which args, which pinned accounts) live in each flow's module — what is
// shared, and lives here, is the surrounding housekeeping: known programs only, our wallet as fee
// payer, no address lookup table, and every System / Token / ATA instruction moving value only
// between accounts we own.
//
// A second copy of this, one program over, is exactly the drift that hides a money bug — the same
// reason `server/agg/dca.ts` in cookiebox reuses its limit-order plumbing rather than forking it.
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

import { COOK_MINT } from "./config";
import { CookieMcpError } from "./errors";

export interface DecodedIx {
  programId: PublicKey;
  keys: PublicKey[];
  data: Buffer;
}

/** Refuses a build with a message naming the flow — thrown before anything is signed. */
export type Refuse = (what: string) => CookieMcpError;

export function refuser(what: string): Refuse {
  return (detail: string) =>
    new CookieMcpError(
      `the aggregator's ${what} build did not match the request (${detail}) — refused before signing`,
      "nothing was signed or sent; retry, and report this if it persists",
    );
}

export function same(a: PublicKey, b: PublicKey): boolean {
  return a.equals(b);
}

/** Programs an escrow build may invoke: the escrow program itself plus plain housekeeping. */
export function housekeepingPrograms(programId: PublicKey): ReadonlySet<string> {
  return new Set([
    programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
    SystemProgram.programId.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  ]);
}

// SPL Token instruction tags these flows may legitimately contain.
export const TOKEN_IX_TRANSFER = 3;
export const TOKEN_IX_CLOSE_ACCOUNT = 9;
export const TOKEN_IX_SYNC_NATIVE = 17;
export const TOKEN_IX_INITIALIZE_ACCOUNT3 = 18;

/**
 * Flatten a v0 message into plain instructions. Refuses lookup tables: the builds are compiled
 * inline (`fitsInline`), and a table would let the builder repoint accounts we cannot see.
 */
export function decodeMessageIxs(tx: VersionedTransaction, what = "limit-order"): DecodedIx[] {
  const msg = tx.message as MessageV0;
  if (msg.version !== 0) {
    throw new CookieMcpError("unexpected legacy transaction from the aggregator", "retry");
  }
  if (msg.addressTableLookups.length > 0) {
    throw new CookieMcpError(
      `the ${what} build uses an address lookup table — refused before signing`,
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

/**
 * Known programs only, and every System / Token / ATA instruction moving value only between our
 * own accounts (wrap into our wCOOK ATA, create our ATAs, unwrap via a pre-signed temp that closes
 * to us).
 */
export function assertHousekeepingIxs(
  ixs: DecodedIx[],
  owner: PublicKey,
  /** Throwaway accounts this flow may create/close: the pre-signed unwrap temp. */
  allowedTemps: PublicKey[],
  opts: {
    allowedPrograms: ReadonlySet<string>;
    refuse: Refuse;
    /** Exact instruction shapes outside `allowedPrograms` this flow may carry (curve opt-in). */
    extraAllowed?: Array<(ix: DecodedIx) => boolean>;
  },
) {
  const { allowedPrograms, refuse, extraAllowed = [] } = opts;
  const wcookAta = getAssociatedTokenAddressSync(new PublicKey(COOK_MINT), owner, true);
  const isOurs = (k: PublicKey) => same(k, owner) || allowedTemps.some((t) => same(t, k));
  for (const ix of ixs) {
    const pid = ix.programId.toBase58();
    if (!allowedPrograms.has(pid)) {
      if (extraAllowed.some((ok) => ok(ix))) continue;
      throw refuse(`instruction for unexpected program ${pid}`);
    }
    if (same(ix.programId, SystemProgram.programId)) {
      const legacy = {
        programId: ix.programId,
        data: ix.data,
        keys: ix.keys.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })),
      };
      const type = SystemInstruction.decodeInstructionType(legacy);
      if (type === "Transfer") {
        const t = SystemInstruction.decodeTransfer(legacy);
        // The only lamport transfer these flows make is the wrap into our own wCOOK ATA.
        if (!same(t.fromPubkey, owner) || !same(t.toPubkey, wcookAta)) {
          throw refuse("a lamport transfer not into our own wCOOK account");
        }
      } else if (type === "Create") {
        const c = SystemInstruction.decodeCreateAccount(legacy);
        // A partial unwrap funds a throwaway native token account we hold the key to.
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
export function otherSignersPresigned(
  tx: VersionedTransaction,
  owner: PublicKey,
  refuse: Refuse,
): PublicKey[] {
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
