#!/usr/bin/env node
// cookie-mcp — local stdio MCP server for Cookie Chain. Reads work with no key; money-moving tools
// (trade, transfer, and the opt-in liquidity tools) need COOKIE_PRIVATE_KEY. Every tool
// returns JSON; failures return a structured { error, hint } — never a stack trace, never a secret.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DEFAULT_SLIPPAGE_BPS, MAX_TRADE_COOK } from "../core/config";
import { CookieMcpError, toToolError } from "../core/errors";
import { getChainHealth } from "../core/health";
import { getPools } from "../core/pools";
import { getTokenInfo, searchTokens } from "../core/token";
import { getQuote } from "../core/quote";
import { getBalances } from "../core/balances";
import { ownPublicKey } from "../core/wallet";
import { trade } from "../core/trade";
import { transfer } from "../core/transfer";
import { getStakeInfo, stake, unstake } from "../core/stake";
import {
  createPool,
  addLiquidity,
  removeLiquidity,
  lockLiquidity,
  claimFees,
} from "../core/liquidity";
import {
  getNftListings,
  searchNfts,
  getNft,
  getWalletNfts,
  getNftOffers,
  getMarketStats,
  getCollection,
  listNft,
  cancelListing,
  buyNft,
  makeOffer,
  cancelOffer,
  acceptOffer,
} from "../core/nft";
import { bridge, bridgeStatus, type BridgeDirection } from "../core/bridge";
import {
  deployToken,
  claimCreatorFees,
  claimLaunchpad,
  getLaunchpadPools,
  getLaunchpadPositions,
  getLaunchpadToken,
  launchpadBuy,
  launchpadSell,
  type ClaimKind,
  type ExpiryMode,
  type PoolStatus,
} from "../core/launchpad";

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

const server = new McpServer({ name: "cookie-mcp", version: "0.4.0" });

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
      "Liquidity pools across every Cookie Chain DEX (Cookiebox DAMM/CLMM, CookieSwap SAMM/xYBN) " +
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
  "search_tokens",
  {
    title: "Search tokens by name",
    description:
      "Resolve a token name or ticker to its mint by searching the Cookiescan registry (every Cookie " +
      "Chain token) by symbol/name — partial and case-insensitive — or by mint prefix. Returns ranked " +
      "candidates (most liquid first) with mint, price, liquidity, 24h volume, and holders. Use this " +
      "FIRST whenever the user names a token but you don't have its mint, then pass the chosen mint to " +
      "get_token_info / get_quote / trade. Multiple tokens can share a symbol — compare liquidity and " +
      "confirm the mint before trading. No wallet needed.",
    inputSchema: {
      query: z.string().min(1).describe('token name, ticker, or mint prefix, e.g. "cookhouse"'),
      limit: z.number().int().min(1).max(50).optional().describe("max results (default 20)"),
    },
  },
  tool(async (a: { query: string; limit?: number }) => searchTokens(a.query, a.limit)),
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
  "stake_info",
  {
    title: "bCOOK liquid staking info",
    description:
      "Live bCOOK (liquid-staked COOK) stats: the COOK-per-bCOOK exchange rate (only ever rises), TVL, " +
      "bCOOK supply, deposit/withdraw fees, and an estimated APY. Use before `stake`/`unstake`. No key needed.",
    inputSchema: {},
  },
  tool(async () => getStakeInfo()),
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
  "stake",
  {
    title: "Stake COOK for bCOOK",
    description:
      "Stake COOK into the bCOOK liquid-staking pool (SPL Stake Pool): deposits COOK and mints bCOOK to " +
      "your wallet (≈ amount × 0.995 / rate, after the 0.5% deposit fee). bCOOK keeps earning as the rate " +
      "rises and stays liquid/transferable. Simulates first; honors the spend cap. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      amount: z
        .union([z.number().positive(), z.string()])
        .describe("UI amount of COOK to stake, e.g. 10"),
    },
  },
  tool(async (a: { amount: string | number }) => stake(a)),
);

