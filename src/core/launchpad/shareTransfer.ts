// Sending curve shares to another wallet — the launchpad's `transfer_shares` (`transfer.rs`).
//
// Pre-graduation holdings are `UserPosition` shares, not tokens, so `transfer` cannot move them; this
// instruction moves shares (and the pro-rata cost basis that goes with them) from the sender's position
// into the recipient's, creating it — at the sender's expense — when the recipient has none.
//
// The launchpad API builds it, but the spend guard cannot protect this one: shares are program state,
// not a token balance, so a build that sent MORE shares, or sent them to SOMEONE ELSE, would simulate
// and pass the native-value check just the same. So the build is held instruction by instruction to
// what the program needs (`verifyTransferSharesTx`), and the program's refusals are checked here first
// (`transferSharesRefusal`, after momoswap-backend `share-transfer.ts`) so an agent gets the reason
// before any build — and a never-used recipient, the one mistake the program cannot catch, is refused
// unless the caller opts in.
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { CookieMcpError } from "../errors";
import { userPositionPda } from "./positions";

/** Anchor discriminator of `transfer_shares` (sha256("global:transfer_shares")[..8], = the IDL's). */
export const TRANSFER_SHARES_DISCRIMINATOR = Buffer.from([23, 136, 140, 15, 181, 54, 120, 175]);

/** The program's anti-snipe window (`ANTI_SNIPE_WINDOW_SECS`): no transfers inside it. */
export const ANTI_SNIPE_WINDOW_SECS = 60;

export function launchpadConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

/** `transfer_shares(shares)` instruction data: discriminator ‖ u64 LE (pure). */
export function encodeTransferSharesData(shares: bigint): Buffer {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(shares);
  return Buffer.concat([TRANSFER_SHARES_DISCRIMINATOR, amount]);
}

/** The accounts `TransferShares` takes, in the program's order (pure). */
export function transferSharesAccounts(a: {
  programId: PublicKey;
  sender: PublicKey;
  recipient: PublicKey;
  pool: PublicKey;
}): PublicKey[] {
  return [
    a.sender,
    a.recipient,
    launchpadConfigPda(a.programId),
    a.pool,
    userPositionPda(a.pool, a.sender, a.programId),
    userPositionPda(a.pool, a.recipient, a.programId),
    SystemProgram.programId,
  ];
}

/**
 * Refuse an API-built transfer that is not exactly the one requested (pure): our wallet pays; there is
 * one launchpad instruction, `transfer_shares` of exactly `shares`, over exactly the expected accounts
 * with only the sender signing; and anything else is a compute-budget instruction. Returns null when
 * it holds, else what is wrong.
 */
export function verifyTransferSharesTx(
  tx: Transaction,
  want: {
    programId: PublicKey;
    sender: PublicKey;
    recipient: PublicKey;
    pool: PublicKey;
    shares: bigint;
  },
): string | null {
  if (!tx.feePayer?.equals(want.sender)) return "it is not paid by this wallet";
  const launch = tx.instructions.filter((ix) => ix.programId.equals(want.programId));
  const other = tx.instructions.filter(
    (ix) =>
      !ix.programId.equals(want.programId) && !ix.programId.equals(ComputeBudgetProgram.programId),
  );
  if (other.length) {
    return `it also calls ${other.map((ix) => ix.programId.toBase58()).join(", ")}`;
  }
  if (launch.length !== 1) return `it has ${launch.length} launchpad instructions, not one`;
  const ix = launch[0]!;
  if (!ix.data.equals(encodeTransferSharesData(want.shares))) {
    return "its launchpad instruction is not a transfer of exactly the shares requested";
  }
  const expected = transferSharesAccounts(want);
  if (
    ix.keys.length !== expected.length ||
    ix.keys.some((k, i) => !k.pubkey.equals(expected[i]!))
  ) {
    return "it moves the shares between other accounts than this wallet's and the recipient's positions";
  }
  if (ix.keys.some((k, i) => k.isSigner !== (i === 0))) return "it asks for an unexpected signer";
  return null;
}

/** Why the program would refuse this transfer, as an actionable error — or null (pure). */
export function transferSharesRefusal(s: {
  now: number;
  launchTs: number;
  endTs: number;
  antiSnipe: boolean;
  senderShares: bigint;
  shares: bigint;
  /** The recipient's account: null = never used (no lamports), else its owner + executable flag. */
  recipientAccount: { owner: PublicKey; executable: boolean } | null;
  recipientOnCurve: boolean;
  recipientHasPosition: boolean;
  /** Fewest shares a transfer that creates the recipient's position may move; null = no minimum. */
  newHolderMinShares: bigint | null;
  allowUnusedRecipient: boolean;
  fmt: (raw: bigint) => string;
}): CookieMcpError | null {
  if (s.now < s.launchTs || s.now > s.endTs) {
    return new CookieMcpError(
      "shares can only be sent while the launch is live",
      s.now < s.launchTs ? "the launch has not opened yet" : "the launch window has closed",
    );
  }
  if (s.antiSnipe && s.now < s.launchTs + ANTI_SNIPE_WINDOW_SECS) {
    return new CookieMcpError(
      "shares cannot be sent during the launch's first minute (anti-snipe window)",
      `retry after ${new Date((s.launchTs + ANTI_SNIPE_WINDOW_SECS) * 1000).toISOString()}`,
    );
  }
  if (s.shares > s.senderShares) {
    return new CookieMcpError(
      `you hold ${s.fmt(s.senderShares)} shares in this launch, less than the ${s.fmt(s.shares)} requested`,
      s.senderShares > 0n ? "lower the amount" : "buy on the curve first with launchpad_buy",
    );
  }
  const acct = s.recipientAccount;
  if (acct && (!acct.owner.equals(SystemProgram.programId) || acct.executable)) {
    return new CookieMcpError(
      "that address cannot receive shares: it is a program or a program-owned account, not a wallet",
      "send to a wallet address (or a .cook name)",
    );
  }
  if (!acct && !s.recipientOnCurve) {
    return new CookieMcpError(
      "that address cannot receive shares: nobody holds a key for it",
      "send to a wallet address (or a .cook name)",
    );
  }
  if (!acct && !s.allowUnusedRecipient) {
    return new CookieMcpError(
      "that recipient has never been used on Cookie Chain — a mistyped address looks exactly like this, " +
        "and shares sent to it can never come back",
      "check the address; if it is right (a brand-new wallet), call again with allowUnusedRecipient: true",
    );
  }
  if (!s.recipientHasPosition && s.newHolderMinShares !== null && s.shares < s.newHolderMinShares) {
    return new CookieMcpError(
      `a first send to a wallet with no position in this launch must be at least a minimum buy's worth: ${s.fmt(s.newHolderMinShares)} shares at the current price`,
      `send at least ${s.fmt(s.newHolderMinShares)}`,
    );
  }
  return null;
}
