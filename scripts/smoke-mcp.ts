/**
 * Throwaway CP1 verification: spawn the real stdio MCP server and drive it as a client — list tools,
 * then call get_quote and chain_health — proving the end-to-end MCP wiring (schemas, handlers,
 * JSON content) works, not just the cores.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { COOK_MINT } from "../src/core/config";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/server.ts"],
    stderr: "inherit",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));

  const quote = await client.callTool({
    name: "get_quote",
    arguments: {
      inputMint: COOK_MINT,
      outputMint: "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL",
      amount: 10,
    },
  });
  console.log("\nget_quote result:\n" + (quote.content as Array<{ text: string }>)[0].text);

  const health = await client.callTool({ name: "chain_health", arguments: {} });
  const h = JSON.parse((health.content as Array<{ text: string }>)[0].text);
  console.log("\nchain_health:", {
    status: h.status,
    finalizationLag: h.finalizationLag,
    validators: h.validatorCount,
  });

  // error path: unknown token
  const bad = await client.callTool({
    name: "get_token_info",
    arguments: { mint: "1nvalidMintAddressAddressAddress1234567890" },
  });
  console.log(
    "\nerror-path (bad mint):",
    (bad.content as Array<{ text: string }>)[0].text,
    "isError=",
    bad.isError,
  );

  await client.close();
  console.log("\n✅ MCP server responded over stdio");
}
main().catch((e) => {
  console.error("❌ mcp smoke failed:", e);
  process.exit(1);
});