registerTool(
  "unstake",
  {
    title: "Unstake bCOOK for COOK",
    description:
      "Redeem bCOOK back to COOK instantly from the pool's liquid reserve (≈ amount × rate × 0.98, after " +
      "the 2% withdrawal fee). Burns bCOOK and pays COOK to your wallet. Simulates first; honors the spend " +
      "cap (valued in COOK). Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      amount: z
        .union([z.number().positive(), z.string()])
        .describe("UI amount of bCOOK to unstake, e.g. 5"),
    },
  },
  tool(async (a: { amount: string | number }) => unstake(a)),
);

// Launchpad — MomoSwap (momoswap.fun): tokens launch on a bonding curve priced in COOK and
// graduate to the open market once the raise target is hit. IMPORTANT for agents: before
// graduation a buyer's holdings are program-tracked curve *shares*, not SPL tokens — they never
// appear in get_balance and cannot be routed by trade/get_quote. launchpad_sell is the only exit
// until graduation; after it, claim_launchpad hands over the real SPL token.
const POOL_REF = "the token mint or the launchpad pool address (either works)";

registerTool(
  "get_launchpad_pools",
  {
    title: "List launchpad launches",
    description:
      "Browse MomoSwap launchpad pools: name/symbol/mint, curve price in COOK, amount raised vs the " +
      "graduation target (with progress %), participants, settlement mode and the launch window. " +
      "Defaults to `live` launches (currently tradeable), sorted closest-to-graduation first. " +
      "NOTE the returned `status` can also be `ended`: the launch window closed but nobody has settled " +
      "the pool on-chain yet, so it is neither tradeable nor claimable. The `status` filter is applied " +
      "upstream, so a `live` filter may include such pools. Read-only — no key needed.",
    inputSchema: {
      status: z
        .enum(["live", "upcoming", "graduated", "expired", "all"])
        .optional()
        .describe("lifecycle filter (default live)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("max pools to return (default 20)"),
    },
  },
  tool(async (a: { status?: PoolStatus | "all"; limit?: number }) => getLaunchpadPools(a)),
);

registerTool(
  "get_launchpad_token",
  {
    title: "Launchpad token detail",
    description:
      "Full state of one launchpad launch: curve price, raise vs graduation target, settlement mode, " +
      "fee split, and — when COOKIE_PRIVATE_KEY is set — this wallet's curve position (shares, " +
      "invested COOK, current sell value, what it already claimed) plus pending creator fees if it " +
      "created the launch. Pass `quoteCook` to preview how many tokens a buy of that size would get. " +
      "A `status` of `ended` means trading closed but the pool is not settled on-chain yet — nothing " +
      "can be traded or claimed until it is. Read-only.",
    inputSchema: {
      ref: z.string().min(32).max(44).describe(POOL_REF),
      quoteCook: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe("optional COOK amount to quote a buy for, e.g. 10"),
    },
  },
  tool(async (a: { ref: string; quoteCook?: string | number }) => getLaunchpadToken(a)),
);

registerTool(
  "get_launchpad_positions",
  {
    title: "My launchpad positions",
    description:
      "Every MomoSwap launchpad position a wallet holds, across all launches — the view get_balance " +
      "CANNOT give, because pre-graduation holdings are program-tracked curve shares rather than SPL " +
      "tokens. Per position: shares, COOK invested vs withdrawn, what a live curve would pay to sell " +
      "now, and the `action` if something is outstanding (unclaimed tokens after graduation, an " +
      "unclaimed Fair-mode refund, a settlement payout). Also lists launches this wallet created that " +
      "have unclaimed creator fees or vesting. Use this to answer 'what do I hold / what can I claim'. " +
      "Reads only: pass `owner` for any wallet, or omit it to use COOKIE_PRIVATE_KEY's.",
    inputSchema: {
      owner: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("wallet to inspect (defaults to your own wallet)"),
      includeClosed: z
        .boolean()
        .optional()
        .describe("also list fully exited / already-settled positions (default false)"),
    },
  },
  tool(async (a: { owner?: string; includeClosed?: boolean }) => getLaunchpadPositions(a)),
);

registerTool(
  "deploy_token",
  {
    title: "Launch a token",
    description:
      "Launch a new token on the MomoSwap launchpad (bonding curve priced in COOK, graduates to the " +
      "open market at the raise target). Mint + freeze authority are renounced and the metadata is " +
      "immutable, so a launch is FINAL — nothing about the token can be changed afterwards. Costs the " +
      "launchpad's creation fee, read live from its config (0 on the current deployment, so a launch " +
      "usually costs only account rent) plus any devBuyCook; when the fee or dev buy is non-zero, " +
      "COOKIE_MAX_TRADE_COOK must allow the total or the launch is refused by the spend cap. " +
      "A LOGO IS REQUIRED: pass `imageBase64` (preferred — attach an image you generated, with " +
      "`imageMimeType`) or `imageUrl` and the launchpad pins it to IPFS. Launching without one is " +
      "refused unless you set `noLogo: true`, because the metadata is immutable and a logo can never " +
      "be added later. The mint address is chosen by the launchpad (the program requires one ending " +
      "in `momo`). Set `devBuyCook` to make your own buy the atomic first trade. Requires " +
      "COOKIE_PRIVATE_KEY.",
    inputSchema: {
      name: z.string().min(1).max(32).describe("token name, max 32 chars"),
      symbol: z.string().min(1).max(10).describe("ticker, max 10 chars (upper-cased)"),
      description: z.string().max(1000).optional().describe("short description for the token page"),
      imageBase64: z
        .string()
        .optional()
        .describe("logo bytes as base64 (preferred; a data: prefix is fine) — pinned to IPFS"),
      imageMimeType: z
        .string()
        .optional()
        .describe('MIME type of imageBase64, e.g. "image/png" (required with imageBase64)'),
      imageUrl: z
        .string()
        .optional()
        .describe("alternative to imageBase64: an already-hosted https image URL"),
      website: z.string().optional().describe("project website URL"),
      twitter: z.string().optional().describe("X/Twitter handle or URL"),
      telegram: z.string().optional().describe("Telegram handle or URL"),
      durationSecs: z
        .number()
        .int()
        .min(60)
        .max(604800)
        .optional()
        .describe("how long the launch stays open, 60s–7d (default 86400)"),
      expiryMode: z
        .enum(["dead", "fair", "jackpot", "survivor"])
        .optional()
        .describe(
          "what happens if it never graduates: fair = pro-rata refund (default), dead = unraised " +
            "funds swept to treasury, jackpot = Merkle payout to the top 10%, survivor = top 3",
        ),
      antiSnipe: z
        .boolean()
        .optional()
        .describe("cap each wallet during the opening window (default true)"),
      minBuyCook: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe("minimum buy per trade in COOK (default none)"),
      maxBuyPerWalletCook: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe("lifetime cap per wallet in COOK (default none)"),
      devBuyCook: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe("optional COOK amount to buy atomically in the launch transaction"),
      noLogo: z
        .boolean()
        .optional()
        .describe(
          "launch deliberately without a logo. Only set this if the user asked for it — the token " +
            "metadata is immutable, so no logo can ever be added and most UIs show a blank image",
        ),
    },
  },
  tool(
    async (a: {
      name: string;
      symbol: string;
      description?: string;
      imageBase64?: string;
      imageMimeType?: string;
      imageUrl?: string;
      website?: string;
      twitter?: string;
      telegram?: string;
      durationSecs?: number;
      expiryMode?: ExpiryMode;
      antiSnipe?: boolean;
      minBuyCook?: string | number;
      maxBuyPerWalletCook?: string | number;
      devBuyCook?: string | number;
      noLogo?: boolean;
    }) => deployToken(a),
  ),
);

registerTool(
  "launchpad_buy",
  {
    title: "Buy on a launchpad curve",
    description:
      "Buy a launchpad token on its bonding curve with COOK (the launchpad wraps the COOK and opens " +
      "any missing accounts). ⚠️ You receive program-tracked CURVE SHARES, not SPL tokens: they will " +
      "not show in get_balance and trade cannot swap them — exit with launchpad_sell, or claim the " +
      "real token with claim_launchpad after the pool graduates. There is no slippage parameter (the " +
      "program has no min-out), so the fill can move if others trade first. A 1% trade fee applies. " +
      "Simulates before sending; honors the spend cap. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      ref: z.string().min(32).max(44).describe(POOL_REF),
      amountCook: z
        .union([z.number().positive(), z.string()])
        .describe("how much COOK to spend, e.g. 10"),
      referrer: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("optional referrer wallet that earns the referral fee share (not your own)"),
    },
  },
  tool(async (a: { ref: string; amountCook: string | number; referrer?: string }) =>
    launchpadBuy(a),
  ),
);

