// Per-request context. In a hosted (HTTP) deployment one server process serves many wallets, so
// "whose wallet is this" can no longer be a process-global read from the environment. The HTTP
// transport runs each request inside `runWithRequestContext`, and everything downstream — signer
// resolution, pre-supplied message signatures — reads it through `requestContext()`.
//
// On stdio there is exactly one user, so the context is usually empty and the env fallbacks in
// `wallet.ts` apply. The store is `AsyncLocalStorage`, which follows the promise chain of the request
// without threading a parameter through 50 tool handlers.
import { AsyncLocalStorage } from "node:async_hooks";

/** A signature the caller already obtained from the wallet and hands back to us (see `TxSigner`). */
export interface ProvidedSignature {
  /** The exact message text that was signed (UTF-8). */
  message: string;
  /** base58 ed25519 signature over that message. */
  signature: string;
}

export interface RequestContext {
  /** Wallet (base58) the external signer acts for. From the `x-cookie-wallet` header over HTTP. */
  wallet?: string;
  /** Message signatures supplied with the request, matched by exact message text. */
  providedSignatures?: ProvidedSignature[];
}

const store = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

export function requestContext(): RequestContext | undefined {
  return store.getStore();
}

/**
 * Run `fn` with extra pre-supplied signatures visible to the signer. Used by tools that accept a
 * `loginSignature`-style argument: the first call reports which message to sign, the second call
 * carries the answer.
 */
export function withProvidedSignatures<T>(
  sigs: ProvidedSignature[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sigs?.length) return fn();
  const current = store.getStore() ?? {};
  return store.run(
    { ...current, providedSignatures: [...(current.providedSignatures ?? []), ...sigs] },
    fn,
  );
}
