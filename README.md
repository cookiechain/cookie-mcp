# cookie-mcp

[![npm version](https://img.shields.io/npm/v/cookie-mcp.svg)](https://www.npmjs.com/package/cookie-mcp)
[![npm downloads](https://img.shields.io/npm/dm/cookie-mcp.svg)](https://www.npmjs.com/package/cookie-mcp)
[![MCP Registry](https://img.shields.io/badge/mcp--registry-listed-4b0)](https://registry.modelcontextprotocol.io/v0/servers?search=cookie-mcp)
[![CI](https://github.com/cookiechain/cookie-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cookiechain/cookie-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/cookie-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/cookie-mcp.svg)](./LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives any AI agent
onchain tools for the [Cookie Chain](https://www.cookiechain.wtf) blockchain — read the market, swap,
launch tokens, manage liquidity, stake, trade NFTs, and bridge to Solana.

It runs **locally over stdio** and **signs with your key on your machine**, so it is non-custodial by
design. It is a community project for the whole Cookie Chain ecosystem.

<p align="center">
  <img src="https://raw.githubusercontent.com/cookiechain/cookie-mcp/main/docs/demo.gif" alt="An AI agent using cookie-mcp: checking chain health, bridging COOK from Solana, buying COOKHOUSE, staking for bCOOK, and bridging back to Solana" width="820">
</p>

## Contents

- [What it can do](#what-it-can-do)
- [Install](#install) — [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) · [Cursor](#cursor)
- [Enable trading (add a key)](#enable-trading-add-a-key)
- [Try it](#try-it)
- [Configuration](#configuration)
- [Tools](#tools)
- [Safety](#safety)
- [Development](#development)

## What it can do

- **Read the market** — chain health, pools, token info, token search, swap quotes, and wallet
  balances. No key needed.
- **Swap** any Cookie Chain token pair through the [Candy Shop](https://swap.cookiescan.io) aggregator,
  which routes across all Cookie Chain DEX liquidity for the best fill.
- **Transfer** COOK or any SPL / Token-2022 token.
- **Launch tokens** on the Cookiebox bonding curve and claim the creator fees they earn.
- **Manage liquidity** — create pools, add / remove liquidity, claim fees, and permanently lock
  positions across Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap SAMM (venue auto-detected).
- **Liquid-stake** COOK for bCOOK and redeem it instantly.
- **Trade NFTs** on [Baked Bazaar](https://bakedbazaar.art) — search, browse, buy, list, and make /
  accept offers (Cookie Chain's Metaplex Auction House marketplace).
- **Bridge** COOK 1:1 between Cookie Chain and Solana mainnet over [Hyperlane](https://hyperlane.cookiescan.io).

Safe by default: read-only until you add a key, a hard per-transaction spend cap, and every
money-moving action is simulated before it is sent.

## Install

Requires **Node ≥ 22**. There is nothing to install or build — `npx` fetches the published package on
first run. Pick your client below. All three use the same server; the only difference is where the
config lives.

### Claude Code

The quickest way — one command, available in **every** project:

```bash
claude mcp add --scope user --transport stdio cookie-mcp -- npx -y cookie-mcp
```

This registers the server read-only (no key). See [Enable trading](#enable-trading-add-a-key) to add a
wallet.

**Scopes** — `claude mcp add` writes to one of three places; choose with `--scope`:

| `--scope`           | Available in             | Stored in                     |
| ------------------- | ------------------------ | ----------------------------- |
| `user`              | all your projects        | `~/.claude.json`              |
| _(omitted)_ `local` | the current project dir  | `~/.claude.json` (per-folder) |
| `project`           | anyone who clones a repo | `.mcp.json` at the repo root  |

Use `--scope project` only when you want the server **committed into a specific repo** — it writes a
`.mcp.json` that teammates must approve on first use. For a general-purpose tool like this, `--scope
user` is the right default.

Verify it registered:

```bash
claude mcp list          # all servers
claude mcp get cookie-mcp # this one's details
# or run /mcp inside a Claude Code session
```

### Claude Desktop

Edit the config file (create it if missing), then restart Claude Desktop:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

Add the [server block](#server-block) below under `mcpServers`.

### Cursor

Edit `~/.cursor/mcp.json` (applies everywhere) or `.cursor/mcp.json` in a project (project wins if
both exist), then add the [server block](#server-block).

### Server block

Claude Desktop, Cursor, and a Claude Code `.mcp.json` all use the identical shape:

```json
{
  "mcpServers": {
    "cookie-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "cookie-mcp"],
      "env": {
        "COOKIE_RPC_URL": "https://rpc.cookiescan.io",
        "COOKIE_PRIVATE_KEY": ""
      }
    }
  }
}
```

## Enable trading (add a key)

Reads work with no key. To let the agent **swap, transfer, launch, stake, LP, buy NFTs, or bridge**,
provide a wallet via `COOKIE_PRIVATE_KEY` — a base58 secret, a `solana-keygen` JSON byte array, or a
path to a keypair file.

- **Config-file clients (Desktop / Cursor / `.mcp.json`):** put it in the `env` block above.
- **Claude Code:** re-run the add with `--env` (note: this is saved to `~/.claude.json`; avoid leaving
  the raw secret in your shell history):

  ```bash
  claude mcp add --scope user --transport stdio cookie-mcp \
    --env COOKIE_RPC_URL=https://rpc.cookiescan.io \
    --env COOKIE_PRIVATE_KEY=<your-key-or-path> \
    -- npx -y cookie-mcp
  ```

Your key never leaves your machine, is used only to sign locally, and is redacted from all output. The
per-transaction spend cap (`COOKIE_MAX_TRADE_COOK`, default 100 COOK) limits how much any single action
can spend.

## Try it

Once it's registered, just talk to your agent naturally:

- _"What's the health of Cookie Chain right now?"_ → `chain_health`
- _"Find the cookhouse token and show me its price and liquidity."_ → `search_tokens` → `get_token_info`
- _"Quote swapping 10 COOK for bCOOK."_ → `get_quote`
- _"Swap 10 COOK for bCOOK."_ → `get_quote` → `trade` (needs a key; capped + simulated first)
- _"What COOKHOUSE NFTs are listed, and buy the cheapest under 50 COOK."_ → `search_nfts` → `buy_nft`

The agent resolves names to mint addresses with `search_tokens` / `search_nfts`, then acts on the mint —
it never turns a name straight into a trade.

## Configuration

| Variable                | Default                               | Purpose                                                |
| ----------------------- | ------------------------------------- | ------------------------------------------------------ |
| `COOKIE_RPC_URL`        | `https://rpc.cookiescan.io`           | Cookie Chain RPC.                                      |
| `COOKIE_PRIVATE_KEY`    | —                                     | Wallet key for money-moving tools. Read-only if unset. |
| `COOKIE_MAX_TRADE_COOK` | `100`                                 | Per-transaction spend cap in COOK (`0` disables).      |
| `COOKIE_SLIPPAGE_BPS`   | `500`                                 | Default slippage (bps).                                |
| `SOLANA_RPC_URL`        | `https://api.mainnet-beta.solana.com` | Solana mainnet RPC (bridge only).                      |

The Candy Shop API, Baked Bazaar API, and the Hyperlane warp-route program ids all ship with working
mainnet defaults, so you never need to set them — override via env only to target a different
deployment (see `src/core/config.ts`).

## Tools

**Reads** (no key): `chain_health`, `get_pools`, `get_token_info`, `search_tokens` (resolve a token
name/ticker to its mint), `get_quote`, `get_balance`, `stake_info` (bCOOK liquid-staking rate / TVL /
APY / fees), and NFT reads `get_nft_listings`, `search_nfts` (resolve an NFT/collection name to a listed
mint), `get_nft`, `get_wallet_nfts`, `get_nft_offers`, `get_nft_market_stats`.

**Money** (need `COOKIE_PRIVATE_KEY`): `trade` (swap via Candy Shop), `transfer` (COOK or any token),
`stake` / `unstake` (COOK ⇄ bCOOK liquid staking), `deploy_token` (launch on the Cookiebox bonding
curve), `claim_creator_fees` (claim the creator trading fees a token you launched has earned).

**Liquidity** (need `COOKIE_PRIVATE_KEY`): `create_pool`, `add_liquidity`, `remove_liquidity`,
`claim_fees` (Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap SAMM, venue auto-detected),
`lock_liquidity` (Cookiebox DAMM v2, permanent). Concentrated-liquidity venues (CLMM / SAMM) open a
full-range position by default.

**NFT marketplace** (need `COOKIE_PRIVATE_KEY`, [Baked Bazaar](https://bakedbazaar.art)): `buy_nft`,
`list_nft`, `cancel_listing`, `make_offer`, `accept_offer`, `cancel_offer`. Built on the Cookie Chain
Metaplex Auction House (1% marketplace fee + creator royalties); every action is built and signed
locally. `buy_nft` / `make_offer` honor the spend cap.

**Bridge** (need `COOKIE_PRIVATE_KEY`): `bridge` moves COOK 1:1 between Cookie Chain and Solana mainnet
over the [Hyperlane](https://hyperlane.cookiescan.io) warp route (`direction` = `cookie-to-solana` |
`solana-to-cookie`). One source-chain signature dispatches the transfer; a relayer delivers on the far
side in a few minutes — check with `bridge_status` (a read, by Hyperlane message id). Cookie native COOK
is 9-decimal; Solana COOK is a 6-decimal Token-2022 mint — amounts are in COOK either way. Honors the
spend cap and simulates first. The mainnet warp-route program ids ship as defaults, so `bridge` works
out of the box — override `COOKIE_WARP_PROGRAM_ID` / `SOLANA_WARP_PROGRAM_ID` only for a different
deployment.

Use the COOK / native mint `So11111111111111111111111111111111111111112` for COOK. Every tool returns
JSON; failures return `{ error, hint }` — never a stack trace, never your key.

## Safety

Non-custodial and local: no hosted server, no remote key storage. The key stays in `COOKIE_PRIVATE_KEY`,
signs locally, and is redacted from all output. Read-only until a key is set; every trade/transfer is
capped (`COOKIE_MAX_TRADE_COOK`) and simulated before sending.

## Development

```bash
yarn install
yarn test    # lint + format + typecheck + unit tests + boot smoke
yarn mcp     # run the server on stdio from source (tsx)
yarn build   # bundle to dist/mcp/server.js (what gets published)
```

To point an agent at a local checkout instead of the published package, set the command to
`npx tsx /ABS/PATH/cookie-mcp/src/mcp/server.ts`.

## License

This project is licensed under the terms of the MIT license. See the [LICENSE](./LICENSE) file.
