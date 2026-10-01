// Streamable HTTP transport for hosted deployments. Stateless: every POST gets a fresh server +
// transport, so nothing about one caller leaks into another's request, and the wallet a request acts
// for (`x-cookie-wallet`) is scoped to that request through `runWithRequestContext`. Registering the
// tool set per request costs a few milliseconds; the RPC calls the tools make dwarf it.
//
// Intended pairing: COOKIE_SIGNER=external. The process holds no key; a web app passes the connected
// wallet's address in the header, receives `needs_signature` results, signs in the browser wallet and
// calls `submit_signed_tx`.
//
// A loopback bind is NOT private against a browser: any page the operator visits can POST to
// 127.0.0.1, and a DNS-rebinding page is even same-origin. So every MCP request passes three gates
// before a server is created for it (`checkRequest`):
//   - Host must be one this server answers to (loopback names for a loopback bind, else
//     COOKIE_MCP_ALLOWED_HOSTS) — this is what defeats DNS rebinding;
//   - a browser request (one with an Origin header) is refused unless its origin is allowed by
//     COOKIE_MCP_CORS_ORIGIN. Unset, that is any origin when the process holds no key (external
//     signer: a page can only obtain unsigned builds the user's wallet must still approve) and NO
//     origin when it holds a local key, where a page could spend;
//   - with COOKIE_MCP_HTTP_TOKEN set, `Authorization: Bearer <token>` is required.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { APP_HEADER } from "../core/clientIdentity";
import { runWithRequestContext } from "../core/context";
import { VERSION } from "../version";

export const WALLET_HEADER = "x-cookie-wallet";

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** What a request must satisfy before it reaches the tools. Resolved once, at startup. */
export interface HttpSecurity {
  /** `host[:port]` values (lower-case) the Host header may carry; null = any (operator's choice). */
  allowedHosts: ReadonlySet<string> | null;
  /** Browser origins allowed to call; `"*"` only when the operator set it explicitly. */
  allowedOrigins: ReadonlySet<string> | "*";
  /** Bearer token required on the MCP endpoint, or null. */
  token: string | null;
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** True when this process signs with its own key (same rule as `signerMode()` + the key). */
export function holdsLocalKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COOKIE_SIGNER?.trim().toLowerCase() !== "external" && !!env.COOKIE_PRIVATE_KEY?.trim();
}

/** True for an address that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The gates for a server bound to `host:port` (pure — `env` is passed in for tests).
 *
 * - `COOKIE_MCP_ALLOWED_HOSTS` (comma-separated `host` or `host:port`) wins when set. Otherwise a
 *   loopback bind answers only to loopback names on its own port; a public bind has no Host check
 *   (it sits behind whatever hostname the operator gave it — set the variable to pin it).
 * - `COOKIE_MCP_CORS_ORIGIN` (comma-separated origins, or `*`) lists the browser origins allowed.
 *   Unset: `*` without a key in the process, none with a local key (see the file comment).
 */
export function resolveHttpSecurity(
  bind: { host: string; port: number },
  env: NodeJS.ProcessEnv = process.env,
): HttpSecurity {
  const configuredHosts = list(env.COOKIE_MCP_ALLOWED_HOSTS).map((h) => h.toLowerCase());
  let allowedHosts: Set<string> | null = null;
  if (configuredHosts.length > 0) {
    allowedHosts = new Set(configuredHosts);
  } else if (isLoopbackHost(bind.host)) {
    allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"].map((h) => `${h}:${bind.port}`));
    const bound = bind.host.includes(":") ? `[${bind.host.replace(/^\[|\]$/g, "")}]` : bind.host;
    allowedHosts.add(`${bound.toLowerCase()}:${bind.port}`);
  }
  const origins = list(env.COOKIE_MCP_CORS_ORIGIN);
  const allowedOrigins =
    origins.includes("*") || (origins.length === 0 && !holdsLocalKey(env))
      ? ("*" as const)
      : new Set(origins.map((o) => o.replace(/\/$/, "").toLowerCase()));
  const token = env.COOKIE_MCP_HTTP_TOKEN?.trim() || null;
  return { allowedHosts, allowedOrigins, token };
}

function originAllowed(sec: HttpSecurity, origin: string): boolean {
  return sec.allowedOrigins === "*" || sec.allowedOrigins.has(origin.toLowerCase());
}

