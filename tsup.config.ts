import { defineConfig } from "tsup";

// Three entries: the CLI (`npx cookie-mcp`, stdio or --http), the server factory (`cookie-mcp/server`)
// and the library barrel (`cookie-mcp`). Relative imports are extensionless and the IDLs are imported
// as JSON, so bundling (not plain `tsc` emit) is required — esbuild resolves both. Runtime deps stay
// external (installed from package.json); only our own `src/**` + the IDLs are inlined. `splitting`
// keeps module state (wallet cache, sessions) in shared chunks so an app importing both the library
// and the factory sees one instance of each.
export default defineConfig({
  entry: {
    "mcp/server": "src/mcp/server.ts",
    "mcp/createServer": "src/mcp/createServer.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  bundle: true,
  splitting: true,
  dts: { entry: { index: "src/index.ts", "mcp/createServer": "src/mcp/createServer.ts" } },
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