registerTool(
  "launchpad_sell",
  {
    title: "Sell on a launchpad curve",
    description:
      "Sell curve shares back to a launchpad bonding curve for COOK (unwrapped to native COOK by " +
      "default). Only works while the pool is live and only for shares bought via launchpad_buy — a " +
      "graduated token's SPL balance is sold with `trade` instead. A 1% trade fee applies. Simulates " +
      "before sending. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      ref: z.string().min(32).max(44).describe(POOL_REF),
      shares: z
        .union([z.number().positive(), z.string()])
        .describe("how many tokens (curve shares) to sell, as a UI amount"),
      unwrap: z.boolean().optional().describe("unwrap the proceeds to native COOK (default true)"),
    },
  },
  tool(async (a: { ref: string; shares: string | number; unwrap?: boolean }) => launchpadSell(a)),
);

registerTool(
  "claim_launchpad",
  {
    title: "Claim a launchpad payout",
    description:
      "Settle a launchpad position. By default the right claim is picked from the pool's state: " +
      "graduated → your real SPL tokens; expired in fair mode → a pro-rata COOK refund; expired in " +
      "jackpot/survivor mode → your Merkle payout (the proof is fetched for you). Creators can pass " +
      "kind=creator_vest to claim their vested allocation after graduation. Dead-mode expiries have " +
      "no holder payout. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      ref: z.string().min(32).max(44).describe(POOL_REF),
      kind: z
        .enum(["auto", "graduated_tokens", "fair", "winner", "creator_vest"])
        .optional()
        .describe("which claim to make (default auto — chosen from the pool state)"),
    },
  },
  tool(async (a: { ref: string; kind?: ClaimKind | "auto" }) => claimLaunchpad(a)),
);

