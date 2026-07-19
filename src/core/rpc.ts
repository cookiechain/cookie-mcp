// Raw JSON-RPC to Cookie Chain. Reads are batched into one POST so a single round trip gets all
// three commitment slots (the finalization-lag signal), and because getHealth isn't on web3.js's
// Connection. Everything uses `confirmed`: Cookie Chain finalization can stall, and the web3.js
// default of `finalized` then yields BlockhashNotFound.
import { Connection } from "@solana/web3.js";

import { COOKIE_RPC_URL, HTTP_TIMEOUT_MS } from "./config";
import { CookieMcpError } from "./errors";

export interface RpcReq {
  id: string;
  method: string;
  params?: unknown[];
}
export interface RpcRes<T = unknown> {
  id: string;
  result?: T;
  error?: { code: number; message: string };
}

async function rpcBatchOnce(reqs: RpcReq[], timeoutMs: number): Promise<Map<string, RpcRes>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(COOKIE_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", ...r }))),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new CookieMcpError(
        `RPC returned HTTP ${res.status}`,
        "the RPC endpoint may be down; check COOKIE_RPC_URL",
      );
    }
    const json = (await res.json()) as RpcRes[];
    const arr = Array.isArray(json) ? json : [json];
    return new Map(arr.map((r) => [String(r.id), r]));
  } finally {
    clearTimeout(timer);
  }
}

// Reads are idempotent, so retry once on a transient transport failure (network/timeout/5xx).
export async function rpcBatch(
  reqs: RpcReq[],
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Map<string, RpcRes>> {
  for (let i = 0; i < 2; i++) {
    try {
      return await rpcBatchOnce(reqs, timeoutMs);
    } catch (e) {
      const retryable =
        (e instanceof CookieMcpError && /HTTP 5\d\d/.test(e.message)) ||
        (e instanceof Error && (e.name === "AbortError" || !(e instanceof CookieMcpError)));
      if (i === 0 && retryable) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (e instanceof CookieMcpError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new CookieMcpError("RPC request timed out", "the chain RPC may be slow; retry");
      }
      throw new CookieMcpError(
        "network error calling the RPC",
        "check COOKIE_RPC_URL and connectivity, then retry",
      );
    }
  }
  throw new CookieMcpError("RPC request failed", "retry shortly");
}

let _conn: Connection | null = null;

export function getConnection(): Connection {
  if (!_conn) _conn = new Connection(COOKIE_RPC_URL, "confirmed");
  return _conn;
}
