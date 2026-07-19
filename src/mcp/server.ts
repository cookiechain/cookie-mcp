#!/usr/bin/env node
// cookie-mcp — local stdio MCP server for Cookie Chain. Reads work with no key; money-moving tools
// (trade, transfer, deploy_token, and the opt-in liquidity tools) need COOKIE_PRIVATE_KEY. Every tool
// returns JSON; failures return a structured { error, hint } — never a stack trace, never a secret.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DEFAULT_SLIPPAGE_BPS, MAX_TRADE_COOK } from "../core/config";
import { CookieMcpError, toToolError } from "../core/errors";
import { getChainHealth } from "../core/health";
import { getPools } from "../core/pools";
import { getTokenInfo } from "../core/token";
import { getQuote } from "../core/quote";
import { getBalances } from "../core/balances";
import { ownPublicKey } from "../core/wallet";
import { trade } from "../core/trade";
import { transfer } from "../core/transfer";
import { deployToken } from "../core/launch";
import { createPool, addLiquidity, removeLiquidity, lockLiquidity } from "../core/liquidity";

type ToolContent = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolContent {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(e: unknown): ToolContent {
  return {
    content: [{ type: "text", text: JSON.stringify(toToolError(e), null, 2) }],
    isError: true,
  };
}
/** Wrap a tool handler so any throw becomes a structured `{error, hint}` result. */
function tool<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolContent> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const server = new McpServer({ name: "cookie-mcp", version: "0.1.0" });

// Simply-typed alias for registerTool. The SDK's generic signature infers handler args from the zod
// inputSchema via deep conditional types that TS reports as TS2589 ("excessively deep") and OOMs on;
// we annotate each handler's args explicitly instead. Keep using this wrapper for new tools.
const registerTool = server.registerTool.bind(server) as (
  name: string,
  config: { title?: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
  cb: (args: any) => Promise<ToolContent>,
) => unknown;

registerTool(
  "chain_health",
  {
    title: "Cookie Chain health",
    description:
      "Live Cookie Chain snapshot: slot heights per commitment, finalization lag (the key health " +
      "signal — a stall causes BlockhashNotFound), epoch progress, validator/node counts, version, " +
      "block-production rate, and RPC latency. No arguments.",
    inputSchema: {},
  },
  tool(async () => getChainHealth()),
);

registerTool(
  "get_pools",
  {
    title: "List Cookie Chain pools",
    description:
      "Liquidity pools across every Cookie Chain DEX (Cookiebox DAMM/CLMM/DBC, CookieSwap SAMM/xYBN) " +
      "with TVL (USD) and 24h volume, sorted by TVL or volume. Use to find the most liquid markets.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("max pools to return (default 20)"),
      sort: z.enum(["tvl", "volume"]).optional().describe("sort key (default tvl)"),
    },
  },
  tool(async (a: { limit?: number; sort?: "tvl" | "volume" }) => getPools(a)),
);

registerTool(
  "get_token_info",
  {
    title: "Token info",
    description:
      "Metadata + market data for a token mint: name/symbol/decimals, price (USD and COOK), 24h " +
      "change, market cap, liquidity, 24h volume, holder count, and supply.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the token mint address (base58)"),
    },
  },
  tool(async (a: { mint: string }) => getTokenInfo(a.mint)),
);

registerTool(
  "get_quote",
  {
    title: "Swap quote (Candy Shop)",
    description:
      "Quote a swap via the Candy Shop aggregator (routes across all Cookie Chain DEX liquidity). " +
      "Returns expected output, output after the ~20 bps aggregator fee, minimum out after slippage, " +
      "price impact, and the route. Quote-only — no wallet needed. `amount` is a UI amount of the input token.",
    inputSchema: {
      inputMint: z
        .string()
        .min(32)
        .max(44)
        .describe("input token mint (use the COOK/native mint for COOK)"),
      outputMint: z.string().min(32).max(44).describe("output token mint"),
      amount: z
        .union([z.number().positive(), z.string()])
        .describe("UI amount of the input token, e.g. 10 for 10 COOK"),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe(`slippage tolerance in bps (default ${DEFAULT_SLIPPAGE_BPS})`),
    },
  },
  tool(
    async (a: {
      inputMint: string;
      outputMint: string;
      amount: string | number;
      slippageBps?: number;
    }) => getQuote(a),
  ),
);

