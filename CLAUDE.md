# Contributing to cookie-mcp

A local **stdio MCP server** that exposes Cookie Chain actions to any AI agent. It runs on the
contributor's machine and signs with their key — **non-custodial by design**. This is a
**community/ecosystem project** for all Cookie Chain developers: Cookiebox, Candy Shop, CookieSwap,
Baked Bazaar and Hyperlane are venues it *uses*, not owners. Keep code and docs venue-neutral.

## Layout

```
src/
  mcp/server.ts        # the ONLY entry point: registers every tool, thin wrappers over core/
  core/                # all logic lives here — pure, testable, framework-agnostic
    config.ts          #   constants, program IDs, endpoints
    rpc.ts             #   getConnection()
    wallet.ts          #   key loading, requireWallet(), assertWithinSpendCap()
    errors.ts          #   CookieMcpError — the one error type surfaced to agents
    format.ts          #   rawToUi / uiToRaw / shortAddr — always go through these
    http.ts            #   fetchJson with retry policy
    launch/            #   deploy_token (dbc), creator fees, vanity, metadata
    liquidity/         #   create/add/remove/lock/claim across damm, cpAmm, clmm, cookieswap
    nft/               #   Baked Bazaar: auctionHouse (writes) + bazaar (reads)
  idl/                 # committed IDLs (cp_amm, whirlpool, dynamic_bonding_curve)
scripts/               # smoke.ts (boots server, asserts tool count) + verify-*.ts (live checks)
```

**Golden rule:** tools in `server.ts` stay thin — `tool(async (a) => coreFn(a))`. All real work
(tx building, encoding, API calls) lives in `src/core/`, so it can be unit-tested without MCP.

## Dev commands

```bash
yarn install
yarn mcp                         # run the server over stdio
yarn test:unit                   # vitest (unit tests only)
yarn smoke                       # boot server, assert all tools register
yarn typecheck                   # tsc --noEmit
yarn lint / yarn format          # eslint / prettier
yarn test                        # FULL gate: lint + format:check + typecheck + test:unit + smoke
```

Run `yarn test` before opening a PR — it is exactly what CI runs. Node ≥ 22 required.
No key needed for read-only work: `npx tsx scripts/smoke-cores.ts` hits live pools/quotes/health.

## Adding a new tool

1. Write the logic in a `src/core/` module (new file or existing one by domain). Return plain data
   or a result object — never touch MCP types here.
2. Register it in `src/mcp/server.ts` with `registerTool(name, { title, description, inputSchema }, tool(...))`:
   - **`inputSchema`** is a map of Zod validators; `.describe()` every field — agents read those.
   - **`description`** should state what the tool does *and* its key gotchas (agents rely on it).
   - Tool **names mirror Solana Agent Kit** where an analog exists (`get_balance`, `trade`,
     `deploy_token`, `create_pool`, `add_liquidity`, `remove_liquidity`, `lock_liquidity`).
3. Add a unit test next to the module (`*.test.ts`) — see Testing.
4. `scripts/smoke.ts` asserts the total tool count; bump it and the README tool list.

## Conventions

- **Errors:** throw `CookieMcpError` with an actionable message. It is the only error shape agents see.
- **Amounts:** convert at the boundary with `rawToUi` / `uiToRaw`; never hand-roll decimal math.
- **Safety (non-negotiable):**
  - read-only until `COOKIE_PRIVATE_KEY` is set; reads must not require a key.
  - every money-moving action calls `assertWithinSpendCap()` and **simulates before send**.
  - never log or embed secrets; never put a token in a remote URL.
- **HTTP:** use `fetchJson` (it has the retry policy), not bare `fetch`.
- **Formatting:** Prettier + ESLint are enforced by `yarn test`; run `yarn format` before committing.

## Testing

Tests are **unit tests on `src/core/` modules** (Vitest), focused on pure logic — instruction-data
byte layouts, PDA derivation, quote/response parsing, amount math. Prefer **golden-bytes / golden-PDA
assertions** for anything that encodes an on-chain instruction (see `core/bridge.test.ts`,
`core/launch/dbc.test.ts`): they guard discriminators and seed strings against silent drift without
needing a live cluster or a key.

For flows that genuinely need a cluster, add a `scripts/verify-*.ts` script (kept out of the unit
suite) rather than a networked test. `scripts/smoke.ts` is the boot/registration check.
