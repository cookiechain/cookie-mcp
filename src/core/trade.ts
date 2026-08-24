// trade — non-custodial swap through either aggregator: the aggregator quotes and builds the tx →
// simulate on our RPC → sign locally → submit → confirm. Cookiebox submits via our own RPC;
// Candy Shop submits/confirms via its own endpoints.
import { VersionedTransaction, Transaction, type Keypair } from "@solana/web3.js";

import {
  COOK_MINT,
  COOK_DECIMALS,
  COOK_SYMBOL,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_SWAP_AGGREGATOR,
  DEFAULT_SOLANA_RPC_URL,
  isPublicSolanaRpc,
  explorerTxUrl,
  solanaExplorerTxUrl,
  type SwapAggregator,
  type TradeChain,
} from "./config";
import { CookieMcpError } from "./errors";
import { fetchTokens } from "./cookiescan";
import {
  quoteMultiRoute,
  buildSwapTx,
  submitSignedTx,
  confirmTx,
  routePoolAddresses,
  type CandyShopMultiRoute,
} from "./candyshop";
import { buildAggSwapTx, routeFromAggQuote } from "./cookiebox";
import {
  quoteJup,
  buildJupSwapTx,
  routeFromJupQuote,
  resolveSolanaMeta,
  requireSolanaMeta,
  assertSolanaAggregator,
  assertSolanaCookPair,
} from "./jupiter";
import { getConnection, getSolanaConnection } from "./rpc";
import { requireWallet } from "./wallet";
import { rawToUi, uiToRaw } from "./format";
import { noRouteError } from "./launchpad";

interface TokenMeta {
  dec: number;
  sym: string | null;
  priceCook: number | null;
}

async function resolveMeta(
  inputMint: string,
  outputMint: string,
): Promise<{ input: TokenMeta; output: TokenMeta }> {
  const meta = (mint: string, registry: Awaited<ReturnType<typeof fetchTokens>>): TokenMeta => {
    if (mint === COOK_MINT) return { dec: COOK_DECIMALS, sym: COOK_SYMBOL, priceCook: 1 };
    const t = registry.find((x) => x.mint === mint);
    return {
      dec: t?.metadata?.decimals ?? 9,
      sym: t?.metadata?.symbol ?? null,
      priceCook: t?.price?.native ?? null,
    };
  };
  const needRegistry = inputMint !== COOK_MINT || outputMint !== COOK_MINT;
  const registry = needRegistry ? await fetchTokens() : [];
  return { input: meta(inputMint, registry), output: meta(outputMint, registry) };
}

