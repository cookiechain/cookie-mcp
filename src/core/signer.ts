// Who signs. Every money-moving flow in this repo is build → verify → simulate → SIGN → send, and until
// 0.5.0 the SIGN step was `tx.sign(keypair)` inlined in a dozen modules. That fused "the process holds
// the key" into the product: hosting cookie-mcp behind a website meant one shared wallet or custody.
//
// `TxSigner` is the seam. `LocalKeypairSigner` is the default and is exactly the old behaviour: the
// key comes from `COOKIE_PRIVATE_KEY` and signing is instant. `ExternalSigner` holds NO key: it knows
// the wallet's public key, and when a flow reaches the SIGN step it stops by throwing
// `SignatureRequired`, which carries the fully verified, simulated, partially co-signed transaction
// bytes plus everything needed to submit them. The caller (a web app with the user's browser wallet, a
// mobile deep link, a hardware signer) signs it and hands it to `submit_signed_tx`. Every guardrail
// that runs BEFORE the SIGN step — instruction decoding, spend refusals, simulation — runs unchanged
// in both modes, which is the whole point.
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import type { ProvidedSignature } from "./context";

/** Where a signed transaction must go. Mirrors the send paths the tools use themselves. */
export type SubmitRoute =
  /** `sendRawTransaction` on the Cookie Chain RPC (the default for everything on Cookie Chain). */
  | { via: "cookie-rpc" }
  /** `sendRawTransaction` on the Solana mainnet RPC (Jupiter swaps, the Solana leg of the bridge). */
  | { via: "solana-rpc" }
  /** Candy Shop's own `/submit-tx` + `/confirm-tx` (Cookiescan-aggregator swaps). */
  | { via: "candyshop"; pools: string[] };

/** What a flow tells the signer about the transaction it is about to sign. */
export interface SignContext {
  /** The action in the agent's words: "trade", "stake", "launch", "domain purchase". */
  what: string;
  /** Blockhash window the tx was built against — needed to confirm it after an external sign. */
  blockhash?: string;
  lastValidBlockHeight?: number;
  submit: SubmitRoute;
  /**
   * "final" (default): this is the transaction the tool exists to send. "intermediate": a
   * prerequisite (wrapping COOK, creating a token account, initialising tick arrays) — after it lands
   * the tool has to be called again with the same arguments to continue.
   */
  step?: "final" | "intermediate";
  /** Agent-facing description of what the transaction does, echoed back in `needs_signature`. */
  summary?: Record<string, unknown>;
}

export type AnyTransaction = Transaction | VersionedTransaction;

export interface TxSigner {
  readonly kind: "local" | "external";
  readonly publicKey: PublicKey;
  /**
   * Add this wallet's signature (in place) and return the same object. Co-signers (ephemeral
   * keypairs, API pre-signatures) must already be applied — an external signer serialises the
   * transaction as-is, so anything missing at this point is missing in what the user signs.
   */
  signTransaction<T extends AnyTransaction>(tx: T, ctx: SignContext): Promise<T>;
  /** ed25519 over the UTF-8 bytes of `message`; returns base58. Used for wallet-login flows. */
  signMessage(message: string, what: string): Promise<string>;
}

/** Signs with a keypair held in memory. The secret is never exposed by this class. */
export class LocalKeypairSigner implements TxSigner {
  readonly kind = "local" as const;
  readonly publicKey: PublicKey;
  readonly #keypair: Keypair;

  constructor(keypair: Keypair) {
    this.#keypair = keypair;
    this.publicKey = keypair.publicKey;
  }

