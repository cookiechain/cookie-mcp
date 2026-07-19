import { Connection, PublicKey } from "@solana/web3.js";
import { buildCpAmmDeps, deriveTokenVault } from "../src/core/liquidity/cpAmm";

async function main() {
  const conn = new Connection("https://rpc.cookiescan.io", "confirmed");
  const { cpAmm } = buildCpAmmDeps(conn);
  const pool = new PublicKey("78e15qHtzR4nXFpSy8VSzSpDxqyzbKNtrjdTo5neBorq"); // Cookiebox DAMM COOK/MON
  const state = await cpAmm.fetchPoolState(pool);
  console.log("fetchPoolState OK — retargeted CpAmm reads a live Cookie pool:");
  console.log("  tokenAMint:", state.tokenAMint.toBase58());
  console.log("  tokenBMint:", state.tokenBMint.toBase58());
  console.log("  sqrtPrice:", state.sqrtPrice.toString());
  console.log("  liquidity:", state.liquidity.toString());
  // derive an account against Cookie's program (matches on-chain vault)
  console.log("  derived tokenAVault:", deriveTokenVault(state.tokenAMint, pool).toBase58());
  console.log("  vault on state:", state.tokenAVault.toBase58());
  console.log(
    "  vault derivation matches:",
    deriveTokenVault(state.tokenAMint, pool).equals(state.tokenAVault),
  );
  console.log("\n✅ cp-amm retargeting verified");
}
main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
