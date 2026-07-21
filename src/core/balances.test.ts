import { describe, it, expect } from "vitest";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

import { mapBalances, type ParsedTokenAmount } from "./balances";
import { COOK_MINT } from "./config";
import type { CookiescanToken } from "./cookiescan";

const MINT_A = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";
const MINT_B = "FFWfqNZGQKun8d1iePAnqkrob359Do2qXwV7CqvF4wq2";
const WALLET = "So11111111111111111111111111111111111111112";

const registry: CookiescanToken[] = [
  { mint: COOK_MINT, metadata: { symbol: "COOK" }, price: { usd: "2" } },
  { mint: MINT_A, metadata: { symbol: "AAA" }, price: { usd: "0.5" } },
  { mint: MINT_B, metadata: { symbol: "BBB" } }, // no price
];

function acct(
  mint: string,
  amount: string,
  decimals: number,
  uiAmount: number | null,
): ParsedTokenAmount {
  return { mint, tokenAmount: { amount, decimals, uiAmount } };
}

describe("mapBalances", () => {
  it("values the native COOK balance from the registry price", () => {
    const b = mapBalances(WALLET, 3 * LAMPORTS_PER_SOL, [], registry);
    expect(b.wallet).toBe(WALLET);
    expect(b.cook.amount).toBe("3");
    expect(b.cook.usdValue).toBe(6); // 3 COOK * $2
    expect(b.tokens).toEqual([]);
    expect(b.totalUsd).toBe(6);
  });

  it("joins tokens to symbol/price, skips zero balances, sorts by USD desc", () => {
    const accounts = [
      acct(MINT_A, "100000000", 6, 100), // AAA: 100 * $0.5 = $50
      acct(MINT_B, "5000000000", 9, 5), // BBB: no price -> null usd
      acct("ZeroMint111111111111111111111111111111111", "0", 6, 0), // dropped
    ];
    const b = mapBalances(WALLET, 0, accounts, registry);
    expect(b.tokens.map((t) => t.mint)).toEqual([MINT_A, MINT_B]); // priced first
    expect(b.tokens[0].symbol).toBe("AAA");
    expect(b.tokens[0].amount).toBe("100");
    expect(b.tokens[0].usdValue).toBe(50);
    expect(b.tokens[1].usdValue).toBeNull();
    expect(b.tokens.some((t) => t.amount === "0")).toBe(false);
    expect(b.totalUsd).toBe(50); // cook has no balance/price here
  });

  it("returns null totalUsd when nothing is priced", () => {
    const b = mapBalances(
      WALLET,
      1 * LAMPORTS_PER_SOL,
      [acct(MINT_B, "1000000000", 9, 1)],
      [{ mint: MINT_B, metadata: { symbol: "BBB" } }],
    );
    expect(b.cook.usdValue).toBeNull();
    expect(b.tokens[0].usdValue).toBeNull();
    expect(b.totalUsd).toBeNull();
  });

  it("falls back to null symbol for mints missing from the registry", () => {
    const b = mapBalances(WALLET, 0, [acct(MINT_A, "1000000", 6, 1)], []);
    expect(b.tokens[0].symbol).toBeNull();
    expect(b.tokens[0].usdValue).toBeNull();
  });
});
