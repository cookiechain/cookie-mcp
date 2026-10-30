// cookie-mcp — the MCP server for Cookie Chain, as a factory. `createServer()` registers every tool on
// a fresh `McpServer`; `server.ts` (the CLI) connects it to stdio or HTTP. Reads work with no key;
// money-moving tools sign with the configured signer: a local COOKIE_PRIVATE_KEY, or — in
// COOKIE_SIGNER=external mode — the user's own wallet, in which case they stop at the signing step and
// return `{ status: "needs_signature", ... }` for the caller to sign and hand to `submit_signed_tx`.
// Every tool returns JSON; failures return a structured { error, hint } — never a stack trace, never a
// secret.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { VERSION } from "../version";
import { SignatureRequired } from "../core/signer";
import { submitSignedTransaction } from "../core/submit";

import { DEFAULT_SLIPPAGE_BPS } from "../core/config";
import { CookieMcpError, toToolError } from "../core/errors";
import { withNativeFlags } from "../core/cookiebox";
import { getChainHealth } from "../core/health";
import { getPools } from "../core/pools";
import { getTokenInfo, searchTokens } from "../core/token";
import { getQuote } from "../core/quote";
import { getBalances, getSolanaBalances } from "../core/balances";
import { ownPublicKey, walletInfo } from "../core/wallet";
import { trade } from "../core/trade";
import { transfer } from "../core/transfer";
import { unwrapCook } from "../core/unwrap";
import {
  cancelLimitOrder,
  getLimitOrders,
  DEFAULT_EXPIRY_SECONDS,
  MAX_EXPIRY_SECONDS,
  type LimitOrderKind,
} from "../core/limitOrders";
import { placeOrder } from "../core/curveOrders";
import {
  MAX_CYCLE_FREQUENCY,
  MAX_CYCLES,
  MIN_CYCLE_FREQUENCY,
  closeDca,
  getDcaSchedules,
  openDca,
} from "../core/dca";
import { getZipOrders, MAX_RANGE_TICK_ARRAYS, MIN_STEP_MAX, startZip, stopZip } from "../core/zip";
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
import { getBridgeTokens } from "../core/bridgeRoutes";
import {
  buyDomain,
  cancelDomainListing,
  getDomainListings,
  getOwnedDomains,
  listDomain,
  registerDomain,
  resolveDomain,
  setPrimaryDomain,
  transferDomain,
  updateDomain,
} from "../core/domains";
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
import {
  borrow,
  DEFAULT_MIN_HEALTH_FACTOR,
  depositCollateral,
  getLendingMarkets,
  getLendingPosition,
  lend,
  repay,
  withdrawCollateral,
  withdrawLend,
} from "../core/lending";
import {
  claimNftDropProceeds,
  createNftDrop,
  getNftDrop,
  getNftDrops,
  graduateNftDrop,
  MAX_SETTLE_STEPS,
  mintNftDrop,
  redeemNftDrop,
  revealNftDrop,
  sellNftDrop,
  settleNftDropQueue,
  type CreateNftDropArgs,
  type NftDropFilter,
} from "../core/nftLaunchpad";

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
type ToolHandler<A> = (args: A, toolName: string) => Promise<ToolContent>;

/**
 * Wrap a tool handler so any throw becomes a structured `{error, hint}` result — except
 * `SignatureRequired`, which is not a failure: the flow ran every check and is handing a verified,
 * unsigned transaction (or a message) to whoever holds the key. That becomes a normal result with
 * `status: "needs_signature"` so the caller can sign it and continue via `submit_signed_tx`.
 */
function tool<A>(fn: (args: A) => Promise<unknown>): ToolHandler<A> {
  return async (args: A, toolName: string): Promise<ToolContent> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (e instanceof SignatureRequired) {
        return ok({ status: "needs_signature", tool: toolName, ...e.payload });
      }
      return fail(e);
    }
  };
}

const SIGNING_NOTE =
  " Requires a signer: COOKIE_PRIVATE_KEY locally, or in external-signer mode this returns " +
  "`needs_signature` for the user's wallet to sign (see submit_signed_tx).";

