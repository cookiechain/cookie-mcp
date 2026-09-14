// Streamable HTTP transport for hosted deployments. Stateless: every POST gets a fresh server +
// transport, so nothing about one caller leaks into another's request, and the wallet a request acts
// for (`x-cookie-wallet`) is scoped to that request through `runWithRequestContext`. Registering the
// tool set per request costs a few milliseconds; the RPC calls the tools make dwarf it.
//
// Intended pairing: COOKIE_SIGNER=external. The process holds no key; a web app passes the connected
// wallet's address in the header, receives `needs_signature` results, signs in the browser wallet and
// calls `submit_signed_tx`. CORS is open by default so browser front-ends can call it directly; pin
// it with COOKIE_MCP_CORS_ORIGIN when the front-end origin is known.
import http from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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

function cors(res: http.ServerResponse): void {
  const origin = process.env.COOKIE_MCP_CORS_ORIGIN?.trim() || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
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
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Handle one HTTP request against a fresh server. Exported for tests. */
export async function handleHttpRequest(
  createServer: () => McpServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mcpPath: string,
): Promise<void> {
  cors(res);
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/healthz" || url.pathname === "/") {
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
    await runWithRequestContext({ ...(wallet ? { wallet } : {}) }, async () => {
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
): Promise<string> {
  const mcpPath = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const httpServer = http.createServer((req, res) => {
    handleHttpRequest(createServer, req, res, mcpPath).catch((e) => {
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
