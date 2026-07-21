# COOKIE CHAIN MCP CHANGELOG

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
