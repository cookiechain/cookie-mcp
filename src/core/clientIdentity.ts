// Who is calling, as the venues see it. Every outbound HTTP request (venue APIs, the RPC) carries a
// `User-Agent` of the form `cookie-mcp/<version> (<transport>; <signer>[; app=<id>])`, and the same
// string in `X-Cookie-Client` where a custom header is safe to send. That is the Sentry-SDK model:
// an operator who runs a venue can attribute traffic to cookie-mcp, to a version, and — when the
// integrator sets `COOKIE_APP_ID` (or sends `x-cookie-app` per request over HTTP) — to a named app.
// It is attribution, not proof: a fork can send anything. It is also not telemetry: nothing is sent
// that was not being sent already, there is no extra request, and no wallet data is included.
import { COOKIE_APP_ID } from "./config";
import { requestContext } from "./context";
import { signerMode } from "./wallet";
import { VERSION } from "../version";

export type ClientTransport = "stdio" | "http" | "library";

export interface ClientIdentity {
  product: "cookie-mcp";
  version: string;
  transport: ClientTransport;
  signer: "local" | "external";
  /** Integrator-chosen app id, already sanitised; absent when none is set. */
  app?: string;
  /** The `User-Agent` string the venues receive. */
  userAgent: string;
}

/** Header name an HTTP caller uses to name its app for one request (beats `COOKIE_APP_ID`). */
export const APP_HEADER = "x-cookie-app";
export const CLIENT_HEADER = "X-Cookie-Client";
export const MAX_APP_ID_LENGTH = 64;

// A token that survives a header and a log line unambiguously: no spaces, parens, semicolons or
// control characters, so the `(…; app=…)` comment stays parseable by a plain regex.
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/**
 * An app id as it may be sent: trimmed, header-safe, at most `MAX_APP_ID_LENGTH` chars — or
 * undefined when the input is empty or would not survive the trip. Pure.
 */
export function sanitizeAppId(raw: string | undefined | null): string | undefined {
  const v = raw?.trim();
  if (!v || v.length > MAX_APP_ID_LENGTH || !APP_ID_RE.test(v)) return undefined;
  return v;
}

// The process knows which transport it serves only once `main()` has chosen; a library import
// never calls this and reports "library".
let _transport: ClientTransport = "library";

export function setClientTransport(t: ClientTransport): void {
  _transport = t;
}

/** Pure: the identity string for the given parts. */
export function formatUserAgent(parts: {
  version: string;
  transport: ClientTransport;
  signer: "local" | "external";
  app?: string;
}): string {
  const comment = [parts.transport, parts.signer, ...(parts.app ? [`app=${parts.app}`] : [])];
  return `cookie-mcp/${parts.version} (${comment.join("; ")})`;
}

export function clientIdentity(): ClientIdentity {
  const app = sanitizeAppId(requestContext()?.app) ?? sanitizeAppId(COOKIE_APP_ID);
  const parts = {
    version: VERSION,
    transport: _transport,
    signer: signerMode(),
    ...(app ? { app } : {}),
  };
  return { product: "cookie-mcp", ...parts, userAgent: formatUserAgent(parts) };
}

/**
 * Headers to attach to an outbound request. `User-Agent` always: browsers drop it silently and it
 * never changes CORS. `X-Cookie-Client` only outside a browser, because a custom header turns a
 * simple cross-origin request into a preflighted one, and a third-party venue may not allow it.
 */
export function clientHeaders(): Record<string, string> {
  const ua = clientIdentity().userAgent;
  const inBrowser = typeof (globalThis as { document?: unknown }).document !== "undefined";
  return inBrowser ? { "User-Agent": ua } : { "User-Agent": ua, [CLIENT_HEADER]: ua };
}

/** Test hook. */
export function _resetClientTransport(): void {
  _transport = "library";
}
