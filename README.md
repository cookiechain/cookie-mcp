# cookie-mcp

A local **[MCP](https://modelcontextprotocol.io) server for [Cookie Chain](https://cookiescan.io)** —
give any AI agent (Claude Code, Claude Desktop, Cursor, …) the ability to read Cookie Chain market
data and act on it: pools, prices, quotes, swaps, transfers, and token launches.

A community project for the whole Cookie Chain ecosystem — contributions welcome.

- **Local & non-custodial** — runs over stdio; your key signs locally and is never uploaded, logged, or sent to the model.
- **Swaps via [Candy Shop](https://swap.cookiescan.io)** — aggregates all Cookie Chain DEX liquidity for the best route.
- **Safe by default** — read-only until you add a key; a hard per-trade spend cap; every money-moving action is simulated first.

## Quickstart

Requires **Node ≥ 22**.

```bash
yarn install
COOKIE_RPC_URL=https://rpc.cookiescan.io yarn spike:quote   # live quote, no key needed
```

## Use it from an agent

Register the server (replace `/ABS/PATH` with this repo's absolute path):

```json
{
  "mcpServers": {
    "cookie-mcp": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/cookie-mcp/src/mcp/server.ts"],
      "env": {
        "COOKIE_RPC_URL": "https://rpc.cookiescan.io",
        "COOKIE_PRIVATE_KEY": ""
      }
    }
  }
}
```

- **Claude Code** — a project `.mcp.json` is included, or run `claude mcp add cookie-mcp -- npx tsx /ABS/PATH/cookie-mcp/src/mcp/server.ts`.
- **Claude Desktop / Cursor** — add the block above to `claude_desktop_config.json` / `~/.cursor/mcp.json`.

Leave `COOKIE_PRIVATE_KEY` empty for read-only. Set it (base58 secret, keygen JSON array, or keypair
file path) to enable swaps, transfers, and launches.

## Configuration

| Variable                | Default                          | Purpose                                               |
| ----------------------- | -------------------------------- | ----------------------------------------------------- |
| `COOKIE_RPC_URL`        | `https://rpc.cookiescan.io`      | Cookie Chain RPC.                                     |
| `COOKIE_PRIVATE_KEY`    | —                                | Wallet key for money-moving tools. Unset ⇒ read-only. |
| `COOKIE_MAX_TRADE_COOK` | `100`                            | Per-transaction spend cap in COOK (`0` disables).     |
| `COOKIE_SLIPPAGE_BPS`   | `500`                            | Default slippage (bps).                               |
| `COOKIE_SWAP_API_URL`   | `https://swap.cookiescan.io/api` | Candy Shop aggregator base.                           |

## Tools

**Reads** (no key): `chain_health`, `get_pools`, `get_token_info`, `get_quote`, `get_balance`.

**Money** (need `COOKIE_PRIVATE_KEY`): `trade` (swap via Candy Shop), `transfer` (COOK or any token),
`deploy_token` (launch on the Cookiebox bonding curve).

Liquidity tools (`add_liquidity`, `remove_liquidity`, `lock_liquidity`) are **opt-in and still being
validated** — set `COOKIE_ENABLE_UNVALIDATED_LP=1` to expose them.

Use the COOK / native mint `So11111111111111111111111111111111111111112` for COOK. Every tool returns
JSON; failures return `{ error, hint }` — never a stack trace, never your key.

## Safety

Non-custodial and local: no hosted server, no remote key storage. The key stays in `COOKIE_PRIVATE_KEY`,
signs locally, and is redacted from all output. Read-only until a key is set; every trade/transfer is
capped and simulated before sending. Cookie Chain finalization can stall — the server uses `confirmed`
commitment throughout and surfaces a clear hint instead of an opaque `BlockhashNotFound`.

## Development

```bash
yarn test    # lint + format + typecheck + unit tests + boot smoke
yarn mcp     # run the server on stdio
```
