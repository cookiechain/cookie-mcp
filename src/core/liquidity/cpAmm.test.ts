import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  CP_AMM_PROGRAM_ID,
  DAMM_CREATE_CONFIG,
  derivePoolAuthority,
  derivePoolAddress,
  deriveTokenVault,
  derivePositionAddress,
  derivePositionNftAccount,
} from "./cpAmm";

const COOK = new PublicKey("So11111111111111111111111111111111111111112");
const MINT_A = new PublicKey("6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL");
const NFT = new PublicKey("FFWfqNZGQKun8d1iePAnqkrob359Do2qXwV7CqvF4wq2");

describe("cp-amm program constants", () => {
  it("targets Cookie's forked cp-amm program, not Meteora mainnet", () => {
    expect(CP_AMM_PROGRAM_ID.toBase58()).toBe("DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY");
    expect(DAMM_CREATE_CONFIG.toBase58()).toBe("HrR3btHfwZ13ceqYD7fUEPfX7Rk6M4i7EgE88abUu5Jc");
  });
});

// Golden PDAs — these guard the seed strings, program id, and pool token ordering against drift.
// A wrong seed/program derives a different address and the on-chain ConstraintSeeds check fails.
describe("PDA derivation (golden)", () => {
  it("pool authority", () => {
    expect(derivePoolAuthority().toBase58()).toBe("8WYfVSBcP3T1amRNmTnLfzYd44VDjGpw1jZxrEL8638o");
  });

  it("pool address, and it is independent of token argument order (max,min canonicalization)", () => {
    const pool = derivePoolAddress(DAMM_CREATE_CONFIG, COOK, MINT_A);
    expect(pool.toBase58()).toBe("4mfGFtjKNvWMF4vCmbDHKZsyfgQB6BgMPJYcBg288NTh");
    // swapping A/B must derive the same pool
    expect(derivePoolAddress(DAMM_CREATE_CONFIG, MINT_A, COOK).toBase58()).toBe(pool.toBase58());
  });

  it("token vault for a (mint, pool) pair", () => {
    const pool = derivePoolAddress(DAMM_CREATE_CONFIG, COOK, MINT_A);
    expect(deriveTokenVault(COOK, pool).toBase58()).toBe(
      "Hi95Zn1krbAuXjGJe6oLi2qLVo7H9phVXUsDLTXyLWyR",
    );
  });

  it("position and position-nft-account from the position NFT mint", () => {
    expect(derivePositionAddress(NFT).toBase58()).toBe(
      "J7RLKqUFaCwNMuRW14gpgmqsaVnYaXoZctoZsY5dAtLi",
    );
    expect(derivePositionNftAccount(NFT).toBase58()).toBe(
      "GqypixwUkEssVFJGanScbfyMAVtoE52EH2xj6pHrVo1A",
    );
  });
});