registerTool(
  "get_balance",
  {
    title: "Wallet balances",
    description:
      "Native COOK + SPL/Token-2022 token balances for a wallet, with USD values. Defaults to the " +
      "configured wallet (COOKIE_PRIVATE_KEY); pass `wallet` to inspect any address. In read-only " +
      "mode (no key), `wallet` is required.",
    inputSchema: {
      wallet: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("wallet address (base58); omit to use the configured wallet"),
    },
  },
  tool(async (a: { wallet?: string }) => {
    const wallet = a.wallet ?? ownPublicKey();
    if (!wallet) {
      throw new CookieMcpError(
        "no wallet address provided and no wallet configured",
        "pass a `wallet` address, or set COOKIE_PRIVATE_KEY to default to your own wallet",
      );
    }
    return getBalances(wallet);
  }),
);

registerTool(
  "trade",
  {
    title: "Swap (Candy Shop)",
    description:
      "Execute a swap via the Candy Shop aggregator: quotes, simulates, signs locally with the " +
      "configured wallet, submits, and confirms. Non-custodial. Enforces the per-trade spend cap " +
      `(COOKIE_MAX_TRADE_COOK, currently ${MAX_TRADE_COOK} COOK). Requires COOKIE_PRIVATE_KEY. ` +
      "`amount` is a UI amount of the input token. Returns the tx signature + explorer link.",
    inputSchema: {
      inputMint: z
        .string()
        .min(32)
        .max(44)
        .describe("input token mint (COOK/native mint for COOK)"),
      outputMint: z.string().min(32).max(44).describe("output token mint"),
      amount: z
        .union([z.number().positive(), z.string()])
        .describe("UI amount of the input token, e.g. 10 for 10 COOK"),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe(`slippage tolerance in bps (default ${DEFAULT_SLIPPAGE_BPS})`),
    },
  },
  tool(
    async (a: {
      inputMint: string;
      outputMint: string;
      amount: string | number;
      slippageBps?: number;
    }) => trade(a),
  ),
);

registerTool(
  "transfer",
  {
    title: "Transfer COOK or a token",
    description:
      "Send native COOK (omit `mint` or use the COOK mint) or an SPL/Token-2022 token to another " +
      "wallet, creating the recipient's token account if needed. Simulates before sending and " +
      `enforces the spend cap (COOKIE_MAX_TRADE_COOK, ${MAX_TRADE_COOK} COOK). Requires COOKIE_PRIVATE_KEY.`,
    inputSchema: {
      to: z.string().min(32).max(44).describe("recipient wallet address (base58)"),
      mint: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("token mint to send; omit for native COOK"),
      amount: z.union([z.number().positive(), z.string()]).describe("UI amount to send"),
    },
  },
  tool(async (a: { to: string; mint?: string; amount: string | number }) => transfer(a)),
);

registerTool(
  "deploy_token",
  {
    title: "Launch a token (Cookiebox DBC)",
    description:
      "Launch a new token on the Cookiebox dynamic bonding curve: grinds a vanity mint (ends in " +
      "'box'), uploads metadata, and creates the bonding-curve pool. Signs locally; requires " +
      "COOKIE_PRIVATE_KEY. An https `imageUrl` is required. Returns the mint, pool, and links.",
    inputSchema: {
      name: z.string().min(1).max(64).describe('token name, e.g. "Cookie Monster"'),
      symbol: z.string().min(1).max(10).describe('ticker, e.g. "MON"'),
      description: z.string().max(1000).optional().describe("short description"),
      imageUrl: z
        .string()
        .url()
        .optional()
        .describe("https URL to the token image (required by the metadata API)"),
      initialBuyCook: z
        .number()
        .positive()
        .optional()
        .describe("NOT yet supported — launch-time pre-buy arrives later"),
    },
  },
  tool(
    async (a: {
      name: string;
      symbol: string;
      description?: string;
      imageUrl?: string;
      initialBuyCook?: number;
    }) => deployToken(a),
  ),
);

