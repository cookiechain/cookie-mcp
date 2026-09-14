// The second half of an externally signed flow. A money tool running with an external signer stops at
// `needs_signature` and hands out a verified transaction; the holder of the key signs it and brings it
// here. This module only sends and confirms — it never builds, so a caller cannot make it sign for
// anything the tools did not prepare, and it refuses bytes that still lack a signature.
import { Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";

import { messageIdFromLogs } from "./bridge";
import { confirmTx, submitSignedTx } from "./candyshop";
import { confirmSent } from "./confirm";
import { explorerTxUrl, solanaExplorerTxUrl } from "./config";
import { CookieMcpError } from "./errors";
import { getConnection, getSolanaConnection } from "./rpc";
import type { AnyTransaction, SubmitRoute } from "./signer";

export interface SubmitSignedArgs {
  signedTransactionBase64: string;
  submit?: SubmitRoute;
  blockhash?: string;
  lastValidBlockHeight?: number;
  /** The action, for the "sent but unconfirmed" warning; echo `what` from `needs_signature`. */
  what?: string;
}

export interface SubmitSignedResult {
  signature: string;
  confirmed: boolean;
  explorerUrl: string;
  submittedVia: SubmitRoute["via"];
  /** Present for a Hyperlane bridge dispatch — feed it to `bridge_status`. */
  messageId?: string | null;
  warning?: string;
}

function deserialize(base64: string): AnyTransaction {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new CookieMcpError(
      "signedTransactionBase64 is not valid base64",
      "pass the bytes as base64",
    );
  }
  if (!bytes.length) {
    throw new CookieMcpError(
      "signedTransactionBase64 is empty",
      "pass the signed transaction bytes",
    );
  }
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    try {
      return Transaction.from(bytes);
    } catch {
      throw new CookieMcpError(
        "could not deserialize the signed transaction",
        "pass the exact bytes the wallet returned, base64-encoded, without re-encoding the message",
      );
    }
  }
}

/** Every signer slot must carry a signature; a wallet that dropped a co-signature shows up here. */
export function assertFullySigned(tx: AnyTransaction): void {
  if (tx instanceof VersionedTransaction) {
    const need = tx.message.header.numRequiredSignatures;
    const missing = tx.signatures
      .slice(0, need)
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.every((b) => b === 0))
      .map(({ i }) => tx.message.staticAccountKeys[i]!.toBase58());
    if (missing.length) {
      throw new CookieMcpError(
        `the transaction is missing signatures for ${missing.join(", ")}`,
        "the wallet must sign without dropping the co-signatures already present; nothing was sent",
      );
    }
    return;
  }
  const missing = tx.signatures.filter((s) => !s.signature).map((s) => s.publicKey.toBase58());
  if (missing.length) {
    throw new CookieMcpError(
      `the transaction is missing signatures for ${missing.join(", ")}`,
      "the wallet must sign without dropping the co-signatures already present; nothing was sent",
    );
  }
  if (!tx.verifySignatures(false)) {
    throw new CookieMcpError(
      "a signature on the transaction does not verify",
      "sign the exact bytes from needs_signature — any change to the message invalidates them",
    );
  }
}

function recentBlockhashOf(tx: AnyTransaction): string | undefined {
  return tx instanceof VersionedTransaction ? tx.message.recentBlockhash : tx.recentBlockhash;
}

async function sendOnRpc(
  conn: Connection,
  tx: AnyTransaction,
  raw: Buffer,
  args: SubmitSignedArgs,
  explorer: (sig: string) => string,
): Promise<{ signature: string; confirmed: boolean }> {
  const signature = await conn.sendRawTransaction(raw);
  const blockhash = args.blockhash ?? recentBlockhashOf(tx);
  // Without the build's own height we take the current one: a slightly LONGER window than the tx
  // really has, so a timeout still means "unknown", never a false "failed".
  const lastValidBlockHeight =
    args.lastValidBlockHeight ?? (await conn.getLatestBlockhash("confirmed")).lastValidBlockHeight;
  if (!blockhash) {
    return { signature, confirmed: false };
  }
  await confirmSent(
    conn,
    { signature, blockhash, lastValidBlockHeight },
    args.what ?? "transaction",
    { explorerUrl: explorer(signature) },
  );
  return { signature, confirmed: true };
}

/**
 * Send a transaction that a wallet signed after `needs_signature`, on the route the preparing tool
 * named, and confirm it the same way that tool would have.
 */
export async function submitSignedTransaction(args: SubmitSignedArgs): Promise<SubmitSignedResult> {
  const tx = deserialize(args.signedTransactionBase64);
  assertFullySigned(tx);
  const raw = Buffer.from(tx.serialize());
  const route: SubmitRoute = args.submit ?? { via: "cookie-rpc" };

  if (route.via === "candyshop") {
    const submitted = await submitSignedTx(raw.toString("base64"));
    let confirmed = submitted.confirmed;
    if (!confirmed) {
      try {
        confirmed = (await confirmTx(submitted.signature, route.pools ?? [])).confirmed;
      } catch {
        /* leave as reported by submit */
      }
    }
    return {
      signature: submitted.signature,
      confirmed,
      explorerUrl: explorerTxUrl(submitted.signature),
      submittedVia: "candyshop",
      ...(confirmed ? {} : { warning: unconfirmedWarning(submitted.signature, explorerTxUrl) }),
    };
  }

  const solana = route.via === "solana-rpc";
  const conn = solana ? getSolanaConnection() : getConnection();
  const explorer = solana ? solanaExplorerTxUrl : explorerTxUrl;
  const { signature, confirmed } = await sendOnRpc(conn, tx, raw, args, explorer);

  let messageId: string | null | undefined;
  if (args.what === "bridge" && confirmed) {
    messageId = await bridgeMessageId(conn, signature);
  }
  return {
    signature,
    confirmed,
    explorerUrl: explorer(signature),
    submittedVia: route.via,
    ...(messageId !== undefined ? { messageId } : {}),
    ...(confirmed ? {} : { warning: unconfirmedWarning(signature, explorer) }),
  };
}

function unconfirmedWarning(signature: string, explorer: (s: string) => string): string {
  return (
    `submitted but not confirmed yet — DO NOT sign and submit again blindly, it may still land. ` +
    `Check ${explorer(signature)} first.`
  );
}

/** Hyperlane message id from a dispatch tx's logs; `getTransaction` can lag confirmation, so retry. */
async function bridgeMessageId(conn: Connection, signature: string): Promise<string | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2_500));
    try {
      const confirmed = await conn.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const id = messageIdFromLogs(confirmed?.meta?.logMessages);
      if (id) return id;
    } catch {
      /* retry */
    }
  }
  return null;
}
