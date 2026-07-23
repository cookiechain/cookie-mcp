# COOKIE CHAIN MCP CHANGELOG

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

# [0.3.0](https://github.com/cookiechain/cookie-mcp/releases/tag/v0.3.0)

_July 23, 2026_

### Changed

- **Deprecated dynamic bonding curve.** `deploy_token` and `claim_creator_fees` are now
  coming-soon stubs (registered, take no arguments, return a coming-soon notice) pending MomoSwap
  launchpad support. Dropped the bonding-curve implementation, the `dynamic_bonding_curve` IDL, and
  the `cookieboxHosted` / `bondingProgress` fields from `get_token_info`.

# [0.2.2](https://github.com/cookiechain/cookie-mcp/releases/tag/v0.2.2)

_July 22, 2026_

### Added

- Published to the [MCP Registry](https://registry.modelcontextprotocol.io) as
  `io.github.cookiechain/cookie-mcp` — added `server.json` metadata and the `mcpName` package marker
  used to verify npm ownership.

# [0.2.1](https://github.com/cookiechain/cookie-mcp/releases/tag/v0.2.1)

_July 21, 2026_

### Fixed

- `get_token_info` / `search_tokens` reported pool **liquidity in USD when the value was actually native
  COOK** (Cookiescan's `/api/tokens` `marketData.liquidity` is COOK-denominated, unlike `marketCap`),
  overstating it by ~10,000×. Liquidity is now converted to USD via the COOK price (`/api/price/cook`),
  and the raw `liquidityCook` figure is surfaced alongside `liquidityUsd`.

# [0.2.0](https://github.com/cookiechain/cookie-mcp/releases/tag/v0.2.0)

_July 21, 2026_

### Added

- **Search by name** — resolve a named asset to its mint so an agent can act on "buy cookhouse"
  without being handed an address:
  - `search_tokens` — searches the Cookiescan token registry by symbol/name (partial,
    case-insensitive) or mint prefix, returning candidates ranked most-liquid-first. Flags when
    multiple tokens share a symbol so the agent confirms the mint before trading.
  - `search_nfts` — searches active Baked Bazaar listings by name/symbol/collection or mint prefix
    (only currently-listed NFTs are searchable).
  - Tool surface 30 → 32.

### Changed

- Rewrote the README with clearer per-client install (Claude Code, Claude Desktop, Cursor), MCP scope
  guidance (`local` / `user` / `project` and when to use `.mcp.json`), and example prompts.

# [0.1.0](https://github.com/cookiechain/cookie-mcp/releases/tag/v0.1.0)

_July 21, 2026_

### Added

- **Market reads** (no key required): `chain_health`, `get_pools`, `get_token_info`, `get_quote`,
  `get_balance`.
- **Swap & transfer**: `trade` (routed through the Candy Shop aggregator across all Cookie Chain DEX
  liquidity) and `transfer` (COOK or any SPL / Token-2022 token).
- **Token launch**: `deploy_token` (Cookiebox dynamic bonding curve) and `claim_creator_fees`.
- **Liquidity management** across Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap SAMM, with the venue
  auto-detected from the pool: `create_pool`, `add_liquidity`, `remove_liquidity`, `claim_fees`, and
  `lock_liquidity` (Cookiebox DAMM v2, permanent).
- **Liquid staking**: `stake`, `unstake`, and `stake_info` for COOK ⇄ bCOOK.
- **NFT marketplace** on Baked Bazaar: `get_nft_listings`, `get_nft`, `get_wallet_nfts`,
  `get_nft_offers`, `get_nft_market_stats`, `buy_nft`, `list_nft`, `cancel_listing`, `make_offer`,
  `accept_offer`, `cancel_offer`.
- **Cross-chain bridge**: `bridge` and `bridge_status` move COOK 1:1 between Cookie Chain and Solana
  mainnet over the Hyperlane warp route.
- **Safety model**: non-custodial local signing with the key redacted from all output; read-only mode
  when `COOKIE_PRIVATE_KEY` is unset; a per-transaction spend cap (`COOKIE_MAX_TRADE_COOK`); and
  simulate-before-send on every money-moving tool. Failures return a structured `{ error, hint }`,
  never a stack trace.
- Configuration via environment variables (`COOKIE_RPC_URL`, `COOKIE_PRIVATE_KEY`,
  `COOKIE_MAX_TRADE_COOK`, `COOKIE_SLIPPAGE_BPS`, `COOKIE_SWAP_API_URL`, `BAKED_BAZAAR_API_URL`,
  `SOLANA_RPC_URL`, and the Hyperlane warp program ids). See the README for the full table.
