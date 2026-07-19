// trade — swap via Candy Shop, non-custodial: quote → Candy Shop builds the tx → simulate on our RPC
// → sign locally → submit → confirm. The spend cap (valued in COOK) is enforced before anything is built.
import { VersionedTransaction, Transaction, type Keypair } from "@solana/web3.js";

import {
  COOK_MINT,
  COOK_DECIMALS,
  COOK_SYMBOL,
  DEFAULT_SLIPPAGE_BPS,
  explorerTxUrl,
} from "./config";
import { CookieMcpError } from "./errors";
import { fetchTokens } from "./cookiescan";
import {
  quoteMultiRoute,
  buildSwapTx,
  submitSignedTx,
  confirmTx,
  routePoolAddresses,
} from "./candyshop";
import { getConnection } from "./rpc";
import { requireWallet, assertWithinSpendCap } from "./wallet";
import { rawToUi, uiToRaw } from "./format";

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

export function simErrorMessage(err: unknown, logs: string[] | null): CookieMcpError {
  const blob = `${JSON.stringify(err)} ${logs?.join(" ") ?? ""}`;
  if (/BlockhashNotFound|blockhash/i.test(blob)) {
    return new CookieMcpError(
      "swap simulation failed: blockhash not found",
      "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
    );
  }
  if (/insufficient|0x1\b/i.test(blob)) {
    return new CookieMcpError(
      "swap simulation failed: insufficient funds",
      "check the wallet has enough of the input token plus COOK for fees",
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
  input: { mint: string; symbol: string | null; amount: string };
  output: { mint: string; symbol: string | null; expectedOut: string; minOut: string };
  candyShopFeeBps: number | null;
  route: { venues: string[]; split: boolean; multiHop: boolean };
}

export async function trade(args: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps?: number;
}): Promise<TradeResult> {
  const { keypair } = requireWallet();
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (args.inputMint === args.outputMint) {
    throw new CookieMcpError("inputMint and outputMint are the same", "pick two different tokens");
  }

  const { input, output } = await resolveMeta(args.inputMint, args.outputMint);

  // Spend cap first — before quoting or building anything.
  const amountUi = Number(args.amount);
  assertWithinSpendCap(amountUi, input.priceCook);

  let amountRaw: bigint;
  try {
    amountRaw = uiToRaw(args.amount, input.dec);
  } catch {
    throw new CookieMcpError(
      `invalid amount "${args.amount}"`,
      `amount is a UI amount of the input token (max ${input.dec} decimals)`,
    );
  }

  const { multiRoute } = await quoteMultiRoute(
    args.inputMint,
    args.outputMint,
    amountRaw.toString(),
    slippageBps,
  );
  if (!multiRoute?.segments?.length) {
    throw new CookieMcpError(
      "no route found for this pair",
      "the pair may lack liquidity; try a smaller amount or a more liquid token",
    );
  }
  if (multiRoute.lowLiquidity) {
    throw new CookieMcpError(
      "route has low liquidity — swap would move the price a lot",
      "reduce the amount or choose a more liquid token",
    );
  }

  const conn = getConnection();
  const { transactionBase64 } = await buildSwapTx(multiRoute, keypair.publicKey.toBase58());
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
  const { signature, confirmed } = await submitSignedTx(signedBase64);

  let finalConfirmed = confirmed;
  if (!finalConfirmed) {
    try {
      finalConfirmed = (await confirmTx(signature, routePoolAddresses(multiRoute))).confirmed;
    } catch {
      /* leave as reported by submit */
    }
  }

  const gross = multiRoute.grossOutAmount ?? multiRoute.totalOutAmount;
  return {
    signature,
    confirmed: finalConfirmed,
    explorerUrl: explorerTxUrl(signature),
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
    candyShopFeeBps: multiRoute.protocolFeeBps ?? null,
    route: {
      venues: [...new Set(multiRoute.segments.map((s) => s.programName ?? s.dex))],
      split: Boolean(multiRoute.isSplit),
      multiHop: Boolean(multiRoute.isMultiHop),
    },
  };
}
