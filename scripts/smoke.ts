/**
 * Import-time / boot smoke — no network required. Boots the real stdio server with a (valid) dummy
 * key and an UNREACHABLE RPC, connects as an MCP client, and lists tools. This catches the class of
 * import-time crashes that tsconfig/eslint miss (§4.6): a bad top-level import, a config read that
 * throws, a missing export. Tool listing is static, so it never touches the (dead) RPC.
 *
 * Wired into `yarn test` and CI. Exits non-zero on any failure or if it hangs.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "chain_health",
  "get_pools",
  "get_token_info",
  "get_quote",
  "get_balance",
  "trade",
  "transfer",
];

async function main() {
  const dummyKey = bs58.encode(Keypair.generate().secretKey);
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
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

  const names = tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) {
    throw new Error(`server booted but is missing tools: ${missing.join(", ")}`);
  }
  console.log(
    `✅ smoke: server boots clean and registers ${names.length} tools: ${names.join(", ")}`,
  );
}

// Hard timeout so a hang fails CI instead of blocking forever.
const timeout = setTimeout(() => {
  console.error("❌ smoke: timed out waiting for the server");
  process.exit(1);
}, 30_000);

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
