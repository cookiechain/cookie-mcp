#!/usr/bin/env node
// cookie-mcp CLI. Default: a local stdio MCP server (what `npx cookie-mcp` in an agent config runs).
// `--http [port]` serves the same tools over Streamable HTTP for hosted deployments, where the process
// holds no key (COOKIE_SIGNER=external) and each request names the wallet it acts for.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./createServer";
import { serveHttp } from "./http";
import { ownPublicKey, signerMode } from "../core/wallet";
import { VERSION } from "../version";

function modeLine(): string {
  const mode = signerMode();
  if (mode === "external") {
    const w = ownPublicKey();
    return w
      ? `external signer, default wallet ${w}`
      : "external signer (wallet per request via x-cookie-wallet)";
  }
  return ownPublicKey() ? "wallet configured" : "read-only (no COOKIE_PRIVATE_KEY)";
}

function parseArgs(argv: string[]): { http: boolean; port: number; host: string; path: string } {
  const envPort = process.env.COOKIE_MCP_HTTP_PORT?.trim();
  let http = Boolean(envPort);
  let port = envPort ? Number(envPort) : 3000;
  let host = process.env.COOKIE_MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const path = process.env.COOKIE_MCP_HTTP_PATH?.trim() || "/mcp";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--http") {
      http = true;
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        port = Number(next);
        i++;
      }
    } else if (a.startsWith("--http=")) {
      http = true;
      port = Number(a.slice("--http=".length));
    } else if (a === "--host") {
      host = argv[++i] ?? host;
    } else if (a.startsWith("--host=")) {
      host = a.slice("--host=".length);
    } else if (a === "--version" || a === "-v") {
      console.log(VERSION);
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      console.log(
        [
          `cookie-mcp ${VERSION}`,
          "",
          "  cookie-mcp                 stdio MCP server (default; for agent configs)",
          "  cookie-mcp --http [port]   Streamable HTTP MCP server (default port 3000, path /mcp)",
          "  cookie-mcp --host <addr>   bind address for --http (default 127.0.0.1)",
          "",
          "Env: COOKIE_PRIVATE_KEY (local signer), COOKIE_SIGNER=external (+ COOKIE_WALLET_ADDRESS or",
          "the x-cookie-wallet request header), COOKIE_RPC_URL, COOKIE_MCP_HTTP_PORT/HOST/PATH.",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid HTTP port: ${port}`);
  }
  return { http, port, host, path };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.http) {
    // A hosted server that also holds a spending key would let anyone who reaches the port spend from
    // it. Refuse unless the operator says they mean it.
    if (signerMode() === "local" && process.env.COOKIE_PRIVATE_KEY?.trim()) {
      if (process.env.COOKIE_HTTP_ALLOW_LOCAL_KEY !== "1") {
        throw new Error(
          "refusing to serve HTTP with a local COOKIE_PRIVATE_KEY: every caller could spend from it. " +
            "Use COOKIE_SIGNER=external (wallet-signed, no key in the process), or set " +
            "COOKIE_HTTP_ALLOW_LOCAL_KEY=1 if this server is private and you accept that.",
        );
      }
      console.error(
        "WARNING: serving HTTP with a local spending key (COOKIE_HTTP_ALLOW_LOCAL_KEY=1)",
      );
    }
    const url = await serveHttp(createServer, opts);
    console.error(`cookie-mcp ${VERSION} serving Streamable HTTP at ${url} — ${modeLine()}`);
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — log only to stderr.
  console.error(`cookie-mcp ${VERSION} server running on stdio — ${modeLine()}`);
}

main().catch((e) => {
  console.error("cookie-mcp failed to start:", e instanceof Error ? e.message : e);
  process.exit(1);
});
