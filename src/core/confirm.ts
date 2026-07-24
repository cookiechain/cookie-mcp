// Confirming is the one step where "it failed" is the most dangerous thing we can say: by then the
// transaction is already broadcast. `confirmTransaction` rejects when the blockhash window elapses
// before the tx is seen — on Cookie Chain that happens when finalization stalls, which is a documented
// failure mode of this fork, NOT proof the transaction was dropped. It can still land afterwards.
//
// A raw `TransactionExpiredBlockheightExceededError` reads like any other failure, so an agent will
// retry — and a retried stake / transfer / launch / bridge is a second, real transaction. Every send
// path therefore funnels its confirm through here, so the error carries the signature, a link, and an
// explicit "do not retry blindly".
import type { Connection } from "@solana/web3.js";

import { explorerTxUrl } from "./config";
import { CookieMcpError } from "./errors";

/** The signature is confirmed, or the caller learns exactly what is in flight. */
export interface SentTx {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * The error for "sent but not confirmed in time" (pure). `what` names the action in the agent's terms
 * ("stake", "transfer", "bridge") so the warning is unambiguous about what might have happened twice.
 */
export function unconfirmedError(
  what: string,
  signature: string,
  opts?: { explorerUrl?: string; detail?: string },
): CookieMcpError {
  const url = opts?.explorerUrl ?? explorerTxUrl(signature);
  const detail = opts?.detail ? `: ${opts.detail}` : "";
  return new CookieMcpError(
    `the ${what} transaction was sent (${signature}) but could not be confirmed in time${detail}`,
    `DO NOT retry blindly — it may still land. Check ${url} first; if it succeeded, the ${what} ` +
      `already happened. Cookie Chain finalization stalls can delay confirmation (see chain_health).`,
  );
}

/**
 * Await confirmation of an already-sent transaction, converting a timeout into an actionable error.
 * Returns the signature so call sites can stay one-liners.
 */
export async function confirmSent(
  conn: Connection,
  sent: SentTx,
  what: string,
  opts?: { explorerUrl?: string },
): Promise<string> {
  try {
    await conn.confirmTransaction(
      {
        signature: sent.signature,
        blockhash: sent.blockhash,
        lastValidBlockHeight: sent.lastValidBlockHeight,
      },
      "confirmed",
    );
  } catch (e) {
    throw unconfirmedError(what, sent.signature, {
      ...opts,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  return sent.signature;
}