/** Constant-time compare that does not leak the token's length either. */
function tokenMatches(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * Why this request must be refused, or null to let it through (pure). `skipToken` is for a CORS
 * preflight (which carries no credentials by design) and the health check, both held to Host +
 * Origin only.
 */
export function checkRequest(
  sec: HttpSecurity,
  headers: http.IncomingHttpHeaders,
  opts: { skipToken?: boolean } = {},
): { status: 401 | 403; message: string } | null {
  const host = (one(headers.host) ?? "").trim().toLowerCase();
  if (sec.allowedHosts) {
    // A Host with no port means the default port, which is never ours on a loopback bind.
    if (
      !host ||
      (!sec.allowedHosts.has(host) && !sec.allowedHosts.has(host.replace(/:\d+$/, "")))
    ) {
      return { status: 403, message: "Host not allowed (set COOKIE_MCP_ALLOWED_HOSTS)" };
    }
  }
  const origin = one(headers.origin)?.trim();
  if (origin && !originAllowed(sec, origin)) {
    return {
      status: 403,
      message: "Origin not allowed (list the front-end in COOKIE_MCP_CORS_ORIGIN)",
    };
  }
  if (sec.token && !opts.skipToken) {
    const m = /^Bearer\s+(.+)$/i.exec(one(headers.authorization)?.trim() ?? "");
    if (!m || !tokenMatches(sec.token, m[1]!.trim())) {
      return { status: 401, message: "missing or wrong bearer token (COOKIE_MCP_HTTP_TOKEN)" };
    }
  }
  return null;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function cors(req: http.IncomingMessage, res: http.ServerResponse, sec: HttpSecurity): void {
  // Only ever reflect an origin we allow; with none configured no CORS header is sent at all, which
  // leaves the browser's same-origin policy in force.
  const origin = one(req.headers.origin)?.trim();
  if (sec.allowedOrigins === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && originAllowed(sec, origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    return;
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `content-type, accept, authorization, mcp-session-id, mcp-protocol-version, ${WALLET_HEADER}`,
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  return one(req.headers[name]);
}

/** Handle one HTTP request against a fresh server. Exported for tests. */
export async function handleHttpRequest(
  createServer: () => McpServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mcpPath: string,
  sec: HttpSecurity,
): Promise<void> {
  cors(req, res, sec);
  const url = new URL(req.url ?? "/", "http://localhost");
  const isHealth = url.pathname === "/healthz" || url.pathname === "/";
  const refused = checkRequest(sec, req.headers, {
    skipToken: req.method === "OPTIONS" || isHealth,
  });
  if (refused) {
    if (refused.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
    json(res, refused.status, {
      jsonrpc: "2.0",
      error: { code: -32001, message: refused.message },
      id: null,
    });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (isHealth) {
    json(res, 200, { ok: true, name: "cookie-mcp", version: VERSION, mcp: mcpPath });
    return;
  }
  if (url.pathname !== mcpPath) {
    json(res, 404, { error: "not found", hint: `MCP endpoint is ${mcpPath}` });
    return;
  }
  if (req.method !== "POST") {
    // Stateless mode: no server-initiated streams to resume, no sessions to delete.
    res.setHeader("Allow", "POST, OPTIONS");
    json(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed — this server is stateless; POST only" },
      id: null,
    });
    return;
  }

  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch (e) {
    json(res, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: `Parse error: ${e instanceof Error ? e.message : String(e)}`,
      },
      id: null,
    });
    return;
  }

  const wallet = headerValue(req, WALLET_HEADER)?.trim();
  const app = headerValue(req, APP_HEADER)?.trim();
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    const ctx = { remote: true, ...(wallet ? { wallet } : {}), ...(app ? { app } : {}) };
    await runWithRequestContext(ctx, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    });
  } catch (e) {
    if (!res.headersSent) {
      json(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: e instanceof Error ? e.message : "internal error" },
        id: null,
      });
    }
  }
}

/** Start listening; resolves with the URL of the MCP endpoint. */
export function serveHttp(
  createServer: () => McpServer,
  opts: { port: number; host: string; path: string },
  sec: HttpSecurity = resolveHttpSecurity(opts),
): Promise<string> {
  const mcpPath = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const httpServer = http.createServer((req, res) => {
    handleHttpRequest(createServer, req, res, mcpPath, sec).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve(`http://${opts.host}:${port}${mcpPath}`);
    });
  });
}