registerTool(
  "claim_creator_fees",
  {
    title: "Claim launch creator fees",
    description:
      "Sweep the creator's share of trading fees (35% of the 1% trade fee) from a launchpad token you " +
      "created, into your wallet as native COOK. Only the pool's creator can claim; fails early with " +
      "the pending amount when nothing has accrued yet. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      ref: z.string().min(32).max(44).describe(POOL_REF),
      unwrap: z
        .boolean()
        .optional()
        .describe("unwrap the swept fees to native COOK (default true)"),
    },
  },
  tool(async (a: { ref: string; unwrap?: boolean }) => claimCreatorFees(a)),
);

// Liquidity — Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap SAMM. Every op simulates before
// sending and honors the spend cap; all are live-verified on Cookie Chain.
registerTool(
  "create_pool",
  {
    title: "Create a pool",
    description:
      "Create a new pool for a token pair and seed it with an initial deposit (the deposit ratio sets " +
      "the starting price). `dex` selects the venue: cookiebox-damm (default), cookiebox-clmm " +
      "(concentrated liquidity, full-range seed, default 0.25% fee tier), or cookieswap-samm " +
      "(concentrated liquidity; fee tier/tick spacing chosen by `ammConfig`, full-range seed). " +
      "Simulates before sending; caps the COOK side. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      dex: z
        .enum(["cookiebox-damm", "cookiebox-clmm", "cookieswap-samm"])
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
      feeTier: z
        .number()
        .optional()
        .describe("CLMM fee tier in bps: 25 (default), 30, 100, 200, or 400"),
      initialPrice: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe(
          "CLMM/SAMM only: starting price as tokenB per tokenA; omit to derive from the amounts",
        ),
      ammConfig: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe(
          "SAMM only: AmmConfig address (selects fee tier/tick spacing); omit for the default",
        ),
    },
  },
  tool(
    async (a: {
      dex?: "cookiebox-damm" | "cookiebox-clmm" | "cookieswap-samm";
      tokenAMint: string;
      tokenBMint: string;
      amountA: string | number;
      amountB: string | number;
      config?: string;
      feeTier?: number;
      initialPrice?: string | number;
      ammConfig?: string;
    }) => createPool(a),
  ),
);

