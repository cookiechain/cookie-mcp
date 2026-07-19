// Liquidity dispatch across venues. add/remove/claim auto-detect the venue from the pool's on-chain
// owner; create_pool routes on the explicit `dex`. lock is Cookiebox DAMM v2 only.
import { PublicKey } from "@solana/web3.js";

import { CookieMcpError } from "../errors";
import { getConnection } from "../rpc";
import { requireWallet } from "../wallet";
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
  SAMM_PROGRAM_ID,
  addSammLiquidity,
  removeSammLiquidity,
  claimSammFees,
  createSammPool,
  type SammLpResult,
} from "./cookieswap";
import {
  CLMM_PROGRAM_ID,
  addClmmLiquidity,
  removeClmmLiquidity,
  claimClmmFees,
  createClmmPool,
  type ClmmLpResult,
} from "./clmm";

type Venue = "cookiebox-damm" | "cookiebox-clmm" | "cookieswap-samm";
type AnyLpResult = LpResult | SammLpResult | ClmmLpResult;

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
  if (owner === CP_AMM_PROGRAM_ID.toBase58()) return "cookiebox-damm";
  if (owner === CLMM_PROGRAM_ID.toBase58()) return "cookiebox-clmm";
  if (owner === SAMM_PROGRAM_ID) return "cookieswap-samm";
  throw new CookieMcpError(
    `pool ${poolPk} is not a supported liquidity venue (owner ${owner})`,
    "liquidity tools support Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap SAMM pools",
  );
}

export async function addLiquidity(args: {
  poolPk: string;
  amountA?: string | number;
  amountB?: string | number;
}): Promise<AnyLpResult> {
  const venue = await detectVenue(args.poolPk);
  if (venue === "cookieswap-samm") {
    const { keypair } = requireWallet();
    return addSammLiquidity(getConnection(), keypair, args);
  }
  if (venue === "cookiebox-clmm") {
    const { keypair } = requireWallet();
    return addClmmLiquidity(getConnection(), keypair, args);
  }
  return addDammLiquidity(args);
}

export async function removeLiquidity(args: {
  poolPk: string;
  bps?: number;
}): Promise<AnyLpResult> {
  const venue = await detectVenue(args.poolPk);
  if (venue === "cookieswap-samm") {
    const { keypair } = requireWallet();
    return removeSammLiquidity(getConnection(), keypair, args);
  }
  if (venue === "cookiebox-clmm") {
    const { keypair } = requireWallet();
    return removeClmmLiquidity(getConnection(), keypair, args);
  }
  return removeDammLiquidity(args);
}

export async function lockLiquidity(args: { poolPk: string }): Promise<LpResult> {
  if ((await detectVenue(args.poolPk)) !== "cookiebox-damm") {
    throw new CookieMcpError(
      "lock_liquidity is only supported on Cookiebox DAMM v2",
      "CookieSwap SAMM and Cookiebox CLMM have no permanent-lock",
    );
  }
  return lockDammLiquidity(args);
}

export async function claimFees(args: { poolPk: string }): Promise<AnyLpResult> {
  const venue = await detectVenue(args.poolPk);
  if (venue === "cookieswap-samm") {
    const { keypair } = requireWallet();
    return claimSammFees(getConnection(), keypair, args);
  }
  if (venue === "cookiebox-clmm") {
    const { keypair } = requireWallet();
    return claimClmmFees(getConnection(), keypair, args);
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
  if (args.dex === "cookieswap-samm") {
    const { keypair } = requireWallet();
    return createSammPool(getConnection(), keypair, args);
  }
  if (args.dex === "cookiebox-clmm") {
    const { keypair } = requireWallet();
    return createClmmPool(getConnection(), keypair, args);
  }
  return createDammPool(args);
}
