// get_balance — native COOK + SPL/Token-2022 balances for a wallet, with USD values from the registry.
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

import { COOK_MINT, COOK_SYMBOL, COOK_DECIMALS } from "./config";
import { CookieMcpError } from "./errors";
import { fetchTokens, type CookiescanToken } from "./cookiescan";
import { getConnection } from "./rpc";
import { rawToUi } from "./format";

// web3.js v1 doesn't export these from its base entrypoint.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export interface TokenBalance {
  mint: string;
  symbol: string | null;
  amount: string;
  decimals: number;
  usdValue: number | null;
}

export interface WalletBalances {
  wallet: string;
  cook: { amount: string; usdValue: number | null };
  tokens: TokenBalance[];
  totalUsd: number | null;
}

function parsePubkey(addr: string): PublicKey {
  try {
    return new PublicKey(addr);
  } catch {
    throw new CookieMcpError(`invalid wallet address: ${addr}`, "pass a valid base58 pubkey");
  }
}

/** The token-amount shape web3.js parses into each token account's `parsed.info`. */
export interface ParsedTokenAmount {
  mint: string;
  tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export async function getBalances(wallet: string): Promise<WalletBalances> {
  const owner = parsePubkey(wallet);
  const conn = getConnection();

  const [lamports, tokenAccts, token2022Accts, registry] = await Promise.all([
    conn.getBalance(owner),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    fetchTokens(),
  ]);

  const parsed: ParsedTokenAmount[] = [...tokenAccts.value, ...token2022Accts.value].map(
    ({ account }) => {
      const info = (account.data as { parsed: { info: Record<string, unknown> } }).parsed.info;
      return {
        mint: info.mint as string,
        tokenAmount: info.tokenAmount as ParsedTokenAmount["tokenAmount"],
      };
    },
  );
  return mapBalances(owner.toBase58(), lamports, parsed, registry);
}

// Pure assembly of the balances view: join SPL/Token-2022 accounts against the registry for
// symbol/price, drop zero balances, sort by USD value desc, and total. No I/O, so it's unit-testable.
export function mapBalances(
  wallet: string,
  lamports: number,
  accounts: ParsedTokenAmount[],
  registry: CookiescanToken[],
): WalletBalances {
  const priceByMint = new Map<string, number>();
  const symbolByMint = new Map<string, string>();
  for (const t of registry) {
    const usd = t.price?.usd != null ? Number(t.price.usd) : NaN;
    if (t.mint && Number.isFinite(usd)) priceByMint.set(t.mint, usd);
    const sym = t.metadata?.symbol;
    if (t.mint && sym) symbolByMint.set(t.mint, sym);
  }

  const cookUi = rawToUi(BigInt(lamports), COOK_DECIMALS);
  const cookPrice = priceByMint.get(COOK_MINT) ?? null;
  const cookUsd = cookPrice != null ? (lamports / LAMPORTS_PER_SOL) * cookPrice : null;

  const tokens: TokenBalance[] = [];
  for (const { mint, tokenAmount: ta } of accounts) {
    if (!ta || ta.amount === "0") continue;
    const price = priceByMint.get(mint);
    const usdValue = price != null && ta.uiAmount != null ? ta.uiAmount * price : null;
    tokens.push({
      mint,
      symbol: symbolByMint.get(mint) ?? null,
      amount: rawToUi(BigInt(ta.amount), ta.decimals),
      decimals: ta.decimals,
      usdValue,
    });
  }
  tokens.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

  const totalUsd =
    cookUsd != null || tokens.some((t) => t.usdValue != null)
      ? (cookUsd ?? 0) + tokens.reduce((s, t) => s + (t.usdValue ?? 0), 0)
      : null;

  return {
    wallet,
    cook: { amount: cookUi, usdValue: cookUsd },
    tokens,
    totalUsd,
  };
}

export { COOK_SYMBOL };
