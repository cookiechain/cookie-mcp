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

// --- Hyperlane COOK bridge (Cookie Chain ⇄ Solana mainnet) --------------------------------------
// Moves COOK 1:1 over Hyperlane warp routes: Cookie side is a `native` warp (locks native COOK),
// Solana side is a `collateral` warp (locks SPL COOK). Addresses below are the mainnet Hyperlane
// core/IGP identifiers from the hyperlane-cookies deploy (configs/agents/agent-config.json +
// configs/warp-routes/cookie-sol/token-config.json); all overridable via env.
export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
export const SOLANA_EXPLORER_URL =
  process.env.SOLANA_EXPLORER_URL?.trim().replace(/\/$/, "") || "https://solscan.io";

export const COOKIE_DOMAIN = Number(process.env.COOKIE_DOMAIN?.trim() || "420042004");
export const SOLANA_DOMAIN = Number(process.env.SOLANA_DOMAIN?.trim() || "1399811149");

// Warp route program IDs (mainnet). Verified against the on-chain collateral accounts published in
// hyperlane-cookies/defillama/README.md: deriveNativeCollateralPda(cookie warp) ==
// CL2JoQ5jdTpRNKshWhaTihuooT4qrKdLUiPsqKj3yAKz and deriveEscrowPda(solana warp) ==
// 88q7zoKctwAQRsoTxkMJy95sNE3tntuyEhSrhvR1eZwq. Overridable via env.
export const COOKIE_WARP_PROGRAM_ID =
  process.env.COOKIE_WARP_PROGRAM_ID?.trim() || "Aa9wq46NB7qkg1amnBuMRsV1DunmkPHuoRLWZgWiBKdn";
export const SOLANA_WARP_PROGRAM_ID =
  process.env.SOLANA_WARP_PROGRAM_ID?.trim() || "B1C91jLcqXYYz57bBWR8dSEjBrJDhWSeNokZ5SDEopu3";

export const BRIDGE = {
  cookie: {
    mailbox: process.env.COOKIE_MAILBOX?.trim() || "DhiHgUY8Y6mJ4D3MoRnZWAjTBEtSaFFn4CYgc6eDzZ8r",
    igpProgramId:
      process.env.COOKIE_IGP_PROGRAM_ID?.trim() || "F93J1LCWZVZGtiv2yWu1mZeyCbFJNUh9aWEonWN6eSRp",
    overheadIgp:
      process.env.COOKIE_OVERHEAD_IGP_ACCOUNT?.trim() ||
      "B47yFLwnEGxp3oFHyy2LdGCmAe6kTbFmzSjkVoFaod9q",
    decimals: 9,
  },
  solana: {
    mailbox: process.env.SOLANA_MAILBOX?.trim() || "E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi",
    igpProgramId:
      process.env.SOLANA_IGP_PROGRAM_ID?.trim() || "BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv",
    overheadIgp:
      process.env.SOLANA_OVERHEAD_IGP_ACCOUNT?.trim() ||
      "Dg5FAhqNaRfQPc3HwW9fXr7Bj4nrnszoQspoSLgysqfY",
    // Solana mainnet COOK is a Token-2022 mint with 6 decimals (Cookie native COOK has 9).
    splMint: process.env.COOK_SPL_MINT?.trim() || "36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1",
    decimals: 6,
  },
} as const;

export function explorerTxUrl(sig: string): string {
  return `${EXPLORER_URL}/tx/${sig}`;
}
export function solanaExplorerTxUrl(sig: string): string {
  return `${SOLANA_EXPLORER_URL}/tx/${sig}`;
}
export function explorerTokenUrl(mint: string): string {
  return `${EXPLORER_URL}/token/${mint}`;
}
export function explorerAddressUrl(addr: string): string {
  return `${EXPLORER_URL}/address/${addr}`;
}
