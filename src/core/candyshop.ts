// Candy Shop aggregator client (swap.cookiescan.io/api) — the swap quote + execution engine, routing
// across all Cookie Chain DEX liquidity. Plain fetch; the server is Node-side so it calls the API
// directly (no CORS proxy). Flow: quote → buildSwapTx → sign locally → submitSignedTx → confirmTx.
// Candy Shop takes a ~20 bps fee: grossOutAmount − protocolFeeAmount = totalOutAmount.
import { COOKIE_SWAP_API_URL } from "./config";
import { fetchJson } from "./http";

export interface CandyShopRouteSegment {
  dex: string;
  poolAddress: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  feeBps?: number;
  percentage?: number;
  hopIndex?: number;
  inputMint?: string;
  outputMint?: string;
  programName?: string;
}

export interface CandyShopMultiRoute {
  segments: CandyShopRouteSegment[];
  totalInAmount: string;
  totalOutAmount: string;
  combinedPriceImpactPct: number;
  minOutAmount: string;
  grossOutAmount?: string;
  protocolFeeAmount?: string;
  protocolFeeBps?: number;
  route: string[];
  isSplit: boolean;
  isMultiHop: boolean;
  programName?: string;
  lowLiquidity?: boolean;
}

export interface CandyShopQuoteResult {
  multiRoute: CandyShopMultiRoute;
  snapshotVersion?: number;
}
export interface CandyShopSwapTxResult {
  transactionBase64: string;
}
export interface CandyShopSubmitTxResult {
  signature: string;
  confirmed: boolean;
}
export interface CandyShopConfirmTxResult {
  confirmed: boolean;
  error?: string;
}

// `amount` is the raw integer input amount.
export async function quoteMultiRoute(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
): Promise<CandyShopQuoteResult> {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
  });
  return fetchJson<CandyShopQuoteResult>(`${COOKIE_SWAP_API_URL}/quote/multi-route?${q}`);
}

export async function buildSwapTx(
  multiRoute: CandyShopMultiRoute,
  userPublicKey: string,
): Promise<CandyShopSwapTxResult> {
  return fetchJson<CandyShopSwapTxResult>(`${COOKIE_SWAP_API_URL}/swap-tx/multi-route`, {
    method: "POST",
    body: JSON.stringify({ multiRoute, userPublicKey }),
  });
}

export async function submitSignedTx(
  signedTransactionBase64: string,
): Promise<CandyShopSubmitTxResult> {
  return fetchJson<CandyShopSubmitTxResult>(`${COOKIE_SWAP_API_URL}/submit-tx`, {
    method: "POST",
    body: JSON.stringify({ signedTransactionBase64 }),
  });
}

export async function confirmTx(
  signature: string,
  poolAddresses: string[],
): Promise<CandyShopConfirmTxResult> {
  const pools =
    poolAddresses.length > 0 ? `?pools=${poolAddresses.map(encodeURIComponent).join(",")}` : "";
  return fetchJson<CandyShopConfirmTxResult>(
    `${COOKIE_SWAP_API_URL}/confirm-tx/${signature}${pools}`,
  );
}

export function routePoolAddresses(r: CandyShopMultiRoute): string[] {
  return [...new Set(r.segments.map((s) => s.poolAddress).filter(Boolean))];
}