registerTool(
  "add_liquidity",
  {
    title: "Add liquidity",
    description:
      "Add liquidity to a pool by opening a new position; the venue (Cookiebox DAMM v2, Cookiebox CLMM, " +
      "or CookieSwap SAMM) is auto-detected from the pool. Concentrated-liquidity venues (CLMM/SAMM) " +
      "open a full-range position by default. Simulates before sending; honors the spend cap. Requires " +
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
      "remove for DAMM v2 and CLMM (default 10000 = all, which also closes a CLMM position); SAMM " +
      "removes the whole position. Requires COOKIE_PRIVATE_KEY.",
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

registerTool(
  "claim_fees",
  {
    title: "Claim accrued LP fees",
    description:
      "Claim the swap fees your liquidity position has accrued in a pool (venue auto-detected: " +
      "Cookiebox DAMM v2, Cookiebox CLMM, or CookieSwap SAMM). Sweeps fees to your wallet without " +
      "removing the position. Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      poolPk: z.string().min(32).max(44).describe("pool address you hold a position in"),
    },
  },
  tool(async (a: { poolPk: string }) => claimFees(a)),
);

// NFT marketplace — Baked Bazaar (Metaplex Auction House on Cookie Chain). Reads use the marketplace
// indexer; every write builds the auction-house tx, simulates, signs locally, and confirms. COOK-
// spending tools (buy_nft, make_offer) honor the spend cap. Requires COOKIE_PRIVATE_KEY for writes.
registerTool(
  "get_nft_listings",
  {
    title: "List NFT listings (Baked Bazaar)",
    description:
      "Active NFT listings on Baked Bazaar with prices in COOK, seller, and collection. Filter by " +
      "`collection` (symbol or collection key) or `seller`, and sort by price (cheapest first) or " +
      "recency. No wallet needed. Use to find NFTs to buy.",
    inputSchema: {
      collection: z
        .string()
        .optional()
        .describe("filter by collection symbol (e.g. GORI) or collection key"),
      seller: z.string().min(32).max(44).optional().describe("filter by seller wallet"),
      sort: z.enum(["price", "recent"]).optional().describe("sort key (default recent)"),
      limit: z.number().int().min(1).max(100).optional().describe("max listings (default 20)"),
    },
  },
  tool(
    async (a: {
      collection?: string;
      seller?: string;
      sort?: "price" | "recent";
      limit?: number;
    }) => getNftListings(a),
  ),
);

registerTool(
  "search_nfts",
  {
    title: "Search NFTs by name",
    description:
      "Resolve an NFT or collection name to a mint by searching active Baked Bazaar listings by name, " +
      "symbol, or collection — partial and case-insensitive — or by mint prefix. Returns matching " +
      "listed NFTs (cheapest first) with mint, collection, price in COOK, and seller. Use this FIRST " +
      "whenever the user names an NFT or collection to buy but you don't have its mint, then pass the " +
      "chosen mint to get_nft / buy_nft. Only currently-listed NFTs are searchable. No wallet needed.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe('NFT name, collection symbol, or mint prefix, e.g. "cookhouse"'),
      limit: z.number().int().min(1).max(100).optional().describe("max results (default 20)"),
    },
  },
  tool(async (a: { query: string; limit?: number }) => searchNfts(a.query, a.limit)),
);

registerTool(
  "get_nft",
  {
    title: "NFT details (Baked Bazaar)",
    description:
      "Full detail for one NFT mint: metadata (name, image, attributes, collection), whether it's " +
      "listed and at what price, the best current offer, and the collection floor. No wallet needed.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the NFT mint address (base58)"),
    },
  },
  tool(async (a: { mint: string }) => getNft(a.mint)),
);

