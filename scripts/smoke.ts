/**
 * Import-time / boot smoke — no network required. Boots the real stdio server with a (valid) dummy
 * key and an UNREACHABLE RPC, connects as an MCP client, and lists tools. This catches the class of
 * import-time crashes that tsconfig/eslint miss (§4.6): a bad top-level import, a config read that
 * throws, a missing export. Tool listing is static, so it never touches the (dead) RPC.
 *
 * Wired into `yarn test` and CI. Exits non-zero on any failure or if it hangs.
 *
 * Release-only flags (scripts/release.ts):
 *   --strict        also fail on a registered tool that is missing from EXPECTED_TOOLS or the README
 *   --pkg <spec>    boot a published package (`npx -y <spec>`) from an empty temp dir instead of src/
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "submit_signed_tx",
  "chain_health",
  "get_pools",
  "get_token_info",
  "search_tokens",
  "get_quote",
  "get_wallet",
  "get_balance",
  "trade",
  "transfer",
  "get_limit_orders",
  "place_limit_order",
  "cancel_limit_order",
  "get_dca_schedules",
  "open_dca",
  "close_dca",
  "stake_info",
  "stake",
  "unstake",
  "get_launchpad_pools",
  "get_launchpad_token",
  "get_launchpad_positions",
  "deploy_token",
  "launchpad_buy",
  "launchpad_sell",
  "claim_launchpad",
  "claim_creator_fees",
  "create_pool",
  "add_liquidity",
  "remove_liquidity",
  "lock_liquidity",
  "claim_fees",
  "get_nft_listings",
  "get_nft",
  "get_wallet_nfts",
  "get_nft_offers",
  "get_nft_market_stats",
  "buy_nft",
  "list_nft",
  "cancel_listing",
  "make_offer",
  "cancel_offer",
  "accept_offer",
  "search_nfts",
  "resolve_domain",
  "get_owned_domains",
  "register_domain",
  "set_primary_domain",
  "transfer_domain",
  "update_domain",
  "get_domain_listings",
  "list_domain",
  "buy_domain",
  "cancel_domain_listing",
  "get_bridge_tokens",
  "bridge",
  "bridge_status",
];

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const pkgAt = argv.indexOf("--pkg");
const pkg = pkgAt >= 0 ? argv[pkgAt + 1] : undefined;
if (pkgAt >= 0 && !pkg) throw new Error("--pkg needs a package spec, e.g. cookie-mcp@1.2.3");

async function main() {
  const dummyKey = bs58.encode(Keypair.generate().secretKey);
  // A clean cwd, so npx resolves the registry package and not this checkout.
  const cwd = pkg ? mkdtempSync(join(tmpdir(), "cookie-mcp-smoke-")) : undefined;
  const transport = new StdioClientTransport({
    command: "npx",
    args: pkg ? ["-y", pkg] : ["tsx", "src/mcp/server.ts"],
    cwd,
    stderr: "inherit",
    env: {
      ...getDefaultEnvironment(),
      COOKIE_PRIVATE_KEY: dummyKey, // valid key → exercises the wallet-configured boot path
      COOKIE_RPC_URL: "http://127.0.0.1:1", // unreachable — listTools must not need it
    },
  });

  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  if (cwd) rmSync(cwd, { recursive: true, force: true });

  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) {
    throw new Error(`server booted but is missing tools: ${missing.join(", ")}`);
  }
  if (strict) {
    const unlisted = names.filter((t) => !EXPECTED_TOOLS.includes(t));
    if (unlisted.length) {
      throw new Error(`add to EXPECTED_TOOLS in scripts/smoke.ts: ${unlisted.join(", ")}`);
    }
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const undocumented = names.filter((t) => !readme.includes(`\`${t}\``));
    if (undocumented.length) {
      throw new Error(`add to the README Tools list: ${undocumented.join(", ")}`);
    }
  }
  console.log(
    `✅ smoke: server boots clean and registers ${names.length} tools: ${names.join(", ")}`,
  );
}

// Hard timeout so a hang fails CI instead of blocking forever.
const timeout = setTimeout(
  () => {
    console.error("❌ smoke: timed out waiting for the server");
    process.exit(1);
  },
  pkg ? 180_000 : 30_000,
); // a pinned npx boot downloads the package first

main()
  .then(() => {
    clearTimeout(timeout);
    process.exit(0);
  })
  .catch((e) => {
    clearTimeout(timeout);
    console.error("❌ smoke failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