  async signTransaction<T extends AnyTransaction>(tx: T): Promise<T> {
    // Legacy takes a variadic and `partialSign` keeps any co-signatures already present; a
    // VersionedTransaction's `sign` merges into the existing signature slots for the same reason.
    if (tx instanceof VersionedTransaction) tx.sign([this.#keypair]);
    else tx.partialSign(this.#keypair);
    return tx;
  }

  async signMessage(message: string): Promise<string> {
    // `Keypair.secretKey` is the 64-byte expanded form (seed ‖ pubkey); ed25519 signs with the seed.
    const sig = ed25519.sign(
      new TextEncoder().encode(message),
      this.#keypair.secretKey.subarray(0, 32),
    );
    return bs58.encode(sig);
  }

  /** Escape hatch for SDKs that insist on a `Keypair` (none left in product code; kept for scripts). */
  get keypair(): Keypair {
    return this.#keypair;
  }
}

/**
 * Thrown by `ExternalSigner` at the SIGN step. NOT a failure: the flow did everything it could without
 * the key and is handing the result to whoever holds it. The MCP layer turns it into a
 * `{ status: "needs_signature", ... }` tool result (not `isError`).
 */
export class SignatureRequired extends Error {
  readonly payload: NeedsSignature;
  constructor(payload: NeedsSignature) {
    super(`signature required: ${payload.what}`);
    this.name = "SignatureRequired";
    this.payload = payload;
  }
}

export type NeedsSignature =
  | {
      kind: "transaction";
      what: string;
      /** The wallet that must sign (the fee payer). */
      signer: string;
      /** Verified + simulated transaction, co-signatures applied, ours missing. base64. */
      transactionBase64: string;
      /** "legacy" or "v0" — tells a wallet adapter which deserialiser to use. */
      version: "legacy" | "v0";
      blockhash?: string;
      lastValidBlockHeight?: number;
      submit: SubmitRoute;
      step: "final" | "intermediate";
      summary?: Record<string, unknown>;
      next: string;
    }
  | {
      kind: "message";
      what: string;
      signer: string;
      /** Exact UTF-8 text to sign (ed25519, as wallet `signMessage` does). */
      message: string;
      next: string;
    };

/** Serialise a transaction that still lacks our signature (web3.js refuses by default). */
export function serializeUnsigned(tx: AnyTransaction): {
  base64: string;
  version: "legacy" | "v0";
} {
  if (tx instanceof VersionedTransaction) {
    return { base64: Buffer.from(tx.serialize()).toString("base64"), version: "v0" };
  }
  return {
    base64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    version: "legacy",
  };
}

/**
 * Holds only a public key. Signing a transaction stops the flow with `SignatureRequired`; signing a
 * message first looks for a signature the caller supplied for that exact text (see
 * `withProvidedSignatures`) and otherwise stops the same way.
 */
export class ExternalSigner implements TxSigner {
  readonly kind = "external" as const;
  readonly publicKey: PublicKey;
  readonly #provided: ProvidedSignature[];

  constructor(publicKey: PublicKey, provided: ProvidedSignature[] = []) {
    this.publicKey = publicKey;
    this.#provided = provided;
  }

  async signTransaction<T extends AnyTransaction>(tx: T, ctx: SignContext): Promise<T> {
    const { base64, version } = serializeUnsigned(tx);
    const step = ctx.step ?? "final";
    throw new SignatureRequired({
      kind: "transaction",
      what: ctx.what,
      signer: this.publicKey.toBase58(),
      transactionBase64: base64,
      version,
      ...(ctx.blockhash ? { blockhash: ctx.blockhash } : {}),
      ...(ctx.lastValidBlockHeight ? { lastValidBlockHeight: ctx.lastValidBlockHeight } : {}),
      submit: ctx.submit,
      step,
      ...(ctx.summary ? { summary: ctx.summary } : {}),
      next:
        `sign transactionBase64 with wallet ${this.publicKey.toBase58()} (do not modify it — it is ` +
        `already verified, simulated and co-signed), then call submit_signed_tx with the signed ` +
        `bytes and the same submit/blockhash/lastValidBlockHeight fields` +
        (step === "intermediate"
          ? `. This is a prerequisite step: once it confirms, call the same tool again with the same ` +
            `arguments to continue.`
          : `.`),
    });
  }

  async signMessage(message: string, what: string): Promise<string> {
    const hit = this.#provided.find((p) => p.message === message);
    if (hit) {
      // Reject a wrong signature here, with a clear message, instead of letting the API 401.
      let ok = false;
      try {
        ok = ed25519.verify(
          bs58.decode(hit.signature),
          new TextEncoder().encode(message),
          this.publicKey.toBytes(),
        );
      } catch {
        ok = false;
      }
      if (!ok) {
        throw new SignatureRequired({
          kind: "message",
          what,
          signer: this.publicKey.toBase58(),
          message,
          next:
            `the supplied signature does not verify for wallet ${this.publicKey.toBase58()} over ` +
            `this exact message — sign it again with that wallet (signMessage, UTF-8 bytes) and ` +
            `pass { message, signature } back.`,
        });
      }
      return hit.signature;
    }
    throw new SignatureRequired({
      kind: "message",
      what,
      signer: this.publicKey.toBase58(),
      message,
      next:
        `sign this exact message with wallet ${this.publicKey.toBase58()} (wallet signMessage over ` +
        `the UTF-8 bytes; base58 the 64-byte signature), then call the same tool again with the ` +
        `same arguments plus loginSignature: { message, signature }. Nothing was sent or spent.`,
    });
  }
}

/** Sign with any co-signers first, then the wallet — the order every flow in this repo needs. */
export async function signWithCosigners<T extends AnyTransaction>(
  signer: TxSigner,
  tx: T,
  cosigners: Keypair[],
  ctx: SignContext,
): Promise<T> {
  if (cosigners.length) {
    if (tx instanceof VersionedTransaction) tx.sign(cosigners);
    else tx.partialSign(...cosigners);
  }
  return signer.signTransaction(tx, ctx);
}

/** Minimal Anchor-style wallet over a `TxSigner`, for SDKs that want `AnchorProvider`'s wallet. */
export function anchorWalletFor(signer: TxSigner, ctx: SignContext) {
  return {
    publicKey: signer.publicKey,
    signTransaction: <T extends AnyTransaction>(tx: T) => signer.signTransaction(tx, ctx),
    signAllTransactions: async <T extends AnyTransaction>(txs: T[]) => {
      for (const tx of txs) await signer.signTransaction(tx, ctx);
      return txs;
    },
  };
}