registerTool(
  "get_wallet_nfts",
  {
    title: "Wallet NFTs (Baked Bazaar)",
    description:
      "NFTs held by a wallet, each with any active Baked Bazaar listing. Defaults to the configured " +
      "wallet (COOKIE_PRIVATE_KEY); pass `wallet` to inspect any address (required in read-only mode).",
    inputSchema: {
      wallet: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("wallet address (base58); omit to use the configured wallet"),
    },
  },
  tool(async (a: { wallet?: string }) => getWalletNfts(a.wallet)),
);

registerTool(
  "get_nft_offers",
  {
    title: "NFT offers (Baked Bazaar)",
    description:
      "Offers a wallet has made and offers it has received (bids on NFTs it holds), with prices in " +
      "COOK. Defaults to the configured wallet; pass `wallet` to inspect any address. Use before " +
      "accept_offer / cancel_offer.",
    inputSchema: {
      wallet: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("wallet address (base58); omit to use the configured wallet"),
    },
  },
  tool(async (a: { wallet?: string }) => getNftOffers(a.wallet)),
);

registerTool(
  "get_nft_market_stats",
  {
    title: "NFT market stats (Baked Bazaar)",
    description:
      "Marketplace-wide Baked Bazaar stats: active listing count, floor price, total and 24h volume, " +
      "and sales counts (COOK). Optionally pass `collection` for a collection's supply and holder " +
      "count. No wallet needed.",
    inputSchema: {
      collection: z
        .string()
        .optional()
        .describe("collection symbol (e.g. GORI) for collection-level stats"),
    },
  },
  tool(async (a: { collection?: string }) =>
    a.collection ? getCollection(a.collection) : getMarketStats(),
  ),
);

registerTool(
  "list_nft",
  {
    title: "List an NFT for sale (Baked Bazaar)",
    description:
      "List an NFT you own for sale on Baked Bazaar at `price` COOK (creates the auction-house sell " +
      "order). Simulates before sending; signs locally. Requires COOKIE_PRIVATE_KEY. The 1% " +
      "marketplace fee and creator royalties are taken from the sale proceeds when it sells.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the NFT mint you own"),
      price: z.union([z.number().positive(), z.string()]).describe("sale price in COOK, e.g. 12.5"),
    },
  },
  tool(async (a: { mint: string; price: string | number }) => listNft(a)),
);

registerTool(
  "cancel_listing",
  {
    title: "Cancel an NFT listing (Baked Bazaar)",
    description:
      "Cancel your active Baked Bazaar listing for an NFT and reclaim it. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the listed NFT mint"),
    },
  },
  tool(async (a: { mint: string }) => cancelListing(a)),
);

registerTool(
  "buy_nft",
  {
    title: "Buy a listed NFT (Baked Bazaar)",
    description:
      "Buy a listed NFT at its current listing price: funds escrow, bids, and settles the sale in one " +
      "transaction; the NFT lands in your wallet. Optionally pass `maxPrice` (COOK) as a guard. " +
      "Simulates before sending; enforces the per-trade spend cap (COOKIE_MAX_TRADE_COOK). Requires " +
      "COOKIE_PRIVATE_KEY.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the listed NFT mint to buy"),
      maxPrice: z
        .union([z.number().positive(), z.string()])
        .optional()
        .describe("refuse if the listing price (COOK) is above this"),
    },
  },
  tool(async (a: { mint: string; maxPrice?: string | number }) => buyNft(a)),
);

registerTool(
  "make_offer",
  {
    title: "Make an offer on an NFT (Baked Bazaar)",
    description:
      "Place a public offer (bid) on an NFT at `price` COOK. The COOK is escrowed with the auction " +
      "house until the offer is accepted or you cancel it. Simulates before sending; enforces the " +
      "spend cap. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the NFT mint to bid on"),
      price: z.union([z.number().positive(), z.string()]).describe("offer price in COOK"),
    },
  },
  tool(async (a: { mint: string; price: string | number }) => makeOffer(a)),
);