// Liquidity — Cookiebox DAMM v2 + CookieSwap SAMM. Every op simulates before sending and honors the
// spend cap; all are live-verified on Cookie Chain (see PLAN.md CP5/CP6).
registerTool(
  "create_pool",
  {
    title: "Create a pool",
    description:
      "Create a new pool for a token pair and seed it with an initial deposit (the deposit ratio sets " +
      "the starting price). `dex` selects the venue: cookiebox-damm (default). cookieswap-samm creation " +
      "is not supported yet. Simulates before sending; caps the COOK side. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      dex: z
        .enum(["cookiebox-damm", "cookieswap-samm"])
        .optional()
        .describe("venue (default cookiebox-damm)"),
      tokenAMint: z.string().min(32).max(44).describe("first token mint"),
      tokenBMint: z.string().min(32).max(44).describe("second token mint (e.g. the COOK mint)"),
      amountA: z
        .union([z.number().positive(), z.string()])
        .describe("UI amount of token A to seed"),
      amountB: z
        .union([z.number().positive(), z.string()])
        .describe("UI amount of token B to seed"),
      config: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("PoolConfig address (DAMM only); omit for the default"),
    },
  },
  tool(
    async (a: {
      dex?: "cookiebox-damm" | "cookieswap-samm";
      tokenAMint: string;
      tokenBMint: string;
      amountA: string | number;
      amountB: string | number;
      config?: string;
    }) => createPool(a),
  ),
);

registerTool(
  "add_liquidity",
  {
    title: "Add liquidity",
    description:
      "Add liquidity to a pool by opening a new position; the venue (Cookiebox DAMM v2 or CookieSwap " +
      "SAMM) is auto-detected from the pool. Simulates before sending; honors the spend cap. Requires " +
      "COOKIE_PRIVATE_KEY.",
    inputSchema: {
      poolPk: z.string().min(32).max(44).describe("pool address (see get_pools)"),
      amountA: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe("UI amount of token A"),
      amountB: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe("UI amount of token B"),
    },
  },
  tool(async (a: { poolPk: string; amountA?: string | number; amountB?: string | number }) =>
    addLiquidity(a),
  ),
);

registerTool(
  "remove_liquidity",
  {
    title: "Remove liquidity",
    description:
      "Remove liquidity from your position in a pool (venue auto-detected). `bps` is the fraction to " +
      "remove for DAMM v2 (default 10000 = all); SAMM removes the whole position. Requires " +
      "COOKIE_PRIVATE_KEY.",
    inputSchema: {
      poolPk: z.string().min(32).max(44).describe("pool address"),
      bps: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe("basis points to remove (default all)"),
    },
  },
  tool(async (a: { poolPk: string; bps?: number }) => removeLiquidity(a)),
);

registerTool(
  "lock_liquidity",
  {
    title: "Permanently lock liquidity (Cookiebox DAMM v2)",
    description:
      "⚠️ IRREVERSIBLE. Permanently locks your unlocked liquidity in a Cookiebox DAMM v2 position. " +
      "Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      poolPk: z.string().min(32).max(44).describe("DAMM v2 pool address"),
    },
  },
  tool(async (a: { poolPk: string }) => lockLiquidity(a)),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — log only to stderr.
  const mode = ownPublicKey() ? "wallet configured" : "read-only (no COOKIE_PRIVATE_KEY)";
  console.error(`cookie-mcp server running on stdio — ${mode}`);
}

main().catch((e) => {
  console.error("cookie-mcp failed to start:", e instanceof Error ? e.message : e);
  process.exit(1);
});
