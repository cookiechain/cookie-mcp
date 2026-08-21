# COOKIE CHAIN MCP CHANGELOG

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

# [Unreleased]

### Added

- **MomoSwap launchpad support**. Tokens launch on a COOK bonding curve and graduate to the open market
  once the raise target is met.
  - `get_launchpad_pools` / `get_launchpad_token` — browse launches and inspect one: curve price, raise
    vs graduation target, settlement mode, fee split, your position, and an optional buy quote.
  - `get_launchpad_positions` — every launch a wallet holds a position in, what it is worth on a live
    curve, and anything unclaimed (graduated tokens, a Fair-mode refund, a settlement payout, creator
    fees, creator vesting). Read from the chain, so it works for any `owner`.
  - `launchpad_buy` / `launchpad_sell` — trade a bonding curve with COOK; wrapping and account creation
    are handled. ⚠️ Pre-graduation holdings are program-tracked **curve shares**, not SPL tokens: they
    do not appear in `get_balance` and `trade` cannot route them.
  - `claim_launchpad` — settle a position: the SPL token after graduation, a Fair-mode pro-rata refund,
    a Jackpot/Survivor Merkle payout (proof fetched for you), or a creator's vested allocation.
  - `deploy_token` and `claim_creator_fees` work again (0.3.0 left them as coming-soon stubs), now on
    MomoSwap. A launch pins the logo + metadata to IPFS and costs the launchpad's creation fee, read
    live from its config; `devBuyCook` makes your own buy the first trade.
  - A pool's `status` may read **`ended`** — the launch window closed but the pool has not been settled
    on-chain yet, and until it is, nothing on it can be traded or claimed.
  - `MOMOSWAP_API_URL` (default `https://api.momoswap.fun`). The launchpad API builds and partial-signs
    each transaction — it holds the pre-ground `momo` mint the program requires and pins metadata — then
    this server simulates it on your RPC, signs with `COOKIE_PRIVATE_KEY` and sends. Custody is unchanged:
    the key never leaves your machine.
- **Cookiebox Swap API support, alongside Candy Shop — the agent picks the aggregator.** `get_quote`
  and `trade` take an optional `aggregator` parameter: **`cookiebox`** ) or **`cookiescan`**. Quote
  both to compare fills. Custody is unchanged on both paths: the aggregator builds an unsigned
  transaction, this server simulates it on your RPC, signs locally, and confirms.
  - Both results now report which `aggregator` ran, and a price impact the aggregator could not
    measure renders as `—` instead of `0%`.
- **CookOven `.cook` name support**. Cookie Chain's name service. The dApp is client-side only,
  so every read and every instruction here is built straight against the program — no API, no indexer.
  - `resolve_domain` — who owns a name, when it was registered, its resolver/metadata pointers, and
    whether it is the owner's primary. If the name is free it returns the **live registration price**
    instead, so availability and cost are one call.
  - `get_owned_domains` — every name a wallet owns plus its primary, enumerated on-chain.
  - `register_domain`, `set_primary_domain` (or `clear: true`), `transfer_domain`, `update_domain`.
  - **A `.cook` name now works anywhere an address does**: `transfer`, `get_balance`, `get_wallet_nfts`,
    `get_nft_offers`, `get_launchpad_positions` and `transfer_domain`. A base58 address still costs no
    extra lookup — only a name triggers one. The `.cook` suffix is optional everywhere.
- **CookOven `.cook` domain marketplace support**. The secondary market for names that are already
  registered — often cheaper than registration, and the only way to get a name somebody else owns.
  only way to get a name somebody else owns.
  - `get_domain_listings` — browse every listing, read straight from the program (no key). Filter by
    `name` substring, `seller`, `maxPriceCook` or `maxLength`; sort by price, name length or recency.
    Reports the live marketplace fee and the floor price of the matched set.
  - `list_domain` / `buy_domain` / `cancel_domain_listing`.
  - **`buy_domain` requires `maxPriceCook`.** `buy_listing` carries no price argument — it reads the
    listing — so the client-side cap is the only guard, exactly as with `register_domain`. Called
    without it you get the asking price quoted back and nothing is spent.
  - **Listing escrows the name, and that changes the whole registry surface.** `list_domain` CPIs into
    the registry and hands the domain to the marketplace's escrow PDA, so a listed name is not owned by
    its seller:
    - `resolve_domain` now returns a **`forSale`** block (price, seller, listing account) and says
      plainly that `owner` is the marketplace escrow, not a wallet.
    - `get_owned_domains` gained **`listedForSale`** / `listedCount`. Without it, a wallet that had
      listed everything it owns was told it owned nothing at all.
    - `transfer_domain`, `update_domain` and `set_primary_domain` explain the listing instead of
      reporting an unfamiliar address as the owner, and point at `cancel_domain_listing`.
    - **A listed name is now REFUSED where an address is expected** (`transfer`, `get_balance`,
      `transfer_domain.to`, …). It resolved to the escrow PDA — a program account with no signer — so
      `transfer to: "<listed>.cook"` would have sent COOK somewhere nobody can spend it.
  - Listing a name that is your primary leaves the primary record pointing at a name the registry no
    longer says you own (the registry does not clear it on transfer, and the marketplace does not use
    the cleanup variant). `list_domain` and `get_owned_domains` both call this out.
  - `COOKOVEN_MARKET_URL` (default `https://market.cookoven.xyz`).