registerTool(
  "cancel_offer",
  {
    title: "Cancel an NFT offer (Baked Bazaar)",
    description:
      "Cancel your active offer on an NFT and withdraw the escrowed COOK back to your wallet. Requires " +
      "COOKIE_PRIVATE_KEY.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the NFT mint you bid on"),
    },
  },
  tool(async (a: { mint: string }) => cancelOffer(a)),
);

registerTool(
  "accept_offer",
  {
    title: "Accept an offer on your NFT (Baked Bazaar)",
    description:
      "Accept an offer on an NFT you own, selling it to the bidder for the escrowed COOK (minus the 1% " +
      "fee and royalties). Takes the highest active offer unless you pass `buyer`. Simulates before " +
      "sending. Requires COOKIE_PRIVATE_KEY.",
    inputSchema: {
      mint: z.string().min(32).max(44).describe("the NFT mint you own"),
      buyer: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("bidder wallet, if multiple offers exist"),
    },
  },
  tool(async (a: { mint: string; buyer?: string }) => acceptOffer(a)),
);

// Bridge — move COOK 1:1 between Cookie Chain and Solana mainnet over the Hyperlane warp route.
// One source-chain signature dispatches the transfer; a relayer delivers on the far side in a few
// minutes. Requires COOKIE_PRIVATE_KEY and the warp route program ids (COOKIE_WARP_PROGRAM_ID /
// SOLANA_WARP_PROGRAM_ID) in the environment.
registerTool(
  "bridge",
  {
    title: "Bridge COOK (Cookie Chain ⇄ Solana)",
    description:
      "Bridge COOK 1:1 between Cookie Chain and Solana mainnet via Hyperlane. `direction` is " +
      "'cookie-to-solana' (locks native COOK on Cookie, credits SPL COOK to the recipient's Solana " +
      "account) or 'solana-to-cookie' (locks SPL COOK on Solana, credits native COOK on Cookie). " +
      "`to` is the recipient on the DESTINATION chain (base58; both chains share your keypair, so it " +
      "defaults to your own wallet). `amount` is a UI amount of COOK. Signs and sends one transaction " +
      "on the source chain; a relayer delivers on the far side in a few minutes. Enforces the spend " +
      "cap and simulates first. Requires COOKIE_PRIVATE_KEY plus COOKIE_WARP_PROGRAM_ID / " +
      "SOLANA_WARP_PROGRAM_ID. Returns the source tx signature and the Hyperlane message id (use " +
      "bridge_status to confirm delivery); pass waitForDelivery to poll up to ~3 min inline. A wait " +
      "that times out is not a failure — the transfer is still in flight; re-check with bridge_status.",
    inputSchema: {
      direction: z.enum(["cookie-to-solana", "solana-to-cookie"]).describe("bridge direction"),
      to: z
        .string()
        .min(32)
        .max(44)
        .optional()
        .describe("recipient on the destination chain (base58); omit to bridge to your own wallet"),
      amount: z
        .union([z.number().positive(), z.string()])
        .describe("UI amount of COOK to bridge, e.g. 5"),
      waitForDelivery: z
        .boolean()
        .optional()
        .describe("poll the destination chain for delivery (up to ~3 min) before returning"),
    },
  },
  tool(
    async (a: {
      direction: BridgeDirection;
      to?: string;
      amount: string | number;
      waitForDelivery?: boolean;
    }) => bridge(a),
  ),
);

registerTool(
  "bridge_status",
  {
    title: "Bridge delivery status",
    description:
      "Check whether a bridged COOK transfer has been delivered on the destination chain, by its " +
      "Hyperlane message id (returned by `bridge`). `direction` must match the original transfer. " +
      "Returns delivered true/false and the destination-chain delivery tx once relayed. No wallet needed.",
    inputSchema: {
      messageId: z.string().describe("the Hyperlane message id from bridge (0x… 64 hex chars)"),
      direction: z
        .enum(["cookie-to-solana", "solana-to-cookie"])
        .describe("the direction of the original transfer"),
    },
  },
  tool(async (a: { messageId: string; direction: BridgeDirection }) => bridgeStatus(a)),
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