/** Build a fully configured cookie-mcp server. Cheap; the HTTP transport creates one per request. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "cookie-mcp", version: VERSION });

  // Simply-typed alias for registerTool. The SDK's generic signature infers handler args from the zod
  // inputSchema via deep conditional types that TS reports as TS2589 ("excessively deep") and OOMs on;
  // we annotate each handler's args explicitly instead. Keep using this wrapper for new tools.
  const registerTool = (
    name: string,
    config: { title?: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
    cb: ToolHandler<any>,
  ): unknown =>
    (
      server.registerTool as unknown as (
        n: string,
        c: typeof config,
        h: (args: any) => Promise<ToolContent>,
      ) => unknown
    )(name, config, (args: any) => cb(args, name));

  registerTool(
    "submit_signed_tx",
    {
      title: "Submit a wallet-signed transaction",
      description:
        "Second half of an externally signed action. When the server runs with an external signer " +
        "(no private key), every money-moving tool stops at the signing step and returns " +
        "`{ status: 'needs_signature', transactionBase64, submit, blockhash, lastValidBlockHeight, " +
        "what, step }`. Sign `transactionBase64` with the user's wallet WITHOUT modifying it (any " +
        "co-signatures would break; it was simulated and its effect on the wallet checked against " +
        "the request, but the user should still review it in their wallet), then call this with the " +
        "signed bytes and the " +
        "same `submit`, `blockhash`, `lastValidBlockHeight` and `what` fields (and `bazaarLog`, when " +
        "present, so the NFT marketplace indexes the trade). It sends on the named " +
        "route, confirms, and returns the signature. If the original result said `step: " +
        "'intermediate'`, call the original tool again afterwards to continue. Refuses bytes that " +
        "still lack a signature. Never builds or alters transactions.",
      inputSchema: {
        signedTransactionBase64: z.string().min(1).describe("the fully signed transaction, base64"),
        submit: z
          .union([
            z.object({ via: z.literal("cookie-rpc") }),
            z.object({ via: z.literal("solana-rpc") }),
            z.object({ via: z.literal("candyshop"), pools: z.array(z.string()).default([]) }),
          ])
          .optional()
          .describe("the `submit` object from needs_signature (default: the Cookie Chain RPC)"),
        blockhash: z.string().optional().describe("`blockhash` from needs_signature"),
        lastValidBlockHeight: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("`lastValidBlockHeight` from needs_signature"),
        what: z.string().optional().describe("`what` from needs_signature (names the action)"),
        bazaarLog: z
          .object({
            type: z.enum([
              "list",
              "cancel-listing",
              "buy",
              "offer",
              "cancel-offer",
              "accept-offer",
            ]),
            nftMint: z.string(),
            price: z.string().optional(),
          })
          .optional()
          .describe(
            "`bazaarLog` from needs_signature (NFT tools only): reported to Baked Bazaar once confirmed",
          ),
      },
    },
    tool(async (a: Parameters<typeof submitSignedTransaction>[0]) => submitSignedTransaction(a)),
  );

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
        "Liquidity pools across every Cookie Chain DEX (Cookiebox DAMM/CLMM, CookieSwap BAMM/xYBN) " +
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
      title: "Swap quote",
      description:
        "Quote a swap across all Cookie Chain DEX liquidity via one of two aggregators: `cookiebox` " +
        "(Cookiebox Swap API) or `cookiescan` (Candy Shop / Cookiescan Swap API). Quote both to " +
        "compare and pick the better output. Returns expected output, output after any aggregator " +
        "fee, minimum out after slippage, price impact, and the route. Quote-only — no wallet needed. " +
        "`amount` is a UI amount of the input token. Pass `chain: 'solana'` to price the bridged SPL " +
        "COOK (mint 36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1) against SOLANA MAINNET liquidity via " +
        "Jupiter. Scoped to COOK: one of inputMint/outputMint MUST be that mint — unrelated Solana " +
        "pairs are refused. Needs no RPC and no wallet. On that chain So1111..112 is wSOL, NOT COOK.",
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
        aggregator: z
          .enum(["cookiebox", "cookiescan"])
          .optional()
          .describe(
            'which swap aggregator to quote: cookiebox (default, no fee) or cookiescan (Candy Shop, ~20 bps fee). Cookie Chain only — ignored/rejected when chain is "solana", which always uses Jupiter',
          ),
        chain: z
          .enum(["cookie", "solana"])
          .optional()
          .describe(
            'which chain to quote on; defaults to cookie (Cookie Chain). "solana" quotes Solana mainnet via Jupiter and requires a COOK leg — note So1111..112 means COOK on Cookie Chain but wSOL on Solana',
          ),
      },
    },
    tool(
      async (a: {
        inputMint: string;
        outputMint: string;
        amount: string | number;
        slippageBps?: number;
        aggregator?: "cookiebox" | "cookiescan";
        chain?: "cookie" | "solana";
      }) => getQuote(a),
    ),
  );

  registerTool(
    "get_wallet",
    {
      title: "Configured wallet",
      description:
        "Which wallet this server acts for: the public key derived from COOKIE_PRIVATE_KEY (signer " +
        "'local'), or the wallet supplied by the request / COOKIE_WALLET_ADDRESS (signer 'external', " +
        "where money tools return needs_signature instead of signing), whether it is read-only, and " +
        "the Cookie Chain RPC it is pointed at. No arguments, no RPC " +
        "call — so it answers even when the chain is unreachable. Use it before any money-moving tool " +
        "to confirm the identity, and to tell apart the key a running server booted with from a key " +
        "that has since changed on disk. Never returns the secret.",
      inputSchema: {},
    },
    tool(async () => walletInfo()),
  );

  registerTool(
    "get_balance",
    {
      title: "Wallet balances",
      description:
        "Native COOK + SPL/Token-2022 token balances for a wallet, with USD values. Defaults to the " +
        "configured wallet (COOKIE_PRIVATE_KEY); pass `wallet` to inspect any address or .cook name. " +
        "In read-only mode (no key), `wallet` is required. Pass `chain: 'solana'` for the far side of " +
        "the Hyperlane bridge instead: the wallet's SPL COOK on Solana mainnet (what a " +
        "`solana-to-cookie` bridge spends) plus its SOL, which pays that transfer's fee and " +
        "interchain gas (and is what a SOL bridge spends), plus `bridgeTokens`: every other token the " +
        "bridge can move out of Solana, found on-chain so newly added ones appear too. It does not " +
        "enumerate unrelated Solana tokens.",
      inputSchema: {
        wallet: z
          .string()
          .min(1)
          .optional()
          .describe("wallet address (base58) or .cook name; omit to use the configured wallet"),
        chain: z
          .enum(["cookie", "solana"])
          .optional()
          .describe("which chain to read; defaults to cookie (Cookie Chain)"),
      },
    },
    tool(async (a: { wallet?: string; chain?: "cookie" | "solana" }) => {
      const wallet = a.wallet ?? ownPublicKey();
      if (!wallet) {
        throw new CookieMcpError(
          "no wallet address provided and no wallet configured",
          "pass a `wallet` address, or set COOKIE_PRIVATE_KEY to default to your own wallet",
        );
      }
      return a.chain === "solana" ? getSolanaBalances(wallet) : getBalances(wallet);
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
      title: "Swap",
      description:
        "Execute a swap via the chosen aggregator (`cookiebox` by default, or `cookiescan` = Candy " +
        "Shop): the aggregator quotes and builds the tx; we simulate, sign locally with the configured " +
        "wallet, submit, and confirm. Non-custodial. Requires COOKIE_PRIVATE_KEY. Use get_quote first " +
        "to compare aggregators. `amount` is a UI amount of the input token. Returns the tx signature " +
        "+ explorer link. Pass `chain: 'solana'` to buy or sell the bridged SPL COOK on SOLANA MAINNET " +
        "via Jupiter, paying fees in SOL. Scoped to COOK: one of inputMint/outputMint MUST be " +
        "36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1 — unrelated Solana pairs are refused. The SAME " +
        "COOKIE_PRIVATE_KEY signs on both chains, and that path requires SOLANA_RPC_URL to point at a " +
        "dedicated RPC (the public endpoint is refused). On Solana So1111..112 is wSOL, NOT COOK. " +
        "COOK and wCOOK (wrapped, SPL) share the native mint: pass `wrapCook: false` to pay from a " +
        "wCOOK balance, `unwrapCook: false` to receive wCOOK (cookiebox aggregator only).",
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
        aggregator: z
          .enum(["cookiebox", "cookiescan"])
          .optional()
          .describe(
            'which swap aggregator to execute through: cookiebox (default, no fee) or cookiescan (Candy Shop, ~20 bps fee). Cookie Chain only — rejected when chain is "solana", which always uses Jupiter',
          ),
        chain: z
          .enum(["cookie", "solana"])
          .optional()
          .describe(
            'which chain to swap on; defaults to cookie (Cookie Chain). "solana" buys/sells COOK on Solana mainnet via Jupiter (a COOK leg is required) and REQUIRES SOLANA_RPC_URL to be set to a dedicated RPC',
          ),
        wrapCook: z
          .boolean()
          .optional()
          .describe(
            "default true. false = the input is wCOOK: pay from the wallet's wrapped-COOK token account instead of wrapping native COOK. Cookiebox aggregator only",
          ),
        unwrapCook: z
          .boolean()
          .optional()
          .describe(
            "default true. false = receive wCOOK: leave a native-COOK output in the wallet's wrapped-COOK token account instead of unwrapping it. Cookiebox aggregator only",
          ),
        wrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `wrapCook` — same flag, kept for older callers"),
        unwrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `unwrapCook` — same flag, kept for older callers"),
      },
    },
    tool(
      async (a: {
        inputMint: string;
        outputMint: string;
        amount: string | number;
        slippageBps?: number;
        aggregator?: "cookiebox" | "cookiescan";
        chain?: "cookie" | "solana";
        wrapCook?: boolean;
        unwrapCook?: boolean;
        wrapSol?: boolean;
        unwrapSol?: boolean;
      }) => trade(withNativeFlags(a)),
    ),
  );

  registerTool(
    "get_limit_orders",
    {
      title: "Open limit orders",
      description:
        "Open limit / stop orders resting in the Cookiebox limit-order escrow for a wallet (yours by " +
        "default, or `owner` = any address or .cook name). Read straight from the chain via the " +
        "Cookiebox aggregator — no key needed. Each order shows the remaining input, the gross output " +
        "the program enforces (`minReceive`), what the wallet actually receives after the maker fee " +
        "(`netAfterFee`), the price (a stop's TRIGGER), fill progress, expiry and status " +
        "(`open` / `filling` / `expired` — an expired order still holds its input until it is " +
        "cancelled). `fees` is the live on-chain schedule in bps (null when unavailable). MomoSwap " +
        "curve orders placed on cookiebox.app appear too: `kind: 'curve-buy'` is an escrow order " +
        "that pays out as curve shares, `kind: 'curve-sell'` is a launchpad sale authorization — " +
        "`escrowed: false`, the shares stay spendable; cancel_limit_order revokes it.",
      inputSchema: {
        owner: z
          .string()
          .min(3)
          .max(64)
          .optional()
          .describe("wallet address or .cook name; defaults to the configured wallet"),
      },
    },
    tool(async (a: { owner?: string }) => getLimitOrders(a)),
  );

  registerTool(
    "place_limit_order",
    {
      title: "Place a limit or stop order",
      description:
        "Rest an order in the Cookiebox limit-order escrow: the input is locked in a program-owned " +
        "reserve and a keeper fills it through the same router `trade` uses once the executable rate " +
        "reaches the price, paying the pinned output account (partial fills possible). Requires " +
        "COOKIE_PRIVATE_KEY. `kind: 'limit'` (default, take-profit) fills at the price OR BETTER; the " +
        "price must sit ABOVE the current rate. `kind: 'stop'` is a stop-loss, stop-MARKET: `price` is " +
        "the TRIGGER, which must sit BELOW the current rate; once the rate falls to it the keeper " +
        "sells at market and passes the proceeds through — a hidden on-chain floor 50% below the " +
        "trigger (override with `floorPrice`) only caps what a rogue keeper could pay. Fee: the " +
        "maker receives the price minus the on-chain maker fee (10 bps at launch, read live); no " +
        "placement fee. Before signing, the built transaction is decoded and checked against the " +
        "request (maker, amounts, kind, pinned accounts, programs) and simulated. Refuses an order " +
        "that would fill or trigger immediately (use `trade` for that) unless `skipMarketCheck` is " +
        "set. Native COOK input is wrapped inside the same transaction; cancel / expiry refunds it as " +
        "COOK. Returns the `order` address for get_limit_orders / cancel_limit_order. MomoSwap " +
        "launchpad tokens still on their bonding curve are supported for the direct COOK pair only, " +
        "detected automatically (plain `limit` only): COOK → token is a `curve-buy`, an escrow order " +
        "the keeper fills into your launchpad position (shares, not SPL tokens; a one-time free " +
        "buy-for opt-in rides along on the first order); token → COOK is a `curve-sell`, a launchpad " +
        "sale authorization — NOTHING is escrowed, the shares stay spendable, the fill pays wCOOK to " +
        "your token account, it must expire within 30 days (no GTC), one per pool. Both are built " +
        "locally (the aggregator has no curve builder) and the buy is checked by the same verifier.",
      inputSchema: {
        inputMint: z.string().min(32).max(44).describe("token to sell (COOK/native mint for COOK)"),
        outputMint: z.string().min(32).max(44).describe("token to receive"),
        amount: z
          .union([z.number().positive(), z.string()])
          .describe("UI amount of the input token to sell, e.g. 10 for 10 COOK"),
        price: z
          .union([z.string(), z.number().positive()])
          .describe(
            'output per input in human units, the limit for a take-profit or the trigger for a stop. Pass a decimal STRING (e.g. "0.000012") for tiny prices — a number that would print in exponent form is refused',
          ),
        kind: z
          .enum(["limit", "stop"])
          .optional()
          .describe(
            "limit (default: take-profit, fills at price or better) or stop (stop-market sell once the rate falls to price)",
          ),
        expiresInSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_EXPIRY_SECONDS)
          .optional()
          .describe(
            `lifetime in seconds (default ${DEFAULT_EXPIRY_SECONDS} = 1 week, max one year); 0 = good-til-cancelled. An expired order is NOT auto-refunded until cancelled or reaped. A curve sell must expire within 30 days and cannot be GTC`,
          ),
        floorPrice: z
          .union([z.string(), z.number().positive()])
          .optional()
          .describe(
            "stop only: override the on-chain safety floor (default 50% below the trigger). Must be at or below the trigger. Not what you receive — a cap on a compromised keeper",
          ),
        wrapCook: z
          .boolean()
          .optional()
          .describe(
            "default true. When the input is COOK: wrap the lamport shortfall into wCOOK in the same tx and refund native COOK on cancel/expiry. false = pay from an existing wCOOK balance and be refunded wCOOK",
          ),
        unwrapCook: z
          .boolean()
          .optional()
          .describe(
            "default true. When the output is COOK: a fill pays native COOK to the wallet. false = receive wCOOK in the token account",
          ),
        wrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `wrapCook` — same flag, kept for older callers"),
        unwrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `unwrapCook` — same flag, kept for older callers"),
        skipMarketCheck: z
          .boolean()
          .optional()
          .describe(
            "default false. Place even if the order would fill/trigger at once against the current rate, or no route exists yet",
          ),
      },
    },
    tool(
      async (a: {
        inputMint: string;
        outputMint: string;
        amount: string | number;
        price: string | number;
        kind?: LimitOrderKind;
        expiresInSeconds?: number;
        floorPrice?: string | number;
        wrapCook?: boolean;
        unwrapCook?: boolean;
        wrapSol?: boolean;
        unwrapSol?: boolean;
        skipMarketCheck?: boolean;
      }) => placeOrder(withNativeFlags(a)),
    ),
  );

  registerTool(
    "cancel_limit_order",
    {
      title: "Cancel a limit order",
      description:
        "Cancel one of your open limit / stop orders and get the remaining input back. Requires " +
        "COOKIE_PRIVATE_KEY; only the maker can cancel. The refund lands in the order's pinned input " +
        "account (recreated first if it was closed); a native-COOK order is refunded as COOK, a " +
        "wCOOK-funded one is unwrapped in the same tx unless `unwrapCook: false`. Also how an EXPIRED " +
        "order's input is recovered. A `curve-sell` (a launchpad sale authorization, nothing escrowed) " +
        "is revoked directly on the launchpad instead — the shares never left the position, so the " +
        "result has `revoked: true` and no refund moves. The built transaction is decoded and checked " +
        "(your order, refund to you, known programs only) and simulated before signing.",
      inputSchema: {
        order: z.string().min(32).max(44).describe("the `order` address from get_limit_orders"),
        unwrapCook: z
          .boolean()
          .optional()
          .describe("default true. false = leave a wCOOK refund wrapped in the token account"),
        unwrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `unwrapCook` — same flag, kept for older callers"),
      },
    },
    tool(async (a: { order: string; unwrapCook?: boolean; unwrapSol?: boolean }) =>
      cancelLimitOrder(withNativeFlags(a)),
    ),
  );

  registerTool(
    "get_dca_schedules",
    {
      title: "Running DCA schedules",
      description:
        "DCA schedules running in the Cookiebox DCA escrow for a wallet (yours by default, or " +
        "`owner` = any address or .cook name). Read straight from the chain via the Cookiebox " +
        "aggregator — no key needed. A DCA buys a fixed slice of the budget on a clock: the whole " +
        "budget is escrowed at open and a keeper releases one slice per cycle. Each schedule shows " +
        "the budget, what is spent and left, the slice, how many cycles the PROGRAM derives, the " +
        "average price bought at so far (`averagePrice` — what a list of individual fills never " +
        "tells you), the optional per-cycle price band and when the next cycle is due. " +
        "`status: 'overdue'` means a cycle was MISSED: the program drops it rather than catching " +
        "it up, so it is a real loss, not a delay.",
      inputSchema: {
        owner: z
          .string()
          .min(3)
          .max(64)
          .optional()
          .describe("wallet address or .cook name; defaults to the configured wallet"),
      },
    },
    tool(async (a: { owner?: string }) => getDcaSchedules(a)),
  );

  registerTool(
    "open_dca",
    {
      title: "Open a DCA schedule",
      description:
        "Dollar-cost average into a token: the WHOLE budget is escrowed in a program-owned reserve " +
        "now, and the Cookiebox keeper releases one slice every `cycleSeconds` and swaps it through " +
        "the same router `trade` uses, paying the proceeds minus the maker fee (10 bps, 3 on a " +
        "stable pair — read live) into your pinned account. Requires COOKIE_PRIVATE_KEY. Split the " +
        "budget with EITHER `cycles` (the slice is rounded UP, which can retire the budget a cycle " +
        "early — the result reports the count the program actually derives) OR `amountPerCycle`. " +
        "The program, not the keeper, owns the schedule, so a stolen keeper key cannot accelerate " +
        "it. `minPrice` / `maxPrice` are an OPTIONAL per-cycle band on the output; a cycle outside " +
        "it — or with no route — is SKIPPED, never caught up, so a band quoted against a mid price " +
        "silently stalls the schedule (the executable rate for one slice is checked here and an " +
        "unsatisfiable band is refused unless `skipMarketCheck`). Native COOK input is wrapped " +
        "inside the same transaction and refunded as COOK on close. Not available on Token-2022 " +
        "mints or MomoSwap tokens still on their bonding curve (a cycle cannot buy on a curve). " +
        "Before signing, the built transaction is decoded and checked against the request (user, " +
        "amounts, frequency, band, start time, pinned accounts, programs) and simulated. Returns " +
        "the `dca` address for get_dca_schedules / close_dca.",
      inputSchema: {
        inputMint: z
          .string()
          .min(32)
          .max(44)
          .describe("token to spend (COOK/native mint for COOK)"),
        outputMint: z.string().min(32).max(44).describe("token to buy"),
        amount: z
          .union([z.number().positive(), z.string()])
          .describe("the WHOLE budget in UI units of the input token — all of it is escrowed now"),
        cycles: z
          .number()
          .int()
          .min(1)
          .max(MAX_CYCLES)
          .optional()
          .describe(
            `split the budget into this many cycles (slice rounded UP, so the real count can be one lower; max ${MAX_CYCLES}). Pass this OR amountPerCycle`,
          ),
        amountPerCycle: z
          .union([z.number().positive(), z.string()])
          .optional()
          .describe(
            "UI amount of the input token to spend per cycle, at most `amount`. Pass this OR cycles",
          ),
        cycleSeconds: z
          .number()
          .int()
          .min(MIN_CYCLE_FREQUENCY)
          .max(MAX_CYCLE_FREQUENCY)
          .describe(
            `seconds between cycles (${MIN_CYCLE_FREQUENCY}–${MAX_CYCLE_FREQUENCY}); e.g. 3600 hourly, 86400 daily, 604800 weekly`,
          ),
        minPrice: z
          .union([z.string(), z.number().positive()])
          .optional()
          .describe(
            "optional floor on the rate ONE cycle may fill at, output per input in human units (a decimal STRING for tiny prices). A cycle below it is skipped and never caught up",
          ),
        maxPrice: z
          .union([z.string(), z.number().positive()])
          .optional()
          .describe(
            "optional ceiling on the rate one cycle may fill at — guards against an implausibly good fill on a manipulated pool. A cycle above it is skipped",
          ),
        startAt: z
          .number()
          .int()
          .optional()
          .describe(
            "unix SECONDS for the first cycle; omit to start now. Must be in the future (the program clamps a past time to 'now', which would fire immediately)",
          ),
        wrapCook: z
          .boolean()
          .optional()
          .describe(
            "default true. When the input is COOK: wrap the lamport shortfall for the whole budget into wCOOK in the same tx and refund native COOK on close. false = pay from an existing wCOOK balance",
          ),
        unwrapCook: z
          .boolean()
          .optional()
          .describe(
            "default true. When the output is COOK: each cycle pays native COOK to the wallet. false = receive wCOOK in the token account",
          ),
        wrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `wrapCook` — same flag, kept for older callers"),
        unwrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `unwrapCook` — same flag, kept for older callers"),
        skipMarketCheck: z
          .boolean()
          .optional()
          .describe(
            "default false. Open even if no route exists yet or the band cannot be met at the current rate (every cycle would be skipped)",
          ),
      },
    },
    tool(
      async (a: {
        inputMint: string;
        outputMint: string;
        amount: string | number;
        cycles?: number;
        amountPerCycle?: string | number;
        cycleSeconds: number;
        minPrice?: string | number;
        maxPrice?: string | number;
        startAt?: number;
        wrapCook?: boolean;
        unwrapCook?: boolean;
        wrapSol?: boolean;
        unwrapSol?: boolean;
        skipMarketCheck?: boolean;
      }) => openDca(withNativeFlags(a)),
    ),
  );

  registerTool(
    "close_dca",
    {
      title: "Close a DCA schedule",
      description:
        "Stop one of your DCA schedules and get the UNSPENT remainder of the budget back; what the " +
        "schedule already bought is already in your wallet. Requires COOKIE_PRIVATE_KEY; only the " +
        "owner can close. The refund lands in the account pinned at open (recreated first if it was " +
        "closed); a schedule funded with native COOK is refunded as COOK, a wCOOK-funded one is " +
        "unwrapped in the same tx unless `unwrapCook: false`. A schedule that has spent its whole " +
        "budget closes itself and refunds its rent, so it will no longer be listed. The built " +
        "transaction is decoded and checked (your schedule, refund to you, known programs only) and " +
        "simulated before signing.",
      inputSchema: {
        dca: z.string().min(32).max(44).describe("the `dca` address from get_dca_schedules"),
        unwrapCook: z
          .boolean()
          .optional()
          .describe("default true. false = leave a wCOOK refund wrapped in the token account"),
        unwrapSol: z
          .boolean()
          .optional()
          .describe("DEPRECATED alias of `unwrapCook` — same flag, kept for older callers"),
      },
    },
    tool(async (a: { dca: string; unwrapCook?: boolean; unwrapSol?: boolean }) =>
      closeDca(withNativeFlags(a)),
    ),
  );

  registerTool(
    "get_zip_orders",
    {
      title: "Running Zip orders",
      description:
        "Zip orders (trailing range orders on Cookiebox CLMM positions, program `ZiPzPbbM…`) " +
        "running for a wallet — yours by default, or `owner` = any address or .cook name. Read " +
        "straight from the program; no key needed. A Zip turns a one-sided CLMM position into a " +
        "sell (or, seen from the other token, a buy) that cannot convert back: the Cookiebox keeper " +
        "keeps moving the range's trailing edge up to the price, and each move pays the part that " +
        "has filled to the owner's wallet. Each order reports what it sells and receives, its range " +
        "and the current price (as tokenB per tokenA — see `priceUnit`), what the position holds " +
        "right now (`inPosition`), who may crank it, and a `status` with the keeper's next move in " +
        "words: `filling` (edge moves on the next pass), `waiting` (price not far enough past the " +
        "edge, or inside the last tick spacing), `fully-filled` (the keeper withdraws everything " +
        "and closes the order next), `paused` (the NFT delegation is gone, a transfer hook has no " +
        "published extra-account list, a payout account was closed, or a tick array is missing — " +
        "start_zip with the order's `positionMint` repairs all but the hook without stopping " +
        "it), `empty`, or `stale` (the " +
        "position is gone; stop_zip refunds the order's rent).",
      inputSchema: {
        owner: z
          .string()
          .min(3)
          .max(64)
          .optional()
          .describe("wallet address or .cook name; defaults to the configured wallet"),
      },
    },
    tool(async (a: { owner?: string }) => getZipOrders(a)),
  );

  registerTool(
    "start_zip",
    {
      title: "Start a Zip on a CLMM position",
      description:
        "Turn one of your Cookiebox CLMM positions into a trailing range order: sell the token the " +
        "position holds into the other as the price moves through the range, WITHOUT the fill " +
        "converting back when the price turns. The Cookiebox keeper moves the range's trailing edge " +
        "to the price one tick spacing at a time (`minStep` spacings, default 1) and pays each " +
        "filled part — plus the LP fees earned on the way — to your wallet; once the whole range " +
        "has filled it withdraws the rest and closes the order. The position NFT stays in your " +
        "wallet: the order is only its SPL delegate, and the program lets that delegate move the " +
        "edge and finish, nothing else (it cannot withdraw elsewhere, widen the range, or re-buy). " +
        "Name the position by its NFT mint (`position`, as on cookiebox.app/position/<mint>) or by " +
        '`pool` (your position in that pool). `sell` is the mint to sell (or "COOK"); a ' +
        "one-sided position infers it, a position holding both tokens must be told. Refuses a " +
        "locked or empty position, a position that already has an order, a sell of a token the " +
        `position no longer holds, and a range wider than ${MAX_RANGE_TICK_ARRAYS} tick arrays. ` +
        "Starting is owner-paid setup, idempotent: your payout token accounts (~0.002 COOK each) " +
        "and any tick arrays the range spans (~0.002 COOK each, one-off per pool and range) are " +
        "created before `enable`; a wide range may take a few transactions (`intermediate` steps " +
        "for an external signer — call again to continue). `cranker` defaults to the Cookiebox " +
        "keeper; `anyone` leaves the order unpinned, which a hostile cranker can exploit to hand " +
        "most of it back unconverted. Payouts in COOK arrive as native COOK, never wCOOK. No " +
        "protocol fee. Stop any time with stop_zip. " +
        "OPEN AND ZIP IN ONE GO: pass `pool`, `sell`, `amount` (how much of `sell` to deposit) " +
        "and `priceLower`/`priceUpper` (tokenB per tokenA, as get_zip_orders reports prices) " +
        "to open a new one-sided position over that range first — the whole range must sit on the " +
        "`sell` side of the current price (above it to sell token A, below it to sell token B); the " +
        "result's `opened` carries the new position's NFT mint. REPAIR: on a position whose order " +
        "is already running, this recreates what a `paused` order is missing (tick arrays, payout " +
        "accounts, the NFT delegation) without stopping it, and refuses when nothing is missing. " +
        "Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        position: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe("the position NFT mint (or the position account). Pass this OR `pool`"),
        pool: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe(
            "a cookiebox-clmm pool address: zip your position in it (refused when you hold several — pass `position`)",
          ),
        sell: z
          .string()
          .min(3)
          .max(44)
          .optional()
          .describe(
            'mint of the token to SELL (one of the pool\'s two mints, or "COOK"). Optional for a position holding only one token',
          ),
        minStep: z
          .number()
          .int()
          .min(1)
          .max(MIN_STEP_MAX)
          .optional()
          .describe(
            "tick spacings the price must move past the trailing edge before it follows (default 1 = as close as the pool allows; larger = fewer, coarser moves)",
          ),
        cranker: z
          .string()
          .min(4)
          .max(44)
          .optional()
          .describe(
            'who may crank the order: omit for the Cookiebox keeper (recommended), "anyone", or a public key you run a keeper with',
          ),
        amount: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            "open a NEW position first: how much of `sell` to deposit (UI units). Needs `pool`, `sell`, `priceLower` and `priceUpper`",
          ),
        priceLower: z
          .union([z.string(), z.number()])
          .optional()
          .describe(
            "lower edge of the new position's range, as tokenB per tokenA (rounded to the pool's tick spacing)",
          ),
        priceUpper: z
          .union([z.string(), z.number()])
          .optional()
          .describe("upper edge of the new position's range, as tokenB per tokenA"),
      },
    },
    tool(
      async (a: {
        position?: string;
        pool?: string;
        sell?: string;
        minStep?: number;
        cranker?: string;
        amount?: string | number;
        priceLower?: string | number;
        priceUpper?: string | number;
      }) => startZip(a),
    ),
  );

  registerTool(
    "stop_zip",
    {
      title: "Stop a Zip order",
      description:
        "Cancel a Zip order on one of your positions: closes the order (its rent goes back to " +
        "the owner) and revokes the delegation on the position NFT. The position and its liquidity " +
        "are untouched — what has filled so far is already in your wallet, the rest stays in the " +
        "position exactly as it is (remove_liquidity / claim_fees as usual). The order's owner, or " +
        "whoever holds the position NFT now, may stop it. Name it by NFT mint, position account " +
        "or order address (`position`), or by `pool`. A `stale` order (position already closed) " +
        "stops too and refunds its rent. Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        position: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe(
            "the position NFT mint, the position account, or the order address (get_zip_orders `order`). Pass this OR `pool`",
          ),
        pool: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe("a cookiebox-clmm pool address: stop the order on your position in it"),
      },
    },
    tool(async (a: { position?: string; pool?: string }) => stopZip(a)),
  );

  registerTool(
    "transfer",
    {
      title: "Transfer COOK or a token",
      description:
        "Send native COOK (omit `mint` or use the COOK mint) or an SPL/Token-2022 token to another " +
        "wallet, creating the recipient's token account if needed. An optional `memo` is written to " +
        "the transaction through the SPL Memo program, signed by this wallet — pass it when paying " +
        "an invoice or payment request whose app matches transfers by memo. Simulates before " +
        "sending. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        to: z
          .string()
          .min(1)
          .describe('recipient wallet address (base58) or .cook name (e.g. "bot.cook")'),
        mint: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe("token mint to send; omit for native COOK"),
        amount: z.union([z.number().positive(), z.string()]).describe("UI amount to send"),
        memo: z
          .string()
          .min(1)
          .optional()
          .describe(
            "text recorded on-chain with the transfer via the SPL Memo program (UTF-8, up to 566 " +
              "bytes), e.g. an invoice reference; omit for a plain transfer",
          ),
      },
    },
    tool(async (a: { to: string; mint?: string; amount: string | number; memo?: string }) =>
      transfer(a),
    ),
  );

  registerTool(
    "unwrap_cook",
    {
      title: "Unwrap wCOOK to COOK",
      description:
        "Turn the wallet's whole wrapped-COOK (wCOOK) balance back into native COOK by closing its " +
        "wCOOK token account; the account's rent comes back too. wCOOK collects where a venue pays " +
        "out in it — MomoSwap launchpad referral earnings, NFT sell-backs, swaps run with " +
        "`unwrapCook: false` — and shows in get_balance as a token on the native mint. Fails early " +
        "when the wallet has no wCOOK account. Network fee only." +
        SIGNING_NOTE,
      inputSchema: {},
    },
    tool(async () => unwrapCook()),
  );

  registerTool(
    "stake",
    {
      title: "Stake COOK for bCOOK",
      description:
        "Stake COOK into the bCOOK liquid-staking pool (SPL Stake Pool): deposits COOK and mints bCOOK to " +
        "your wallet (≈ amount × 0.995 / rate, after the 0.5% deposit fee). bCOOK keeps earning as the rate " +
        "rises and stays liquid/transferable. Simulates first. Requires COOKIE_PRIVATE_KEY.",
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
        "`ended` means the launch window closed but nobody has settled the pool on-chain yet, so it is " +
        "neither tradeable nor claimable — filter for it explicitly, or use `all`, since a `live` filter " +
        "may or may not include such pools depending on the launchpad's deployed version. " +
        "Read-only — no key needed.",
      inputSchema: {
        status: z
          .enum(["live", "upcoming", "ended", "graduated", "expired", "all"])
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
        "A `status` of `ended` means trading closed but the pool is not settled on-chain yet — nothing can " +
        "be traded, and only a Fair-mode refund can be claimed (the claim settles the pool itself). " +
        "Read-only.",
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
          .min(1)
          .optional()
          .describe("wallet address or .cook name to inspect (defaults to your own wallet)"),
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
        "usually costs only account rent) plus any devBuyCook. " +
        "A LOGO IS REQUIRED: pass `imagePath` (preferred for a file on this machine — the server reads " +
        "and types it itself, so never base64 a local file yourself), `imageBase64` with " +
        "`imageMimeType` (for an image you generated), or `imageUrl` (downloaded and re-pinned, so the " +
        "logo outlives its original host). The bytes are pinned to IPFS either way. Launching without one is " +
        "refused unless you set `noLogo: true`, because the metadata is immutable and a logo can never " +
        "be added later. The mint address is chosen by the launchpad (the program requires one ending " +
        "in `momo`). Set `devBuyCook` (or `devBuyPctOfTotalSupply` for a share of the supply) to make " +
        "your own buy the atomic first trade. `maxCostCook` caps what the launch may cost (fee + dev " +
        "buy) and is required with devBuyPctOfTotalSupply; without it a creation fee above 2000 COOK " +
        "is refused. Requires " +
        "COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).max(32).describe("token name, max 32 chars"),
        symbol: z.string().min(1).max(10).describe("ticker, max 10 chars (upper-cased)"),
        description: z
          .string()
          .max(1000)
          .optional()
          .describe("short description for the token page"),
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
          .describe(
            "an already-hosted https image URL — its bytes are downloaded and re-pinned to IPFS, so " +
              "the logo survives the original host going away",
          ),
        imagePath: z
          .string()
          .optional()
          .describe(
            "path to a logo file on this machine (PNG/JPEG/GIF/WebP, max 5 MB, `~` ok) — preferred " +
              "over imageBase64 for a local file: the server reads the bytes and detects the type, " +
              "so the image never has to be base64'd through the conversation. Must sit inside the " +
              "home directory (or COOKIE_IMAGE_DIR) with no hidden folder in the path. Refused on a " +
              "hosted (HTTP / external-signer) server — use imageBase64 or imageUrl there",
          ),
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
        devBuyPctOfTotalSupply: z
          .number()
          .positive()
          .optional()
          .describe(
            "dev buy sized as a percent of the TOTAL supply (e.g. 1 for 1%), priced off the live " +
              "launch curve. Use this when the user asks for a share rather than a COOK amount — " +
              "note the launchpad UI quotes a dev buy against the SALE supply (80% of total), so the " +
              "same percent means two different amounts. Mutually exclusive with devBuyCook",
          ),
        noLogo: z
          .boolean()
          .optional()
          .describe(
            "launch deliberately without a logo. Only set this if the user asked for it — the token " +
              "metadata is immutable, so no logo can ever be added and most UIs show a blank image",
          ),
        maxCostCook: z
          .union([z.number().positive(), z.string()])
          .optional()
          .describe(
            "the most this launch may cost in COOK (creation fee + dev buy); refused before any spend " +
              "when the launchpad's numbers exceed it. Required with devBuyPctOfTotalSupply",
          ),
        loginSignature: z
          .object({ message: z.string().min(1), signature: z.string().min(1) })
          .optional()
          .describe(
            "external-signer mode only: the wallet's ed25519 signature (base58) over the launchpad " +
              "login `message` a previous deploy_token call returned as needs_signature " +
              "{ kind: 'message' }. Pass both back verbatim to complete the login and build the launch",
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
        imagePath?: string;
        website?: string;
        twitter?: string;
        telegram?: string;
        durationSecs?: number;
        expiryMode?: ExpiryMode;
        antiSnipe?: boolean;
        minBuyCook?: string | number;
        maxBuyPerWalletCook?: string | number;
        devBuyCook?: string | number;
        devBuyPctOfTotalSupply?: number;
        noLogo?: boolean;
        loginSignature?: { message: string; signature: string };
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
        "Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
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
        unwrap: z
          .boolean()
          .optional()
          .describe("unwrap the proceeds to native COOK (default true)"),
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
        "graduated → your real SPL tokens; expired (or `ended`) in fair mode → a pro-rata COOK refund; " +
        "expired in jackpot/survivor mode → your Merkle payout (the proof is fetched for you). A fair " +
        "refund works even on an `ended` pool that has not been settled on-chain yet — the claim settles " +
        "it too; the other modes have to wait for the expiry transition. Creators can pass " +
        "kind=creator_vest to claim their vested allocation after graduation. Dead-mode expiries have " +
        "no holder payout. Simulates before sending, so a claim that cannot land costs nothing. " +
        "Requires COOKIE_PRIVATE_KEY.",
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

  // NFT launchpad — MomoSwap NFT drops (momoswap.fun/nft): fixed-supply collections minted off a
  // bonding curve priced in COOK. Unlike launchpad tokens, the items are real NFTs in the wallet from
  // the first mint. While a drop is live a holder can sell an item back to the curve; once it
  // graduates part of the raise is a permanent floor every item can redeem against; a drop that ends
  // short refunds its holders pro rata. Every build is checked against the program's IDL, then
  // simulated within a spend budget, before it is signed.
  const DROP_REF = "the drop's collection mint (or any of its items' mints)";

  registerTool(
    "get_nft_drops",
    {
      title: "List NFT drops",
      description:
        "Browse MomoSwap NFT launchpad drops: name/symbol, collection mint, phase, minted vs supply, " +
        "graduation progress, floor price once graduated, royalty and the mint window. Phases: " +
        "`upcoming` (not open), `live` (minting off the curve; holders can sell back), `sold-out` " +
        "(waiting to graduate), `minting` (graduated at its target; the rest mint at random by " +
        "request), `graduated`, `ended` (closed short; holders redeem a refund). Defaults to live " +
        "drops. Use get_nft_drop for prices. Read-only — no key needed.",
      inputSchema: {
        status: z
          .enum(["live", "upcoming", "minting", "graduated", "ended", "all"])
          .optional()
          .describe("filter (default live)"),
        limit: z.number().int().min(1).max(100).optional().describe("max drops (default 20)"),
      },
    },
    tool(async (a: { status?: NftDropFilter; limit?: number }) => getNftDrops(a)),
  );

  registerTool(
    "get_nft_drop",
    {
      title: "NFT drop detail",
      description:
        "Full state of one MomoSwap NFT drop: phase, supply, curve quote for minting `count` items " +
        "(fee included, price per item), the post-graduation request price, floor and wind-down refund, " +
        "graduation target, royalty — and, for `owner` (default: this wallet), the items held, what " +
        "selling one back would pay now, and the exit that applies in this phase. If the wallet " +
        "created the drop, its unclaimed proceeds and, after a target graduation, the part of its " +
        "share still held back (`creatorHeldBack`: released as items mint, forfeited after its " +
        "deadline). Read-only.",
      inputSchema: {
        collection: z.string().min(32).max(44).describe(DROP_REF),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("items to quote a mint for (default 1)"),
        owner: z
          .string()
          .optional()
          .describe("wallet or .cook name whose items to list (defaults to your own wallet)"),
      },
    },
    tool(async (a: { collection: string; count?: number; owner?: string }) => getNftDrop(a)),
  );

  registerTool(
    "nft_drop_mint",
    {
      title: "Mint from an NFT drop",
      description:
        "Mint items from a live MomoSwap NFT drop, priced off its bonding curve (each mint costs a " +
        "little more than the last; the trade fee is on top). `count` 1–10, one transaction each, " +
        "sent in order; if one fails the ones already minted are kept and reported. Each item is " +
        "capped at `maxCookPerItem` (fee included) — or, without it, the current price plus " +
        "`slippageBps` (default 100 = 1%) — and the program refuses to charge more. After a drop " +
        "graduates at its target, a mint is a REQUEST: you pay now and a keeper settles a random " +
        "remaining item within seconds. A wallet may hold up to 10 requests open per drop, so `count` " +
        "places that many, one transaction each (an external signer places one per call). The art " +
        "stays hidden until the sale ends." +
        SIGNING_NOTE,
      inputSchema: {
        collection: z.string().min(32).max(44).describe(DROP_REF),
        count: z.number().int().min(1).max(10).optional().describe("items to mint (default 1)"),
        maxCookPerItem: z
          .union([z.number().positive(), z.string()])
          .optional()
          .describe("the most one item may cost in COOK, fee included"),
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("price tolerance when maxCookPerItem is not set (default 100 = 1%)"),
      },
    },
    tool(
      async (a: {
        collection: string;
        count?: number;
        maxCookPerItem?: string | number;
        slippageBps?: number;
      }) => mintNftDrop(a),
    ),
  );

  registerTool(
    "nft_drop_sell",
    {
      title: "Sell an NFT back to its drop",
      description:
        "Sell an item back to its MomoSwap drop's bonding curve for COOK at the current price, minus " +
        "the trade fee — the drop's guaranteed exit, available while the drop is live (or sold out and " +
        "not yet graduated). The item goes into the pool's inventory. After graduation use " +
        "nft_drop_redeem (floor) or list_nft instead. `minCook` refuses a sale below that." +
        SIGNING_NOTE,
      inputSchema: {
        nftMint: z.string().min(32).max(44).describe("the item's mint"),
        collection: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe("the drop's collection mint (looked up from the item when omitted)"),
        minCook: z
          .union([z.number().positive(), z.string()])
          .optional()
          .describe("refuse unless the sale pays at least this much COOK"),
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("price tolerance (default 100 = 1%)"),
      },
    },
    tool(
      async (a: {
        nftMint: string;
        collection?: string;
        minCook?: string | number;
        slippageBps?: number;
      }) => sellNftDrop(a),
    ),
  );

  registerTool(
    "nft_drop_redeem",
    {
      title: "Redeem an NFT drop item",
      description:
        "Burn an item of a MomoSwap NFT drop for COOK from the drop itself: after graduation, the " +
        "permanent floor (the locked share of the raise ÷ items outstanding — a redemption never moves " +
        "it); for a drop whose window closed short, the wind-down refund (the raise ÷ items " +
        "outstanding; the first refund also closes the drop on chain). Picks whichever applies; " +
        "get_nft_drop shows both amounts. Burning is final — compare with list_nft first." +
        SIGNING_NOTE,
      inputSchema: {
        nftMint: z.string().min(32).max(44).describe("the item's mint"),
        collection: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe("the drop's collection mint (looked up from the item when omitted)"),
      },
    },
    tool(async (a: { nftMint: string; collection?: string }) => redeemNftDrop(a)),
  );

  registerTool(
    "nft_drop_claim",
    {
      title: "Claim NFT drop proceeds",
      description:
        "For a drop's creator: claim the proceeds its creator vault holds (the creator's share of " +
        "trade fees, and the graduation payout). A royalty partner, if the drop has one, is paid " +
        "their share in the same transaction. Fails early when nothing has accrued." +
        SIGNING_NOTE,
      inputSchema: {
        collection: z.string().min(32).max(44).describe(DROP_REF),
      },
    },
    tool(async (a: { collection: string }) => claimNftDropProceeds(a)),
  );

  registerTool(
    "nft_drop_settle",
    {
      title: "Settle or refund a queued NFT mint",
      description:
        "After a drop graduates at its target, each mint is a request a keeper settles with a random " +
        "item. When nft_drop_mint returned `pending` and the item still hasn't arrived, this pushes " +
        "the drop's FIFO mint queue through this wallet's open requests (up to 10 per drop, all reported " +
        "in `yourRequests`): each head whose randomness is ready " +
        "is settled (its buyer gets the drawn item), each whose randomness expired (~3 minutes) is " +
        "refunded (its buyer gets price + fee back). Requests ahead of yours go to THEIR buyers, never " +
        "to you; you pay only network fees (a settle's rent is repaid in the same transaction, a refund " +
        "may open the buyer's wCOOK account). Up to " +
        MAX_SETTLE_STEPS +
        " heads per call; call again while any of `yourRequests` is still pending." +
        SIGNING_NOTE,
      inputSchema: {
        collection: z.string().min(32).max(44).describe(DROP_REF),
      },
    },
    tool(async (a: { collection: string }) => settleNftDropQueue(a)),
  );

  registerTool(
    "nft_drop_graduate",
    {
      title: "Graduate a sold-out NFT drop",
      description:
        "Graduate a sold-out MomoSwap NFT drop (phase `sold-out` in get_nft_drop). Permissionless: " +
        "anyone may send it, usually a keeper does. It locks the floor share of the raise for " +
        "nft_drop_redeem, releases the creator's share to nft_drop_claim and ends sell-backs. A drop " +
        "with a raise target graduates on the buy that reaches it, so this only applies at sell-out. " +
        "Network fee only." +
        SIGNING_NOTE,
      inputSchema: {
        collection: z.string().min(32).max(44).describe(DROP_REF),
      },
    },
    tool(async (a: { collection: string }) => graduateNftDrop(a)),
  );

  registerTool(
    "create_nft_drop",
    {
      title: "Launch an NFT drop",
      description:
        "Launch a fixed-supply NFT collection on the MomoSwap NFT launchpad. Every image in `artDir` " +
        "(PNG/JPEG/GIF/WebP, natural file-name order, optional Metaplex-style `<name>.json` beside each " +
        "for name + traits) becomes one item. The art is uploaded to IPFS, the order is sealed behind " +
        "a fairness commitment MomoSwap holds the seed for (so the creator cannot know which mint gets " +
        "which piece), and the art stays hidden until the sale ends. Price: `startPriceCook` is the " +
        "first item's all-in price; the curve ends near `curveMultiple`× that. At graduation " +
        "`floorLockPct` of the raise becomes a permanent floor and the creator gets the rest. " +
        "A launch is FINAL — the art, order, curve and royalty can never change — so run with " +
        "`dryRun: true` first and confirm the preview (prices, raise, floor) with the user. Reads local " +
        "files: refused on a hosted server. Signs a login message with the wallet (no fee), then the " +
        "create transaction (rent only, ~0.03 COOK; there is no creation fee)." +
        SIGNING_NOTE,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(24)
          .describe("collection name, max 24 bytes (items are `{name} #{n}`)"),
        symbol: z.string().min(1).max(10).describe("symbol, letters and digits, max 10"),
        description: z.string().max(500).optional().describe("collection description"),
        artDir: z
          .string()
          .min(1)
          .describe(
            "folder on this machine holding the art (2–10,000 images, max 25 MB each), inside the " +
              "home directory or COOKIE_IMAGE_DIR, no hidden folders",
          ),
        imagePath: z
          .string()
          .optional()
          .describe("collection image file (defaults to the first piece of art)"),
        bannerPath: z.string().optional().describe("optional banner image file (~3:1)"),
        placeholderPath: z
          .string()
          .optional()
          .describe("image collectors see before the reveal (defaults to the collection image)"),
        startPriceCook: z
          .union([z.number().positive(), z.string()])
          .describe("the first item's price in COOK, trade fee included"),
        curveMultiple: z
          .number()
          .min(1.2)
          .max(25)
          .optional()
          .describe("last item's price ÷ first (default 4; the site offers 2, 4 and 9)"),
        royaltyPct: z
          .number()
          .min(0)
          .max(20)
          .optional()
          .describe("creator royalty on secondary sales, % (default 5; capped by the launchpad)"),
        floorLockPct: z
          .number()
          .min(0)
          .max(50)
          .optional()
          .describe("share of the raise locked forever as the floor at graduation, % (default 20)"),
        royaltyPartner: z
          .string()
          .optional()
          .describe(
            "optional plain wallet (not a program or token account) that shares the creator's royalty and proceeds",
          ),
        partnerSharePct: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("the partner's share, % (required with royaltyPartner)"),
        graduationTargetPct: z
          .number()
          .min(50)
          .max(100)
          .optional()
          .describe(
            "graduate once the raise reaches this % of the sell-out raise; the remaining items then " +
              "mint at random by request (default 100 = graduate at sell-out)",
          ),
        launchAt: z
          .string()
          .optional()
          .describe("ISO date-time to open minting, up to 30 days ahead (default now)"),
        durationHours: z
          .number()
          .min(0.25)
          .max(720)
          .optional()
          .describe(
            "how long minting stays open, at most 720 (30 days, the program's cap) (default 24); a drop " +
              "that does not graduate by then refunds holders",
          ),
        maxPerWallet: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("items per wallet, 0 = no limit (default 0)"),
        antiSnipe: z
          .boolean()
          .optional()
          .describe("limit each wallet during the opening minutes (default true)"),
        allowlist: z
          .array(z.string())
          .max(10000)
          .optional()
          .describe("wallets that may mint first, during the allowlist phase"),
        allowlistHours: z
          .number()
          .positive()
          .optional()
          .describe("length of the allowlist phase in hours (default 1)"),
        website: z.string().optional().describe("https URL"),
        x: z.string().optional().describe("X profile https URL"),
        telegram: z.string().optional().describe("Telegram https URL"),
        discord: z.string().optional().describe("Discord https URL"),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "validate the art and preview the curve, raise and floor without uploading or signing",
          ),
      },
    },
    tool(async (a: CreateNftDropArgs) => createNftDrop(a)),
  );

  registerTool(
    "reveal_nft_drop",
    {
      title: "Reveal an NFT drop",
      description:
        "For a drop's creator, once it sold out, graduated or its window closed: record the reveal seed " +
        "on chain so anyone can check the item order against the commitment fixed at launch. Optional " +
        "— MomoSwap publishes the art when the sale ends either way. Signs a login message, then the " +
        "reveal transaction." +
        SIGNING_NOTE,
      inputSchema: {
        collection: z.string().min(32).max(44).describe(DROP_REF),
        loginSignature: z
          .object({ message: z.string().min(1), signature: z.string().min(1) })
          .optional()
          .describe(
            "external-signer mode only: the wallet's signature over the login `message` a previous " +
              "call returned as needs_signature { kind: 'message' }",
          ),
      },
    },
    tool(
      async (a: { collection: string; loginSignature?: { message: string; signature: string } }) =>
        revealNftDrop(a),
    ),
  );

  // Liquidity — Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap BAMM. Every op simulates before
  // sending; all are live-verified on Cookie Chain.
  registerTool(
    "create_pool",
    {
      title: "Create a pool",
      description:
        "Create a new pool for a token pair and seed it with an initial deposit (the deposit ratio sets " +
        "the starting price). `dex` selects the venue: cookiebox-damm (default), cookiebox-clmm " +
        "(concentrated liquidity, full-range seed, default 0.25% fee tier), or cookieswap-bamm " +
        "(concentrated liquidity; fee tier/tick spacing chosen by `ammConfig`, full-range seed). " +
        "Simulates before sending; caps the COOK side. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        dex: z
          .enum(["cookiebox-damm", "cookiebox-clmm", "cookieswap-bamm"])
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
            "CLMM/BAMM only: starting price as tokenB per tokenA; omit to derive from the amounts",
          ),
        ammConfig: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe(
            "BAMM only: AmmConfig address (selects fee tier/tick spacing); omit for the default",
          ),
      },
    },
    tool(
      async (a: {
        dex?: "cookiebox-damm" | "cookiebox-clmm" | "cookieswap-bamm";
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
        "or CookieSwap BAMM) is auto-detected from the pool. Concentrated-liquidity venues (CLMM/BAMM) " +
        "open a full-range position by default. Simulates before sending. Requires " +
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
        "remove for DAMM v2 and CLMM (default 10000 = all, which also closes a CLMM position); BAMM " +
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
      title: "Permanently lock liquidity (Cookiebox DAMM v2 / CLMM)",
      description:
        "⚠️ IRREVERSIBLE. Permanently locks your liquidity in a Cookiebox position; the venue is " +
        "auto-detected from the pool. DAMM v2 locks the position's unlocked liquidity; CLMM locks the " +
        "WHOLE position (the program offers no partial or vesting lock). Locked liquidity can never be " +
        "withdrawn and the position can never be closed, but fees stay claimable via claim_fees. Not " +
        "supported on CookieSwap BAMM. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        poolPk: z.string().min(32).max(44).describe("Cookiebox DAMM v2 or CLMM pool address"),
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
        "Cookiebox DAMM v2, Cookiebox CLMM, or CookieSwap BAMM). Sweeps fees to your wallet without " +
        "removing the position. Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        poolPk: z.string().min(32).max(44).describe("pool address you hold a position in"),
      },
    },
    tool(async (a: { poolPk: string }) => claimFees(a)),
  );

  // NFT marketplace — Baked Bazaar (Metaplex Auction House on Cookie Chain). Reads use the marketplace
  // indexer; every write builds the auction-house tx, simulates, signs locally, and confirms. COOK-
  // Requires COOKIE_PRIVATE_KEY for writes.
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
          .min(1)
          .optional()
          .describe("wallet address (base58) or .cook name; omit to use the configured wallet"),
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
          .min(1)
          .optional()
          .describe("wallet address (base58) or .cook name; omit to use the configured wallet"),
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
        "marketplace fee and creator royalties are taken from the sale proceeds when it sells. " +
        '`via: "momoswap"` lists a MomoSwap drop\'s item through MomoSwap instead: the same Baked ' +
        "Bazaar listing, plus MomoSwap's listing fee paid now (1% of the price, at least 0.001 COOK, " +
        "never more), reported as `listingFee`. Only on request: it is the same listing with a fee " +
        "on top, so it is never taken on its own.",
      inputSchema: {
        mint: z.string().min(32).max(44).describe("the NFT mint you own"),
        price: z
          .union([z.number().positive(), z.string()])
          .describe("sale price in COOK, e.g. 12.5"),
        via: z
          .enum(["momoswap"])
          .optional()
          .describe(
            'omit to list directly (no fee); "momoswap" to list a MomoSwap drop\'s item through MomoSwap, paying its listing fee now',
          ),
      },
    },
    tool(async (a: { mint: string; price: string | number; via?: "momoswap" }) => listNft(a)),
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
        "Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
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
        "house until the offer is accepted or you cancel it. Simulates before sending. " +
        "Requires COOKIE_PRIVATE_KEY.",
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

  // Bridge — move a token 1:1 between Cookie Chain and Solana mainnet over Hyperlane warp routes.
  // The routes are discovered on-chain (core/bridgeRoutes.ts), so a token the bridge adds later works
  // without a release. One source-chain signature dispatches the transfer; a relayer delivers on the
  // far side in a few minutes.
  registerTool(
    "get_bridge_tokens",
    {
      title: "List bridgeable tokens (Cookie Chain ⇄ Solana)",
      description:
        "List every token the Hyperlane bridge between Cookie Chain and Solana mainnet can move " +
        "(e.g. COOK, SOL), read live from the chain — a token added to the bridge shows up here as soon " +
        "as its route is live, with no update to this server. For each: the symbol, and per chain the " +
        "route type (native coin / minted on arrival / locked in escrow), the mint (null for the chain's " +
        "native coin) and decimals, plus `minimum`: the smallest amount bridge accepts, worth 15,000 COOK " +
        "right now. Use it to find the `token` to pass to bridge. No wallet needed.",
      inputSchema: {},
    },
    tool(async () => getBridgeTokens()),
  );

  registerTool(
    "bridge",
    {
      title: "Bridge a token (Cookie Chain ⇄ Solana)",
      description:
        "Bridge a token 1:1 between Cookie Chain and Solana mainnet via Hyperlane. `token` is the symbol " +
        "or mint (default COOK); get_bridge_tokens lists what can be bridged, including tokens added " +
        "after this server was released. COOK: native COOK on Cookie ⇄ SPL COOK on Solana. SOL: native " +
        "SOL on Solana ⇄ SOL on Cookie Chain (a token, mint 6tL24Fn7…onvucb — not Cookie's native coin). " +
        "`direction` is 'cookie-to-solana' or 'solana-to-cookie'. `to` is the recipient on the " +
        "DESTINATION chain (base58; both chains share your keypair, so it defaults to your own wallet). " +
        "`amount` is a UI amount of the token, at least the bridge minimum: whatever is worth 15,000 " +
        "COOK (15,000 COOK itself; SOL priced on Solana via Jupiter; get_bridge_tokens shows each " +
        "token's current minimum). Signs and sends one transaction on the source chain, paid " +
        "in that chain's native coin (COOK on Cookie, SOL on Solana) on top of the amount; a relayer " +
        "delivers on the far side in a few minutes. Simulates first, and preflights the far side before " +
        "signing: the destination's collateral must cover the release, and a native payout to an empty " +
        "wallet must reach the rent-exempt minimum. When the recipient has no token account for it on " +
        "the destination yet, `bridge` creates it from this wallet first (one extra tx, a little native " +
        "coin of account rent) — the warp route can do this itself but pays from a PDA that runs dry, " +
        "and when it is dry the delivery fails inside the relayer and the transfer hangs with no error " +
        "anywhere. Requires COOKIE_PRIVATE_KEY. Returns the source tx signature and the Hyperlane " +
        "message id (use bridge_status to confirm delivery); pass waitForDelivery to poll up to ~3 min " +
        "inline. A wait that times out is not a failure — the transfer is still in flight; re-check " +
        "with bridge_status.",
      inputSchema: {
        token: z
          .string()
          .min(1)
          .max(44)
          .optional()
          .describe(
            "token to bridge: a symbol (e.g. COOK, SOL) or its mint on either chain; default COOK",
          ),
        direction: z.enum(["cookie-to-solana", "solana-to-cookie"]).describe("bridge direction"),
        to: z
          .string()
          .min(32)
          .max(44)
          .optional()
          .describe(
            "recipient on the destination chain (base58); omit to bridge to your own wallet",
          ),
        amount: z
          .union([z.number().positive(), z.string()])
          .describe(
            "UI amount of the token to bridge, e.g. 5 — at least the amount worth 15,000 COOK",
          ),
        waitForDelivery: z
          .boolean()
          .optional()
          .describe("poll the destination chain for delivery (up to ~3 min) before returning"),
        createRecipientAccount: z
          .boolean()
          .optional()
          .describe(
            "create the recipient's token account on the destination from this wallet if they have " +
              "none (default true). False relies on the warp route's own ATA payer instead, and is " +
              "refused when that payer cannot cover the rent",
          ),
      },
    },
    tool(
      async (a: {
        token?: string;
        direction: BridgeDirection;
        to?: string;
        amount: string | number;
        waitForDelivery?: boolean;
        createRecipientAccount?: boolean;
      }) => bridge(a),
    ),
  );

  registerTool(
    "bridge_status",
    {
      title: "Bridge delivery status",
      description:
        "Check whether a bridged transfer (any token) has been delivered on the destination chain, by its " +
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

  // CookOven `.cook` names (book.cookoven.xyz) — Cookie Chain's name service. A name is a permanent,
  // non-expiring PDA owned by a wallet. Every tool below accepts the name with or without the `.cook`
  // suffix, and `transfer`, `get_balance`, `get_wallet_nfts`, `get_nft_offers` and
  // `get_launchpad_positions` accept a `.cook` name anywhere they take a wallet address.
  const DOMAIN_NAME_ARG = 'the .cook name, with or without the suffix (e.g. "bot" or "bot.cook")';

  registerTool(
    "resolve_domain",
    {
      title: "Resolve a .cook name",
      description:
        "Look up a .cook name on the CookOven name service: who owns it, when it was registered, its " +
        "resolver/metadata pointers, and whether it is the owner's primary name. If the name is NOT " +
        "registered, returns availability plus the live registration price (short 1–3 character names " +
        "cost more than 4+ character ones). Use this before register_domain — it is free and touches " +
        "no key. For the reverse direction (wallet → names) use get_owned_domains.",
      inputSchema: {
        name: z.string().min(1).describe(DOMAIN_NAME_ARG),
      },
    },
    tool(async (a: { name: string }) => resolveDomain(a.name)),
  );

  registerTool(
    "get_owned_domains",
    {
      title: "List a wallet's .cook names",
      description:
        "Every .cook name a wallet owns, plus which one is its primary (the name apps show instead of " +
        "the raw address). Defaults to the configured wallet; pass `wallet` to inspect any address or " +
        ".cook name. Reads the registry on-chain — no indexer, no key needed.",
      inputSchema: {
        wallet: z
          .string()
          .min(1)
          .optional()
          .describe("wallet address or .cook name; omit to use the configured wallet"),
      },
    },
    tool(async (a: { wallet?: string }) => getOwnedDomains(a.wallet)),
  );

  registerTool(
    "register_domain",
    {
      title: "Register a .cook name",
      description:
        "Claim an unregistered .cook name on the CookOven name service. ⚠️ EXPENSIVE and PERMANENT: " +
        "the price is set in USD by the registry and paid in COOK — thousands of COOK at the current " +
        "config — and registration is non-refundable with no expiry. `maxPriceCook` is REQUIRED as an " +
        "explicit spend confirmation: call resolve_domain (or this tool without it) to learn the live " +
        "price first, then pass that number. Refuses before signing if the name is taken or the price " +
        "exceeds `maxPriceCook`. Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).describe(DOMAIN_NAME_ARG),
        maxPriceCook: z
          .union([z.number().positive(), z.string()])
          .optional()
          .describe(
            "the most COOK you accept paying; omit to be told the live price without spending anything",
          ),
        setPrimary: z
          .boolean()
          .optional()
          .describe(
            "also make it this wallet's primary name, in the same transaction (default false)",
          ),
      },
    },
    tool(async (a: { name: string; maxPriceCook?: string | number; setPrimary?: boolean }) =>
      registerDomain(a),
    ),
  );

  registerTool(
    "set_primary_domain",
    {
      title: "Set or clear the primary .cook name",
      description:
        "Point this wallet's primary record at one of the .cook names it owns, so apps label it by " +
        "that name instead of its address. Pass `clear: true` instead of `name` to unset it (the " +
        "wallet keeps the name either way). Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).optional().describe(DOMAIN_NAME_ARG),
        clear: z
          .boolean()
          .optional()
          .describe("unset the current primary name instead of setting one"),
      },
    },
    tool(async (a: { name?: string; clear?: boolean }) => setPrimaryDomain(a)),
  );

  registerTool(
    "transfer_domain",
    {
      title: "Transfer a .cook name",
      description:
        "Hand a .cook name you own to another wallet. FINAL — only the new owner can move it again. " +
        "If the name is this wallet's primary, the primary record is cleared in the same instruction " +
        "so it cannot point at a name the wallet no longer owns. The recipient can be given as an " +
        "address or as a .cook name. Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).describe(DOMAIN_NAME_ARG),
        to: z.string().min(1).describe("recipient wallet address or .cook name"),
      },
    },
    tool(async (a: { name: string; to: string }) => transferDomain(a)),
  );

  registerTool(
    "update_domain",
    {
      title: "Update a .cook name's pointers",
      description:
        "Set or clear the `resolver` and `metadata` pubkey pointers on a .cook name you own. The " +
        'program stores them without interpreting them — they are hooks for apps. Pass "none" to clear ' +
        "one. At least one of `resolver`/`metadata` is required. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).describe(DOMAIN_NAME_ARG),
        resolver: z
          .string()
          .min(1)
          .optional()
          .describe('resolver account (base58), or "none" to clear it'),
        metadata: z
          .string()
          .min(1)
          .optional()
          .describe('metadata account (base58), or "none" to clear it'),
      },
    },
    tool(async (a: { name: string; resolver?: string; metadata?: string }) => updateDomain(a)),
  );

  // The `.cook` domain marketplace (market.cookoven.xyz) — the secondary market for names that are
  // already registered. Listing ESCROWS the name: while it is for sale the registry reports the
  // marketplace escrow as its owner, so the seller cannot transfer it, re-point it or set it as
  // primary, and `resolve_domain` reports the listing instead of a wallet.
  registerTool(
    "get_domain_listings",
    {
      title: "Browse .cook names for sale",
      description:
        "Every .cook name listed for sale on the CookOven domain marketplace, read straight from the " +
        "program — no indexer, no key needed. Filter by `name` (substring match), `seller`, " +
        "`maxPriceCook` or `maxLength` (short names are the scarce ones), and sort by 'price' " +
        "(cheapest first), 'length' or 'recent' (default). Also returns the live marketplace fee, " +
        "which the SELLER pays out of the sale price, and the floor price of the matched set. Use " +
        "resolve_domain for one specific name, or register_domain for a name nobody owns yet — the " +
        "market only holds names that are already registered.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .optional()
          .describe("only listings whose name contains this text (the .cook suffix is ignored)"),
        seller: z
          .string()
          .min(1)
          .optional()
          .describe("only listings from this wallet address or .cook name"),
        maxPriceCook: z
          .union([z.number().positive(), z.string()])
          .optional()
          .describe("only listings at or below this price in COOK"),
        maxLength: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("only names with at most this many characters"),
        sort: z
          .enum(["price", "recent", "length"])
          .optional()
          .describe(
            "price = cheapest first, length = shortest first, recent = newest first (default)",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("max listings to return (default 20)"),
      },
    },
    tool(
      async (a: {
        name?: string;
        seller?: string;
        maxPriceCook?: string | number;
        maxLength?: number;
        sort?: "price" | "recent" | "length";
        limit?: number;
      }) => getDomainListings(a),
    ),
  );

  registerTool(
    "list_domain",
    {
      title: "List a .cook name for sale",
      description:
        "Put a .cook name this wallet owns up for sale on the CookOven domain marketplace at " +
        "`priceCook`. ⚠️ The name moves into the marketplace ESCROW in the same instruction: until the " +
        "listing is bought or cancelled, the registry reports the escrow as its owner, so this wallet " +
        "cannot transfer the name, update its pointers or set it as primary, and the name no longer " +
        "resolves to a payable address. cancel_domain_listing reverses it at any time. There is no " +
        "re-price instruction — cancel and list again. Costs only the listing account's rent (~0.0018 " +
        "COOK, refunded when the listing ends); the marketplace fee is taken from the sale price, not " +
        "from you now. Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).describe(DOMAIN_NAME_ARG),
        priceCook: z
          .union([z.number().positive(), z.string()])
          .describe("asking price in COOK, e.g. 25000"),
      },
    },
    tool(async (a: { name: string; priceCook: string | number }) => listDomain(a)),
  );

  registerTool(
    "buy_domain",
    {
      title: "Buy a listed .cook name",
      description:
        "Buy a .cook name that is listed for sale, paying the seller and the marketplace fee in one " +
        "transaction; the name leaves escrow and belongs to this wallet, permanently. ⚠️ EXPENSIVE and " +
        "FINAL: listings run into the millions of COOK. `maxPriceCook` is REQUIRED as an explicit " +
        "spend confirmation — the instruction carries no price argument, so this cap is the only " +
        "guard. Called without it, this quotes the live asking price and spends nothing. Use " +
        "get_domain_listings to find names in budget. Simulates before sending. Requires " +
        "COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).describe(DOMAIN_NAME_ARG),
        maxPriceCook: z
          .union([z.number().positive(), z.string()])
          .optional()
          .describe(
            "the most COOK you accept paying; omit to be told the asking price without spending anything",
          ),
      },
    },
    tool(async (a: { name: string; maxPriceCook?: string | number }) => buyDomain(a)),
  );

  registerTool(
    "cancel_domain_listing",
    {
      title: "Unlist a .cook name",
      description:
        "Take a .cook name this wallet listed back off the CookOven domain marketplace. The escrow " +
        "returns it to this wallet and the listing rent is refunded, so transfer_domain, " +
        "update_domain and set_primary_domain work on it again. Only the wallet that created the " +
        "listing can cancel it. Simulates before sending. Requires COOKIE_PRIVATE_KEY.",
      inputSchema: {
        name: z.string().min(1).describe(DOMAIN_NAME_ARG),
      },
    },
    tool(async (a: { name: string }) => cancelDomainListing(a)),
  );

  // Lending — Aera (aera.cook): an overcollateralised COOK money market. Suppliers hold share tokens
  // (aCOOK / abCOOK) that grow with interest; borrowers lock abCOOK as collateral in an obligation
  // and borrow COOK. No API and no IDL: every instruction is hand-built from the program source and
  // the same-slot prelude (accrue / refresh_oracle / refresh_obligation) is prepended per action.
  const LENDING_ASSET_ARG =
    "reserve asset: `COOK` or `bCOOK` (case-insensitive), a share-token symbol (`aCOOK`), or a mint";
  const AMOUNT_OR_ALL = (what: string) => `UI amount of ${what}, or "all"`;

  registerTool(
    "get_lending_markets",
    {
      title: "Aera lending markets",
      description:
        "Every reserve of the Aera money market: total supplied / borrowed / available, utilization, " +
        "supply and borrow APR (projected to the current slot), caps, origination fee, collateral terms " +
        "(loan-to-value, liquidation threshold, bonus, haircut), the share token (aCOOK / abCOOK) and " +
        "its exchange rate, and each oracle's health. Only `borrowEnabled` reserves can be borrowed " +
        "(COOK) and only `collateralEnabled` ones can back a loan (bCOOK). No key needed.",
      inputSchema: {},
    },
    tool(async () => getLendingMarkets()),
  );

  registerTool(
    "get_lending_position",
    {
      title: "A wallet's Aera position",
      description:
        "What a wallet has on Aera: share tokens held per reserve and what they redeem for, and its " +
        "obligation — collateral, debt (interest projected to now), health factor (1.0 = liquidation " +
        "line), borrow headroom and how much more COOK can be borrowed. Defaults to the configured " +
        "wallet; pass `wallet` for any address or .cook name. No key needed.",
      inputSchema: {
        wallet: z
          .string()
          .min(1)
          .optional()
          .describe("wallet address or .cook name; omit to use the configured wallet"),
      },
    },
    tool(async (a: { wallet?: string }) => getLendingPosition(a.wallet)),
  );

  registerTool(
    "lend",
    {
      title: "Supply to Aera",
      description:
        "Supply COOK (or bCOOK) to its Aera reserve to earn the supply APR. Mints share tokens (aCOOK / " +
        "abCOOK) to your wallet that redeem for more of the asset as interest accrues; withdraw with " +
        "`withdraw_lend`. Respects the reserve and per-wallet supply caps (refuses before signing). To use " +
        "bCOOK as loan collateral call `deposit_collateral` instead — shares in the wallet do not back a " +
        "loan. Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        asset: z.string().min(1).describe(LENDING_ASSET_ARG),
        amount: z
          .union([z.number().positive(), z.string()])
          .describe("UI amount of the asset to supply, e.g. 1000"),
      },
    },
    tool(async (a: { asset: string; amount: string | number }) => lend(a)),
  );

  registerTool(
    "withdraw_lend",
    {
      title: "Withdraw from Aera",
      description:
        "Redeem share tokens held in your wallet (aCOOK / abCOOK) for the underlying asset. `amount` is " +
        'in the ASSET (what you want back), or "all" to redeem every share you hold. Limited by the ' +
        "reserve's available liquidity (the rest is lent out). Shares locked as collateral are not in " +
        "the wallet — use `withdraw_collateral` for those. Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        asset: z.string().min(1).describe(LENDING_ASSET_ARG),
        amount: z.union([z.number().positive(), z.string()]).describe(AMOUNT_OR_ALL("the asset")),
      },
    },
    tool(async (a: { asset: string; amount: string | number }) => withdrawLend(a)),
  );

  registerTool(
    "deposit_collateral",
    {
      title: "Deposit collateral on Aera",
      description:
        "Lock bCOOK as collateral so you can `borrow` COOK against it. One transaction: supplies the " +
        "bCOOK to its reserve, deposits the minted abCOOK shares into your obligation (created on first " +
        "use). `amount` is in bCOOK. Set `useHeldShares` to deposit abCOOK you already hold instead of " +
        "supplying new bCOOK. Collateral earns the bCOOK supply APR while locked. Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        amount: z
          .union([z.number().positive(), z.string()])
          .describe("UI amount of bCOOK to lock as collateral"),
        asset: z
          .string()
          .min(1)
          .optional()
          .describe("collateral asset; only needed if more than one reserve is collateral-enabled"),
        useHeldShares: z
          .boolean()
          .optional()
          .describe("deposit share tokens already in the wallet instead of supplying new bCOOK"),
      },
    },
    tool(async (a: { amount: string | number; asset?: string; useHeldShares?: boolean }) =>
      depositCollateral(a),
    ),
  );

  registerTool(
    "withdraw_collateral",
    {
      title: "Withdraw collateral from Aera",
      description:
        "Take collateral back out of your obligation and redeem it to bCOOK in the same transaction " +
        "(`keepShares` leaves the abCOOK shares in your wallet instead). `amount` is in bCOOK, or " +
        '"all". Refuses before signing if the remaining loan would exceed its loan-to-value limit or ' +
        `leave the health factor under \`minHealthFactor\` (default ${DEFAULT_MIN_HEALTH_FACTOR}; 1.0 is the ` +
        "liquidation line). Frozen while the bCOOK oracle is unhealthy. Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        amount: z.union([z.number().positive(), z.string()]).describe(AMOUNT_OR_ALL("bCOOK")),
        asset: z.string().min(1).optional().describe("collateral asset; only needed with several"),
        keepShares: z
          .boolean()
          .optional()
          .describe("keep the abCOOK share tokens instead of redeeming them for bCOOK"),
        minHealthFactor: z
          .number()
          .min(1)
          .optional()
          .describe(
            `refuse if the health factor after would be lower (default ${DEFAULT_MIN_HEALTH_FACTOR})`,
          ),
      },
    },
    tool(
      async (a: {
        amount: string | number;
        asset?: string;
        keepShares?: boolean;
        minHealthFactor?: number;
      }) => withdrawCollateral(a),
    ),
  );

  registerTool(
    "borrow",
    {
      title: "Borrow COOK on Aera",
      description:
        "Borrow COOK against your deposited collateral. `amount` is the debt you take on; the " +
        "origination fee (see get_lending_markets) is deducted from the payout and still owed. " +
        "Interest accrues per slot at the borrow APR; repay any time with `repay`. Refuses before " +
        "signing when the loan-to-value limit would be exceeded or the health factor would fall under " +
        `\`minHealthFactor\` (default ${DEFAULT_MIN_HEALTH_FACTOR}; 1.0 is the liquidation line — ` +
        "below that your collateral can be seized at a bonus to the liquidator). Needs " +
        "`deposit_collateral` first. Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        amount: z
          .union([z.number().positive(), z.string()])
          .describe("UI amount of COOK to borrow (debt taken on, before the fee)"),
        asset: z.string().min(1).optional().describe("asset to borrow; only needed with several"),
        minHealthFactor: z
          .number()
          .min(1)
          .optional()
          .describe(
            `refuse if the health factor after would be lower (default ${DEFAULT_MIN_HEALTH_FACTOR})`,
          ),
      },
    },
    tool(async (a: { amount: string | number; asset?: string; minHealthFactor?: number }) =>
      borrow(a),
    ),
  );

  registerTool(
    "repay",
    {
      title: "Repay an Aera loan",
      description:
        'Repay COOK debt. `amount` in COOK, or "all" to clear the loan (wraps a few slots of extra ' +
        "interest so it cannot come up short; the excess is returned in the same transaction). " +
        "Overpaying is safe: the program only takes what is owed. Repay works even while the protocol " +
        "is paused. Simulates first." +
        SIGNING_NOTE,
      inputSchema: {
        amount: z.union([z.number().positive(), z.string()]).describe(AMOUNT_OR_ALL("COOK")),
        asset: z.string().min(1).optional().describe("asset to repay; only needed with several"),
      },
    },
    tool(async (a: { amount: string | number; asset?: string }) => repay(a)),
  );

  return server;
}

export { SIGNING_NOTE };
