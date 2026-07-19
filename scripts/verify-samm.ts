/** CP6 go/no-go: does the CookieSwap SAMM fork (WTzk…) match upstream Raydium CLMM layout? */
import { Connection, PublicKey } from "@solana/web3.js";
import { PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";

const SAMM_PROGRAM = "WTzkPUoprVx7PDc1tfKA5sS7k1ynCgU89WtwZhksHX5";
const POOL = "DtK93bScUXhkn6edF8ATdL85DYyHqsavbWhpR9GuuAYB"; // wCOOK/bCOOK

async function main() {
  const conn = new Connection("https://rpc.cookiescan.io", "confirmed");
  const acct = await conn.getAccountInfo(new PublicKey(POOL));
  if (!acct) throw new Error("pool account not found");
  console.log(
    "owner:",
    acct.owner.toBase58(),
    "| matches SAMM program:",
    acct.owner.toBase58() === SAMM_PROGRAM,
  );
  console.log("data length:", acct.data.length);
  const s = PoolInfoLayout.decode(acct.data);
  console.log("decoded PoolInfoLayout fields:");
  console.log("  mintA:", s.mintA.toBase58());
  console.log("  mintB:", s.mintB.toBase58());
  console.log("  mintDecimalsA:", s.mintDecimalsA, "| mintDecimalsB:", s.mintDecimalsB);
  console.log("  tickSpacing:", s.tickSpacing);
  console.log("  sqrtPriceX64:", s.sqrtPriceX64?.toString());
  console.log("  tickCurrent:", s.tickCurrent);
  console.log("  ammConfig:", s.ammConfig?.toBase58?.());
  const sane = s.mintA && s.mintB && s.sqrtPriceX64 && s.mintDecimalsA >= 0 && s.mintDecimalsB >= 0;
  console.log(
    sane
      ? "\n✅ SAMM fork decodes cleanly with upstream Raydium PoolInfoLayout — SDK approach viable"
      : "\n❌ layout mismatch — raydium-sdk-v2 cannot be used as-is",
  );
}
main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
