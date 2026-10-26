import { defineConfig } from "tsup";

// Library subpaths (`cookie-mcp/trade`, `cookie-mcp/stake`, …): one per domain, so an app that needs
// one flow does not bundle every venue SDK the barrel pulls in (the liquidity SDKs alone are ~1 MB
// gzipped). Each maps to `dist/lib/<name>.js`; keep `exports` in package.json in step — the
// `subpaths.test.ts` check fails when the two disagree.
export const SUBPATHS: Record<string, string> = {
  signer: "src/core/signer.ts",
  context: "src/core/context.ts",
  submit: "src/core/submit.ts",
  errors: "src/core/errors.ts",
  quote: "src/core/quote.ts",
  balances: "src/core/balances.ts",
  trade: "src/core/trade.ts",
  transfer: "src/core/transfer.ts",
  stake: "src/core/stake.ts",
  bridge: "src/core/bridge.ts",
  "bridge-routes": "src/core/bridgeRoutes.ts",
  "limit-orders": "src/core/limitOrders.ts",
  dca: "src/core/dca.ts",
  liquidity: "src/core/liquidity/index.ts",
  nft: "src/core/nft/index.ts",
  domains: "src/core/domains/index.ts",
  launchpad: "src/core/launchpad/index.ts",
  lending: "src/core/lending/index.ts",
};

const subpathEntries = Object.fromEntries(
  Object.entries(SUBPATHS).map(([name, src]) => [`lib/${name}`, src]),
);

// Entries: the CLI (`npx cookie-mcp`, stdio or --http), the server factory (`cookie-mcp/server`),
// the library barrel (`cookie-mcp`) and the per-domain subpaths above. Relative imports are
// extensionless and the IDLs are imported as JSON, so bundling (not plain `tsc` emit) is required —
// esbuild resolves both. Runtime deps stay external (installed from package.json); only our own
// `src/**` + the IDLs are inlined. `splitting` keeps module state (wallet cache, sessions, the request
// context) in shared chunks so an app importing the library, a subpath and the factory sees one
// instance of each.
export default defineConfig({
  entry: {
    "mcp/server": "src/mcp/server.ts",
    "mcp/createServer": "src/mcp/createServer.ts",
    index: "src/index.ts",
    ...subpathEntries,
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  bundle: true,
  splitting: true,
  dts: {
    entry: {
      index: "src/index.ts",
      "mcp/createServer": "src/mcp/createServer.ts",
      ...subpathEntries,
    },
  },
  clean: true,
  sourcemap: true,
  // esbuild preserves the entry file's `#!/usr/bin/env node` shebang in the output;
  // chmod it executable so the `bin` works when npm links it.
  onSuccess: async () => {
    const { chmodSync } = await import("node:fs");
    chmodSync("dist/mcp/server.js", 0o755);
  },
  // Keep third-party deps external so they resolve from the installed node_modules.
  skipNodeModulesBundle: true,
  loader: { ".json": "json" },
});
