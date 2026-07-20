// Config + Cookie Chain constants, sourced from env. COOKIE_PRIVATE_KEY is read only by the wallet
// module, so the key touches as few places as possible.

export const COOKIE_RPC_URL = process.env.COOKIE_RPC_URL?.trim() || "https://rpc.cookiescan.io";

export const COOKIE_SWAP_API_URL =
  process.env.COOKIE_SWAP_API_URL?.trim().replace(/\/$/, "") || "https://swap.cookiescan.io/api";

export const COOKIESCAN_API_URL =
  process.env.COOKIESCAN_API_URL?.trim().replace(/\/$/, "") || "https://api.cookiescan.io";

// Baked Bazaar (NFT marketplace) backend. The only source of active listings/offers/collections —
// Cookie Chain RPC has no getProgramAccounts on the auction-house program and the DAS API indexes no
// listings, so on-chain enumeration isn't viable. Configurable in case the host changes.
export const BAKED_BAZAAR_API_URL =
  process.env.BAKED_BAZAAR_API_URL?.trim().replace(/\/$/, "") || "https://bakedbazaar.art/api";

export const EXPLORER_URL =
  process.env.COOKIE_EXPLORER_URL?.trim().replace(/\/$/, "") || "https://cookiescan.io";

export const DEFAULT_SLIPPAGE_BPS =
  Number.parseInt(process.env.COOKIE_SLIPPAGE_BPS ?? "", 10) || 500;

// Hard per-transaction spend cap in COOK; money-moving tools refuse inputs valued above it. 0 disables.
export const MAX_TRADE_COOK = (() => {
  const raw = process.env.COOKIE_MAX_TRADE_COOK?.trim();
  if (raw == null || raw === "") return 100;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 100;
})();

// Native/wrapped COOK is Solana's NATIVE_MINT, 9 decimals, shown as COOK.
export const COOK_MINT = "So11111111111111111111111111111111111111112";
export const COOK_DECIMALS = 9;
export const COOK_SYMBOL = "COOK";

export const PROGRAM_IDS = {
  dbc: "DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf",
  cookieboxDamm: "DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY",
  cookieboxClmm: "CLMMmWqTtyNSomqXP3kETJy2SGKPdr31USsm4GfbLyKs",
  cookieswapSamm: "WTzkPUoprVx7PDc1tfKA5sS7k1ynCgU89WtwZhksHX5",
  cookieswapXybn: "xYBN2zddsqSy41tg1yD9nJScCmqquZnHUyzXBfLEqC8",
} as const;

export const HTTP_TIMEOUT_MS = 12_000;

export function explorerTxUrl(sig: string): string {
  return `${EXPLORER_URL}/tx/${sig}`;
}
export function explorerTokenUrl(mint: string): string {
  return `${EXPLORER_URL}/token/${mint}`;
}
export function explorerAddressUrl(addr: string): string {
  return `${EXPLORER_URL}/address/${addr}`;
}
