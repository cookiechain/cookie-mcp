// Liquidity dispatch across venues. add/remove/lock/claim auto-detect the venue from the pool's
// on-chain owner; create_pool routes on the explicit `dex`. lock covers both Cookiebox venues
// (DAMM v2 and CLMM); CookieSwap BAMM has no permanent-lock instruction.
import { PublicKey } from "@solana/web3.js";

import { CookieMcpError } from "../errors";
import { getConnection } from "../rpc";
import { requireSigner } from "../wallet";
import {
  createPool as createDammPool,
  addLiquidity as addDammLiquidity,
  removeLiquidity as removeDammLiquidity,
  lockLiquidity as lockDammLiquidity,
  claimFees as claimDammFees,
  type LpResult,
} from "./damm";
import { CP_AMM_PROGRAM_ID } from "./cpAmm";
import {
  BAMM_PROGRAM_ID,
  addBammLiquidity,
  removeBammLiquidity,
  claimBammFees,
  createBammPool,
  type BammLpResult,
} from "./cookieswap";
import {
  CLMM_PROGRAM_ID,
  addClmmLiquidity,
  removeClmmLiquidity,
  lockClmmLiquidity,
  claimClmmFees,
  createClmmPool,
  type ClmmLpResult,
} from "./clmm";

export type Venue = "cookiebox-damm" | "cookiebox-clmm" | "cookieswap-bamm";
type AnyLpResult = LpResult | BammLpResult | ClmmLpResult;

// Map a pool account's on-chain owner (program id) to its venue, or null if unsupported. Pure —
// this is the routing decision every add/remove/lock/claim depends on, so it is worth guarding.
export function venueForOwner(owner: string): Venue | null {
  if (owner === CP_AMM_PROGRAM_ID.toBase58()) return "cookiebox-damm";
  if (owner === CLMM_PROGRAM_ID.toBase58()) return "cookiebox-clmm";
  if (owner === BAMM_PROGRAM_ID) return "cookieswap-bamm";
  return null;
}

async function detectVenue(poolPk: string): Promise<Venue> {
  let pk: PublicKey;
  try {
    pk = new PublicKey(poolPk);
  } catch {
    throw new CookieMcpError(`invalid pool address: ${poolPk}`, "pass a valid pool pubkey");
  }
  const info = await getConnection().getAccountInfo(pk);
  if (!info)
    throw new CookieMcpError(`pool ${poolPk} not found on-chain`, "check the pool address");
  const owner = info.owner.toBase58();
  const venue = venueForOwner(owner);
  if (!venue) {
    throw new CookieMcpError(
      `pool ${poolPk} is not a supported liquidity venue (owner ${owner})`,
      "liquidity tools support Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap BAMM pools",
    );
  }
  return venue;
}

export async function addLiquidity(args: {
  poolPk: string;
  amountA?: string | number;
  amountB?: string | number;
}): Promise<AnyLpResult> {
  const venue = await detectVenue(args.poolPk);
  if (venue === "cookieswap-bamm") {
    const signer = requireSigner();
    return addBammLiquidity(getConnection(), signer, args);
  }
  if (venue === "cookiebox-clmm") {
    const signer = requireSigner();
    return addClmmLiquidity(getConnection(), signer, args);
  }
  return addDammLiquidity(args);
}

export async function removeLiquidity(args: {
  poolPk: string;
  bps?: number;
}): Promise<AnyLpResult> {
  const venue = await detectVenue(args.poolPk);
  if (venue === "cookieswap-bamm") {
    const signer = requireSigner();
    return removeBammLiquidity(getConnection(), signer, args);
  }
  if (venue === "cookiebox-clmm") {
    const signer = requireSigner();
    return removeClmmLiquidity(getConnection(), signer, args);
  }
  return removeDammLiquidity(args);
}

export async function lockLiquidity(args: { poolPk: string }): Promise<AnyLpResult> {
  const venue = await detectVenue(args.poolPk);
  if (venue === "cookieswap-bamm") {
    throw new CookieMcpError(
      "lock_liquidity is not supported on CookieSwap BAMM",
      "permanent lock is available on Cookiebox DAMM v2 and Cookiebox CLMM pools",
    );
  }
  if (venue === "cookiebox-clmm") {
    const signer = requireSigner();
    return lockClmmLiquidity(getConnection(), signer, args);
  }
  return lockDammLiquidity(args);
}

export async function claimFees(args: { poolPk: string }): Promise<AnyLpResult> {
  const venue = await detectVenue(args.poolPk);
  if (venue === "cookieswap-bamm") {
    const signer = requireSigner();
    return claimBammFees(getConnection(), signer, args);
  }
  if (venue === "cookiebox-clmm") {
    const signer = requireSigner();
    return claimClmmFees(getConnection(), signer, args);
  }
  return claimDammFees(args);
}

export async function createPool(args: {
  dex?: Venue;
  tokenAMint: string;
  tokenBMint: string;
  amountA: string | number;
  amountB: string | number;
  config?: string;
  feeTier?: number;
  initialPrice?: string | number;
  ammConfig?: string;
}): Promise<AnyLpResult> {
  if (args.dex === "cookieswap-bamm") {
    const signer = requireSigner();
    return createBammPool(getConnection(), signer, args);
  }
  if (args.dex === "cookiebox-clmm") {
    const signer = requireSigner();
    return createClmmPool(getConnection(), signer, args);
  }
  return createDammPool(args);
}