- **`lock_liquidity` now supports Cookiebox CLMM**, not just DAMM v2 — the venue is auto-detected from
  the pool like every other liquidity tool. The whirlpool program only offers `LockType::Permanent` and
  it always takes the **whole** position, so unlike DAMM there is no partial amount and no vesting.
  Locked liquidity can never be withdrawn and the position can never be closed; fees stay claimable via
  `claim_fees`.
- **`bridge` now preflights the destination chain's collateral.** The warp route releases from a fixed
  collateral account on the far side, so bridging more than it holds locked your funds on the source
  chain behind a message that could not be delivered — and because the tool simulates against the
  *source* chain, nothing caught it. `bridge` now reads the far side first and refuses without signing,
  and reports the figure as `destinationCollateral`. The two sides need different reads: the Cookie PDA
  is a native balance (minus its rent-exempt reserve, which cannot be released), while the Solana escrow
  *is* the token account rather than a wallet owning one.
- **`get_wallet`** — the public key this server signs with, whether it is read-only, and the RPC it is
  pointed at. Takes no arguments and makes no RPC call, so it answers when the chain is unreachable and
  it reports what the _running process_ booted with — not what a config file on disk now says, which can
  differ until the server is restarted. Previously the only way to see the key was `get_balance` with no
  arguments, which needs a live RPC. The secret is never returned.
- **`get_balance` can read the Solana side of the bridge.** Pass `chain: "solana"` for the wallet's SPL
  COOK on Solana mainnet — the balance a `solana-to-cookie` bridge actually spends — plus its SOL, which
  pays that transfer's fee, ATA rent and Hyperlane interchain gas. Neither was visible before: the
  default view only reads Cookie Chain. COOK + SOL only; other Solana tokens are not enumerated.

### Changed

- **Removed the `COOKIE_MAX_TRADE_COOK` spend cap.** It forced large actions to be split into identical
  repeats and refused outright when a token had no COOK price to value the input with. Read-only
  without a key and simulate-before-send are unchanged.
- **CLMM positions are now opened as Token-2022 NFTs** (`open_position_with_token_extensions` instead
  of the legacy Metaplex `open_position_with_metadata`). This is required for locking: the program
  freezes the position token account, which only works when the mint's freeze authority is the position
  PDA. Positions opened by earlier versions are legacy NFTs and **can never be locked** —
  `lock_liquidity` detects them and says so instead of sending a transaction that fails with
  `ConstraintOwner`.
- **`add_liquidity` / `remove_liquidity` skip permanently-locked CLMM positions.** The program rejects
  every liquidity change on a locked position, so `add_liquidity` opens a fresh position instead of
  failing, and `remove_liquidity` reports that the position is locked rather than "no position found".
- `get_quote` / `trade` recognise a launchpad token that has no DEX route and point at the launchpad
  tools instead of reporting "no route found"; `get_token_info` gained a `launchpad` field for a mint
  whose price and liquidity read empty because it is still on a curve.

### Fixed

- **A confirmation timeout no longer reads as a failed transaction.** `transfer`, `stake`, `unstake`,
  `bridge` and the liquidity / NFT write tools surfaced web3.js's raw
  `TransactionExpiredBlockheightExceeded` when the blockhash window elapsed before the transaction was
  observed — but it was already broadcast, and on Cookie Chain a finalization stall delays confirmation
  without dropping the transaction. An agent reading that as a failure would retry, making a second
  real transfer / stake / bridge. These now return the signature, an explorer link and an explicit
  "DO NOT retry blindly". `trade`, which reports `confirmed: false` instead of throwing, gained the same
  warning in its result.

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
- **Liquidity management** across Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap BAMM, with the venue
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