function deserializeTx(base64: string): VersionedTransaction | Transaction {
  const bytes = Buffer.from(base64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

export function simErrorMessage(
  err: unknown,
  logs: string[] | null,
  chain: TradeChain = "cookie",
): CookieMcpError {
  const blob = `${JSON.stringify(err)} ${logs?.join(" ") ?? ""}`;
  if (/BlockhashNotFound|blockhash/i.test(blob)) {
    return new CookieMcpError(
      "swap simulation failed: blockhash not found",
      chain === "solana"
        ? "the RPC is behind the blockhash Jupiter built against — retry, or use a better-synced Solana RPC"
        : "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
    );
  }
  if (/insufficient|0x1\b/i.test(blob)) {
    return new CookieMcpError(
      "swap simulation failed: insufficient funds",
      chain === "solana"
        ? "check the wallet has enough of the input token plus SOL for fees and rent"
        : "check the wallet has enough of the input token plus COOK for fees",
    );
  }
  const tail = logs?.slice(-3).join(" | ");
  return new CookieMcpError(
    `swap simulation failed${tail ? `: ${tail}` : ""}`,
    "the route may be stale or the pool state changed; re-quote and retry",
  );
}

async function signAndSerialize(
  tx: VersionedTransaction | Transaction,
  keypair: Keypair,
): Promise<string> {
  if (tx instanceof VersionedTransaction) {
    tx.sign([keypair]);
  } else {
    tx.partialSign(keypair);
  }
  return Buffer.from(tx.serialize()).toString("base64");
}

export interface TradeResult {
  signature: string;
  confirmed: boolean;
  explorerUrl: string;
  chain: TradeChain;
  aggregator: SwapAggregator;
  /** Present only when the swap was submitted but not observed as confirmed — retrying is unsafe. */
  warning?: string;
  input: { mint: string; symbol: string | null; amount: string };
  output: { mint: string; symbol: string | null; expectedOut: string; minOut: string };
  aggregatorFeeBps: number | null;
  route: { venues: string[]; split: boolean; multiHop: boolean };
  /** Solana only: the priority fee Jupiter budgeted, in lamports. */
  priorityFeeLamports?: number | null;
}

export async function trade(args: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps?: number;
  aggregator?: SwapAggregator;
  chain?: TradeChain;
}): Promise<TradeResult> {
  const { keypair } = requireWallet();
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const chain = args.chain ?? "cookie";
  if (args.inputMint === args.outputMint) {
    throw new CookieMcpError("inputMint and outputMint are the same", "pick two different tokens");
  }
  if (chain === "solana") return tradeSolana(args, slippageBps, keypair);
  const aggregator = args.aggregator ?? DEFAULT_SWAP_AGGREGATOR;

  const { input, output } = await resolveMeta(args.inputMint, args.outputMint);

  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, input.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is a UI amount of the input token (max ${input.dec} decimals)`,
    );
  }
  if (amountRaw <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive input amount");
  }

  // "No route" for a launchpad token that hasn't graduated is expected — it trades on its bonding
  // curve, not a pool — so point the caller at the launchpad tools rather than at liquidity.
  let multiRoute: CandyShopMultiRoute;
  let transactionBase64: string;
  // Cookiebox returns the blockhash/height its tx was built against, so we confirm on our RPC.
  let aggBlockhash: { blockhash: string; lastValidBlockHeight: number } | null = null;
  if (aggregator === "cookiebox") {
    let built;
    try {
      // One call quotes AND builds (the server re-quotes at build time anyway).
      built = await buildAggSwapTx({
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        amount: amountRaw.toString(),
        slippageBps,
        owner: keypair.publicKey.toBase58(),
      });
    } catch (e) {
      // A 422 "route too large" is a build-size failure, not a missing route — don't let it be
      // rewritten into the (misleading) no-route/launchpad message. Rare now that the agg keeps a
      // server-owned lookup table, but still possible (e.g. agg deployed without its ALT keypair).
      if (e instanceof Error && /too large/i.test(e.message)) {
        throw new CookieMcpError(
          "swap route is too large to build into a single transaction",
          "a route did exist — try a smaller amount, or retry later (the aggregator may be running without its lookup-table authority)",
        );
      }
      throw await noRouteError([args.inputMint, args.outputMint], e);
    }
    multiRoute = routeFromAggQuote(built.route);
    transactionBase64 = built.transactionBase64;
    aggBlockhash = {
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    };
  } else {
    try {
      ({ multiRoute } = await quoteMultiRoute(
        args.inputMint,
        args.outputMint,
        amountRaw.toString(),
        slippageBps,
      ));
    } catch (e) {
      throw await noRouteError([args.inputMint, args.outputMint], e);
    }
    if (!multiRoute?.segments?.length) {
      throw await noRouteError([args.inputMint, args.outputMint]);
    }
    if (multiRoute.lowLiquidity) {
      throw new CookieMcpError(
        "route has low liquidity — swap would move the price a lot",
        "reduce the amount or choose a more liquid token",
      );
    }
    ({ transactionBase64 } = await buildSwapTx(multiRoute, keypair.publicKey.toBase58()));
  }

  const conn = getConnection();
  const tx = deserializeTx(transactionBase64);

  // replaceRecentBlockhash so a confirmed-RPC sim isn't rejected for a blockhash it doesn't yet know;
  // the tx we submit is unchanged.
  const sim =
    tx instanceof VersionedTransaction
      ? await conn.simulateTransaction(tx, {
          replaceRecentBlockhash: true,
          sigVerify: false,
          commitment: "confirmed",
        })
      : await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw simErrorMessage(sim.value.err, sim.value.logs ?? null);
  }

  const signedBase64 = await signAndSerialize(tx, keypair);

  let signature: string;
  let finalConfirmed: boolean;
  if (aggBlockhash) {
    // Cookiebox agg: submit + confirm on our own RPC against the blockhash the tx was built with.
    signature = await conn.sendRawTransaction(Buffer.from(signedBase64, "base64"));
    try {
      const conf = await conn.confirmTransaction({ signature, ...aggBlockhash }, "confirmed");
      if (conf.value.err) {
        throw new CookieMcpError(
          `swap landed but failed on-chain: ${JSON.stringify(conf.value.err)}`,
          `no tokens were swapped (only the tx fee was spent) — see ${explorerTxUrl(signature)}`,
        );
      }
      finalConfirmed = true;
    } catch (e) {
      if (e instanceof CookieMcpError) throw e;
      finalConfirmed = false; // confirmation timed out — the tx may still land
    }
  } else {
    const submitted = await submitSignedTx(signedBase64);
    signature = submitted.signature;
    finalConfirmed = submitted.confirmed;
    if (!finalConfirmed) {
      try {
        finalConfirmed = (await confirmTx(signature, routePoolAddresses(multiRoute))).confirmed;
      } catch {
        /* leave as reported by submit */
      }
    }
  }

  const gross = multiRoute.grossOutAmount ?? multiRoute.totalOutAmount;
  return {
    signature,
    confirmed: finalConfirmed,
    explorerUrl: explorerTxUrl(signature),
    chain,
    aggregator,
    // The swap was submitted either way. Unconfirmed ≠ failed, and a retried swap is a second real
    // swap, so say so instead of letting `confirmed: false` read as "nothing happened".
    ...(finalConfirmed
      ? {}
      : {
          warning:
            `the swap was submitted but is not confirmed yet — DO NOT retry blindly, it may still ` +
            `land. Check ${explorerTxUrl(signature)}; Cookie Chain finalization stalls can delay ` +
            `confirmation (see chain_health).`,
        }),
    input: {
      mint: args.inputMint,
      symbol: input.sym,
      amount: rawToUi(multiRoute.totalInAmount, input.dec),
    },
    output: {
      mint: args.outputMint,
      symbol: output.sym,
      expectedOut: rawToUi(gross, output.dec),
      minOut: rawToUi(multiRoute.minOutAmount, output.dec),
    },
    aggregatorFeeBps: multiRoute.protocolFeeBps ?? null,
    route: {
      venues: [...new Set(multiRoute.segments.map((s) => s.programName ?? s.dex))],
      split: Boolean(multiRoute.isSplit),
      multiHop: Boolean(multiRoute.isMultiHop),
    },
  };
}

/**
 * Swap on SOLANA MAINNET via Jupiter. Same non-custodial shape as the Cookie Chain paths: Jupiter
 * quotes and builds, we simulate on the Solana RPC, sign locally, send, confirm.
 *
 * Jupiter's tx carries its own blockhash, so we never call getLatestBlockhash — the RPC only has to
 * simulate, send, and confirm.
 */
async function tradeSolana(
  args: {
    inputMint: string;
    outputMint: string;
    amount: string | number;
    aggregator?: SwapAggregator;
  },
  slippageBps: number,
  keypair: Keypair,
): Promise<TradeResult> {
  assertSolanaAggregator(args.aggregator);
  assertSolanaCookPair(args.inputMint, args.outputMint);
  // A swap is far less forgiving than the bridge: the public endpoint throttles sendTransaction
  // hardest, and a send that lands late against a slippage cap FAILS rather than merely arriving
  // slowly. Refuse up front instead of shipping an intermittently-failing money tool.
  if (isPublicSolanaRpc()) {
    throw new CookieMcpError(
      "a Solana swap needs a dedicated RPC, not the throttled public endpoint",
      `set SOLANA_RPC_URL to your own Solana mainnet RPC (a free Helius/Triton/QuickNode key is enough) — the default ${DEFAULT_SOLANA_RPC_URL} rate-limits sendTransaction and a late send fails against slippage. get_quote {chain:"solana"} needs no RPC and still works.`,
    );
  }

  const meta = await resolveSolanaMeta([args.inputMint, args.outputMint]);
  const input = requireSolanaMeta(meta, args.inputMint);
  const output = requireSolanaMeta(meta, args.outputMint);

  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, input.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is a UI amount of the input token (max ${input.dec} decimals)`,
    );
  }
  if (amountRaw <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", "pass a positive input amount");
  }

  const jup = await quoteJup(args.inputMint, args.outputMint, amountRaw.toString(), slippageBps);
  if (!jup) {
    throw new CookieMcpError(
      "no Solana route for this pair",
      "Jupiter found no route — check both mints trade on Solana mainnet, or try a smaller amount",
    );
  }
  const multiRoute = routeFromJupQuote(jup);
  const built = await buildJupSwapTx({ quote: jup, owner: keypair.publicKey.toBase58() });

  const conn = getSolanaConnection();
  const tx = deserializeTx(built.transactionBase64);

  // Unlike the Cookie Chain path we do NOT replaceRecentBlockhash: Jupiter built the tx against a
  // real mainnet blockhash that this RPC knows, and the blockhash is what confirmation tracks.
  const sim =
    tx instanceof VersionedTransaction
      ? await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" })
      : await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw simErrorMessage(sim.value.err, sim.value.logs ?? null, "solana");
  }

  const signedBase64 = await signAndSerialize(tx, keypair);
  const signature = await conn.sendRawTransaction(Buffer.from(signedBase64, "base64"));

  const blockhash =
    tx instanceof VersionedTransaction ? tx.message.recentBlockhash : tx.recentBlockhash;
  let finalConfirmed: boolean;
  try {
    const conf = await conn.confirmTransaction(
      { signature, blockhash: blockhash!, lastValidBlockHeight: built.lastValidBlockHeight },
      "confirmed",
    );
    if (conf.value.err) {
      throw new CookieMcpError(
        `swap landed but failed on-chain: ${JSON.stringify(conf.value.err)}`,
        `no tokens were swapped (only the tx fee was spent) — see ${solanaExplorerTxUrl(signature)}`,
      );
    }
    finalConfirmed = true;
  } catch (e) {
    if (e instanceof CookieMcpError) throw e;
    finalConfirmed = false; // confirmation timed out — the tx may still land
  }

  const gross = multiRoute.grossOutAmount ?? multiRoute.totalOutAmount;
  return {
    signature,
    confirmed: finalConfirmed,
    explorerUrl: solanaExplorerTxUrl(signature),
    chain: "solana",
    aggregator: "jupiter",
    ...(finalConfirmed
      ? {}
      : {
          warning:
            `the swap was submitted to Solana but is not confirmed yet — DO NOT retry blindly, it ` +
            `may still land. Check ${solanaExplorerTxUrl(signature)}.`,
        }),
    input: {
      mint: args.inputMint,
      symbol: input.sym,
      amount: rawToUi(multiRoute.totalInAmount, input.dec),
    },
    output: {
      mint: args.outputMint,
      symbol: output.sym,
      expectedOut: rawToUi(gross, output.dec),
      minOut: rawToUi(multiRoute.minOutAmount, output.dec),
    },
    aggregatorFeeBps: multiRoute.protocolFeeBps ?? null,
    route: {
      venues: [...new Set(multiRoute.segments.map((s) => s.programName ?? s.dex))],
      split: Boolean(multiRoute.isSplit),
      multiHop: Boolean(multiRoute.isMultiHop),
    },
    priorityFeeLamports: built.prioritizationFeeLamports,
  };
}
