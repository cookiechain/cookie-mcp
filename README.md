# cookie-mcp

[![npm version](https://img.shields.io/npm/v/cookie-mcp.svg)](https://www.npmjs.com/package/cookie-mcp)

A Model Context Protocol (MCP) server that provides onchain tools for any AI agent, allowing it to interact with the [Cookie Chain](https://www.cookiechain.wtf) blockchain through a standardized interface.

## Overview

A community project for the whole Cookie Chain ecosystem — give any AI agent the ability to read Cookie
Chain market data and act on it. It runs locally over stdio and signs with your key on your machine, so
it's non-custodial by design. Its tools let an agent:

- **Read the market** — chain health, pools, token info, swap quotes, and wallet balances (no key needed).
- **Swap** any Cookie Chain token pair through the [Candy Shop](https://swap.cookiescan.io) aggregator,
  which routes across all Cookie Chain DEX liquidity for the best fill.
- **Transfer** COOK or any SPL / Token-2022 token.
- **Launch tokens** on the Cookiebox bonding curve (`deploy_token`) and claim the creator fees they earn
  (`claim_creator_fees`).
- **Manage liquidity** — create pools, add / remove liquidity, claim accrued fees, and permanently lock
  positions across Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap SAMM (venue auto-detected).
- **Liquid-stake** COOK for bCOOK and redeem it instantly (`stake` / `unstake` / `stake_info`).
- **Trade NFTs** on [Baked Bazaar](https://bakedbazaar.art) — browse listings, buy, list, make / accept /
  cancel offers (Cookie Chain's Metaplex Auction House marketplace).
- **Bridge** COOK 1:1 between Cookie Chain and Solana mainnet over [Hyperlane](https://hyperlane.cookiescan.io)
  (`bridge` / `bridge_status`).

Safe by default: read-only until you add a key, a hard per-trade spend cap, and every money-moving action
is simulated before it's sent.

## Use it from an agent

Requires **Node ≥ 22**. No install needed — `npx` fetches the published package on first run.

Register the server with your agent:

```json
{
  "mcpServers": {
    "cookie-mcp": {
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

- **Claude Code** — `claude mcp add cookie-mcp -- npx -y cookie-mcp`.
- **Claude Desktop / Cursor** — add the block above to `claude_desktop_config.json` / `~/.cursor/mcp.json`.

Leave `COOKIE_PRIVATE_KEY` empty for read-only. Set it (base58 secret, keygen JSON array, or keypair
file path) to enable swaps, transfers, and launches.

## Configuration

| Variable                                            | Default                               | Purpose                                                                                    |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `COOKIE_RPC_URL`                                    | `https://rpc.cookiescan.io`           | Cookie Chain RPC.                                                                          |
| `COOKIE_PRIVATE_KEY`                                | —                                     | Wallet key for money-moving tools. Read-only if unset.                                     |
| `COOKIE_MAX_TRADE_COOK`                             | `100`                                 | Per-transaction spend cap in COOK (`0` disables).                                          |
| `COOKIE_SLIPPAGE_BPS`                               | `500`                                 | Default slippage (bps).                                                                    |
| `COOKIE_SWAP_API_URL`                               | `https://swap.cookiescan.io/api`      | Candy Shop aggregator base.                                                                |
| `BAKED_BAZAAR_API_URL`                              | `https://bakedbazaar.art/api`         | Baked Bazaar NFT marketplace backend (listings/offers).                                    |
| `SOLANA_RPC_URL`                                    | `https://api.mainnet-beta.solana.com` | Solana mainnet RPC (bridge only).                                                          |
| `COOKIE_WARP_PROGRAM_ID` / `SOLANA_WARP_PROGRAM_ID` | —                                     | Hyperlane warp route program ids — **required for `bridge`** (deploy output, not shipped). |

## Tools

**Reads** (no key): `chain_health`, `get_pools`, `get_token_info`, `get_quote`, `get_balance`,
`stake_info` (bCOOK liquid-staking rate / TVL / APY / fees), and NFT reads `get_nft_listings`, `get_nft`,
`get_wallet_nfts`, `get_nft_offers`, `get_nft_market_stats`.

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

**Bridge** (need `COOKIE_PRIVATE_KEY` + `COOKIE_WARP_PROGRAM_ID` / `SOLANA_WARP_PROGRAM_ID`): `bridge`
moves COOK 1:1 between Cookie Chain and Solana mainnet over the [Hyperlane](https://hyperlane.cookiescan.io)
warp route (`direction` = `cookie-to-solana` | `solana-to-cookie`). One source-chain signature dispatches
the transfer; a relayer delivers on the far side in a few minutes — check with `bridge_status` (a read,
by Hyperlane message id). Cookie native COOK is 9-decimal; Solana COOK is a 6-decimal Token-2022 mint —
amounts are in COOK either way. Honors the spend cap and simulates first. The warp route program ids are
the bridge operator's deploy output (not shipped in the repo), so both must be supplied.

Use the COOK / native mint `So11111111111111111111111111111111111111112` for COOK. Every tool returns
JSON; failures return `{ error, hint }` — never a stack trace, never your key.

## Safety

Non-custodial and local: no hosted server, no remote key storage. The key stays in `COOKIE_PRIVATE_KEY`,
signs locally, and is redacted from all output. Read-only until a key is set; every trade/transfer is
capped and simulated before sending.

## Development

```bash
yarn install
yarn test    # lint + format + typecheck + unit tests + boot smoke
yarn mcp     # run the server on stdio from source (tsx)
yarn build   # bundle to dist/mcp/server.js (what gets published)
```

To point an agent at a local checkout instead of the published package, use
`"command": "npx", "args": ["tsx", "/ABS/PATH/cookie-mcp/src/mcp/server.ts"]`.
