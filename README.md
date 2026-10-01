# cookie-mcp

[![npm version](https://img.shields.io/npm/v/cookie-mcp.svg)](https://www.npmjs.com/package/cookie-mcp)
[![npm downloads](https://img.shields.io/npm/dm/cookie-mcp.svg)](https://www.npmjs.com/package/cookie-mcp)
[![MCP Registry](https://img.shields.io/badge/mcp--registry-listed-4b0)](https://registry.modelcontextprotocol.io/v0/servers?search=cookie-mcp)
[![MCP Servers](https://img.shields.io/badge/mcp--servers-listed-4b0)](https://mcpservers.org/servers/cookiechain/cookie-mcp)
[![CI](https://github.com/cookiechain/cookie-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cookiechain/cookie-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/cookie-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/cookie-mcp.svg)](./LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives any AI agent
onchain tools for the [Cookie Chain](https://www.cookiechain.wtf) blockchain — read the market, swap,
launch tokens, manage liquidity, stake, trade NFTs, and bridge to Solana.

It runs **locally over stdio** and **signs with your key on your machine**, so it is non-custodial by
design. For hosted apps (a web chat, a bot behind a website) it runs in **external-signer mode**: the
server holds no key, every action stops at the signing step with a verified transaction, and the
user's own browser wallet signs it — same tools, same guardrails ([details](#hosted--wallet-signed-mode)).
It is a community project for the whole Cookie Chain ecosystem.

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
- [Hosted / wallet-signed mode](#hosted--wallet-signed-mode) — for web apps and other integrators
- [Safety](#safety)
- [Development](#development) — [Release](#release)

## What it can do

- **Read the market** — chain health, pools, token info, token search, swap quotes, and wallet
  balances. No key needed.
- **Swap** any Cookie Chain token pair through either aggregator — the
  [Cookiebox Swap API](https://agg.cookiebox.app) or [Candy Shop](https://swap.cookiescan.io) —
  both routing across all Cookie Chain DEX liquidity. Agents pick per call with the `aggregator`
  parameter and can quote both to compare. `chain: "solana"` buys/sells the bridged COOK on **Solana
  mainnet** via [Jupiter](https://jup.ag) instead.
- **Transfer** COOK or any SPL / Token-2022 token.
- **Rest limit and stop orders** in the Cookiebox limit-order escrow — take-profit at a price or
  better, or a stop-loss that sells at market once the rate falls to a trigger — filled by a keeper
  across every routable Cookie Chain market.
- **Launch tokens** on the [MomoSwap launchpad](https://momoswap.fun) — create a token on a COOK
  bonding curve, buy / sell the curve, claim after graduation, and sweep your creator fees.
- **Manage liquidity** — create pools, add / remove liquidity, claim fees, and permanently lock
  positions across Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap BAMM (venue auto-detected).
- **Liquid-stake** COOK for bCOOK and redeem it instantly.
- **Trade NFTs** on [Baked Bazaar](https://bakedbazaar.art) — search, browse, buy, list, and make /
  accept offers (Cookie Chain's Metaplex Auction House marketplace).
- **Bridge** COOK, SOL — and any token added to the bridge later — 1:1 between Cookie Chain and
  Solana mainnet over [Hyperlane](https://hyperlane.cookiescan.io).
- **Own a name** — register, transfer, and resolve `.cook` names on the
  [CookOven](https://book.cookoven.xyz) name service, and use them anywhere an address is expected
  (`transfer to: "bot.cook"`).

Safe by default: read-only until you add a key, and every money-moving action is simulated before it
is sent.

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

Your key never leaves your machine, is used only to sign locally, and is redacted from all output.
Every money-moving action is simulated before it is sent. A transaction that a venue API built (a
swap, any launchpad action) is also held to what you asked for: if its simulation would take more
than the requested amount plus fees, touch another token you hold, hand one of your token accounts
or a delegate to someone else, or deliver less than the quoted minimum, it is refused unsigned.

## Try it

Once it's registered, just talk to your agent naturally:

- _"What's the health of Cookie Chain right now?"_ → `chain_health`
- _"Find the cookhouse token and show me its price and liquidity."_ → `search_tokens` → `get_token_info`
- _"Quote swapping 10 COOK for bCOOK."_ → `get_quote`
- _"Swap 10 COOK for bCOOK."_ → `get_quote` → `trade` (needs a key; simulated first)
- Token-2022 **transfer-hook** tokens (issuer code runs on every transfer and can reject it): `get_quote` always returns `warnings[]` and `trade` returns `routeWarnings[]` — one entry per hooked mint with `reviewed`, `title`, `detail`. Read `detail` before trading. `transfer` handles hooked mints; `add_liquidity`/`create_pool` on Cookiebox CLMM split the open+deposit tx when a hooked mint would overflow it, and `create_pool` refuses up front when the mint still needs a Cookiebox TokenBadge.
- _"What COOKHOUSE NFTs are listed, and buy the cheapest under 50 COOK."_ → `search_nfts` → `buy_nft`
- _"Which wallet are you about to trade from?"_ → `get_wallet`

The agent resolves names to mint addresses with `search_tokens` / `search_nfts`, then acts on the mint —
it never turns a name straight into a trade.

## Configuration

| Variable                                   | Default                               | Purpose                                                                                           |
| ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `COOKIE_RPC_URL`                           | `https://rpc.cookiescan.io`           | Cookie Chain RPC.                                                                                 |
| `COOKIE_PRIVATE_KEY`                       | —                                     | Wallet key for money-moving tools. Read-only if unset.                                            |
| `COOKIE_SIGNER`                            | `local`                               | `external` = no key in the process; tools return `needs_signature` for the user's wallet to sign. |
| `COOKIE_WALLET_ADDRESS`                    | —                                     | External mode: default wallet when a request carries no `x-cookie-wallet` header.                 |
| `COOKIE_MCP_HTTP_PORT` / `_HOST` / `_PATH` | — / `127.0.0.1` / `/mcp`              | Serve Streamable HTTP instead of stdio (same as `--http [port]`).                                 |
| `COOKIE_MCP_CORS_ORIGIN`                   | `*`, or none with a local key         | Comma-separated browser origins allowed to call the HTTP server (`*` = any).                      |
| `COOKIE_MCP_HTTP_TOKEN`                    | —                                     | Bearer token every HTTP MCP request must send. Required with a local key over HTTP.               |
| `COOKIE_MCP_ALLOWED_HOSTS`                 | loopback names on a loopback bind     | Comma-separated `Host` values the HTTP server answers to (blocks DNS rebinding).                  |
| `COOKIE_IMAGE_DIR`                         | home directory                        | The only folder `deploy_token.imagePath` may read from (stdio only; refused over HTTP).           |
| `COOKIE_SLIPPAGE_BPS`                      | `500`                                 | Default slippage (bps).                                                                           |
| `COOKIE_REFERRER`                          | `mcp treasury`                        | Referral wallet (MomoSwap only).                                                                  |
| `SOLANA_RPC_URL`                           | `https://api.mainnet-beta.solana.com` | Solana RPC.                                                                                       |
| `JUPITER_API_KEY`                          | —                                     | Optional; else keyless Jupiter at 0.5 req/s.                                                      |

## Tools

**Reads** (no key): `chain_health`, `get_pools`, `get_token_info`, `search_tokens` (resolve a token
name/ticker to its mint), `get_quote`, `get_wallet` (which key this server signs with, and the RPC it
uses — no RPC call, so it works when the chain is down), `get_balance`, `stake_info` (bCOOK liquid-staking rate / TVL /
APY / fees), launchpad reads `get_launchpad_pools` / `get_launchpad_token` /
`get_launchpad_positions`, and NFT reads
`get_nft_listings`, `search_nfts` (resolve an NFT/collection name to a listed mint), `get_nft`,
`get_wallet_nfts`, `get_nft_offers`, `get_nft_market_stats`, and `.cook` name reads
`resolve_domain` / `get_owned_domains` / `get_domain_listings`, and `get_bridge_tokens` (what the
bridge can move).

**Money** (need `COOKIE_PRIVATE_KEY`): `trade` (swap via Cookiebox or Cookiescan), `transfer` (COOK or any token,
with an optional `memo` written through the SPL Memo program — the way to pay an invoice or payment
request that matches transfers by memo), `stake` / `unstake` (COOK ⇄ bCOOK liquid staking).

**Limit orders** ([Cookiebox](https://cookiebox.app/trade) limit-order escrow, program `L1M1tk…`):
`get_limit_orders` lists a wallet's resting orders with no key (yours, or any address / `.cook` name);
`place_limit_order` and `cancel_limit_order` need `COOKIE_PRIVATE_KEY`. An order locks the input in a
program-owned reserve; a keeper fills it through the same router `trade` uses, so any pair with a route
can rest as an order, and pays the pinned output account (partial fills possible). Two kinds:

- **`limit`** (default) is a take-profit: fills at the price **or better**. The price must sit above
  the current rate.
- **`stop`** is a stop-loss, **stop-market**: `price` is the trigger, which must sit below the current
  rate; once the executable rate falls to it the keeper sells at market and passes the proceeds
  through. A hidden on-chain floor (50% below the trigger, `floorPrice` to override) only caps what a
  compromised keeper key could pay — it is not what you receive.

The only fee is the program's **maker fee, 10 bps at launch**, deducted from each fill and read live
from chain (`fees` in `get_limit_orders`). Orders default to a one-week expiry (`expiresInSeconds`,
`0` = good-til-cancelled, max one year); an **expired order still holds its input until it is
cancelled**. Native COOK is wrapped inside the placement and refunded as COOK on cancel.

MomoSwap **curve orders** placed on cookiebox.app show up in `get_limit_orders` as well: a
`curve-buy` is an ordinary escrow order whose fill lands as curve shares (cancel it here like any
other); a `curve-sell` is a launchpad sale authorization, not an escrow — `escrowed: false`, the
shares stay spendable and `createdAt` is null. `cancel_limit_order` revokes it: the aggregator has no
`cancel-tx` for it, so this server builds the launchpad's `revoke_position_sale` itself after reading
the authorization from chain (launchpad-owned, right discriminator, your wallet as owner), followed by
the limit-order program's `settle_curve_sell(close)` when the order pays a curve-sell vault that still
exists. The result says `revoked: true`; nothing is refunded because nothing was held.

`place_limit_order` places curve orders too, for the **direct COOK pair** of a token still on its
curve (detected from the mints; `limit` only, no stops). COOK → token becomes a `curve-buy`: an
ordinary escrow order whose payout is your launchpad position, filled by the keeper's `buy_for`; the
free one-time `enable_buy_for` opt-in is added to the first order when your wallet lacks it, and the
pool's `minBuy` / per-wallet cap are checked so an unfillable order is refused up front. Token → COOK
becomes a `curve-sell`: an `approve_position_sale` for the Cookiebox keeper at your floor, one per
pool, paying your **curve-sell vault** — the limit-order program's wCOOK account for this pool and
wallet, created in the same transaction. Each fill pays the vault and the program's
`settle_curve_sell` passes it on to your wallet as **native COOK** minus the limit-order maker fee
(`makerFeeBps`, read live; `netAfterFee` is what you receive at the floor; `payoutNative: true`,
no token account needed). The floor is the price
itself: priced at P, the order fills once the curve pays P and you receive P minus the fee, like a
plain order. The keeper refuses an authorization that pays anything but the vault, so there is no
fee-free shape to place. `cancel_limit_order` revokes the authorization and, while the vault still
exists, settles and closes it too, returning both rents. Its expiry is clamped to the **sale's own end**: the
launchpad caps an authorization at 30 days and never reads the pool, but no fill is possible once the
launch closes, and a launch runs at most 7 days — so `expiresAt` is never past `saleEndsAt`, and the
one-week default would otherwise mint an order that shows a future expiry and can never fill. This
server assembles both shapes itself (the aggregator has built them since 2026-09-22, but a local
build keeps the signed bytes derived from what we read); the buy is then run through the same
instruction-level verifier as an aggregator build, and both are simulated before signing.

> ⚠️ **The aggregator builds the transaction; this server verifies it before signing.** Every
> instruction is decoded against the program IDL and checked — fee payer, maker, amounts, kind,
> expiry, the pinned refund / payout accounts, the order PDA, and that only the five expected
> programs are touched (escrow, compute budget, system, token, associated-token). A build that
> disagrees with the request is refused with nothing signed. `place_limit_order` also refuses an
> order that would fill or trigger immediately against the router's current rate (use `trade`), and a
> pair with no route at all, unless `skipMarketCheck: true`. Prices go to the API as decimal
> **strings**; a number that would print in exponent form is refused rather than rounded.

**DCA schedules** ([Cookiebox](https://cookiebox.app/trade) DCA escrow, program `DCAkvX8…` — a
separate program from the limit-order one, filled by the same keeper): `get_dca_schedules` lists a
wallet's running schedules with no key (yours, or any address / `.cook` name); `open_dca` and
`close_dca` need `COOKIE_PRIVATE_KEY`. A DCA is a stop-market order that fires on a **clock** instead
of a price, N times: the **whole budget is escrowed at open**, and each cycle the keeper may release
at most one `amountPerCycle` slice, swap it through the same router `trade` uses, and pay the
proceeds into the account pinned at open. The program — not the keeper — owns the schedule, so a
stolen keeper key cannot accelerate it.

- Split the budget with **either** `cycles` **or** `amountPerCycle`. The slice is rounded **up**, so
  the count the program derives (`ceil(amount / slice)`, max 1024) can be one lower than the one you
  asked for; every result reports the derived number, never the typed one.
- `cycleSeconds` is 60 … 31,536,000 (a minute to a year). `startAt` (unix **seconds**) delays the
  first cycle; a past timestamp is refused rather than clamped, because the program's `max(now)`
  would fire it immediately.
- `minPrice` / `maxPrice` are an **optional** per-cycle band on the output, quoted per full slice.
  `minPrice` is the protective one; `maxPrice` guards against an implausibly good fill on a
  manipulated pool. A cycle outside the band — or with no route — is **skipped, never caught up**, so
  the band is checked against the router's executable rate **for one slice** before opening and an
  unsatisfiable one is refused unless `skipMarketCheck: true`. A band quoted off a mid price is a
  band the keeper can never satisfy.
- The only fee is the DCA program's own **maker fee** (10 bps, 3 on a stable pair), deducted from
  each cycle's proceeds and read live from its `Fee` singleton. Native COOK input is wrapped inside
  the open and refunded as COOK by `close_dca`.
- `get_dca_schedules` reports `averagePrice` — what the schedule has actually bought at so far, the
  one number a list of individual fills never gives — and flags `status: "overdue"`, which means a
  cycle was **missed**: the program drops it instead of catching up, so it is a real loss, not a
  delay.
- **Not supported:** Token-2022 mints (the keeper signs every cycle with the classic token program)
  and MomoSwap tokens still on their bonding curve (a cycle fills through the router, which has no
  curve `buy_for` leg, unlike a curve _limit_ order). Both are refused before anything is escrowed.
- `close_dca` returns the **unspent** remainder; whatever the schedule already bought is already in
  the wallet. A schedule that spends its whole budget closes itself and stops being listed.

The open/close transactions are built by the aggregator and verified here exactly as the limit-order
ones are — user, amounts, frequency, the band, the start time, the schedule PDA against the signing
`base`, the pinned refund/payout accounts, the five allowed programs — and simulated before signing.

**Launchpad** (need `COOKIE_PRIVATE_KEY`, [MomoSwap](https://momoswap.fun)): `deploy_token` launches a
token on a COOK bonding curve (a logo is **required** — pass `imageBase64` and it is pinned to IPFS, or
set `noLogo: true` to launch without one; the metadata is immutable, so a logo cannot be added later.
Costs the launchpad creation fee, read from its config at call time, plus any
`devBuyCook`; `maxCostCook` caps the total and is required with `devBuyPctOfTotalSupply`),
`launchpad_buy` / `launchpad_sell` trade that curve, `claim_launchpad`
settles a position (the real SPL token after graduation, a Fair-mode refund, or a Jackpot/Survivor payout),
and `claim_creator_fees` sweeps the creator's share of trading fees from a launch you created.

> ⚠️ **Before graduation, holdings are program-tracked curve shares, not SPL tokens** — they do not
> appear in `get_balance` and `trade` cannot route them. Exit with `launchpad_sell`, or claim the real
> token with `claim_launchpad` once the pool graduates; from then on it trades like any other token.

Because those shares are invisible to `get_balance`, **`get_launchpad_positions`** is the portfolio
view: every launch a wallet has a position in, what it is worth on a live curve, and what is unclaimed
(tokens after graduation, a Fair-mode refund, a settlement payout, creator fees or vesting). It reads
the `UserPosition` accounts straight from the chain in batches, so it costs about one RPC round trip
per 100 launches. Pass `owner` for any wallet, or omit it for your own.

A pre-graduation token also has no DEX pool at all, so `get_quote` / `trade` would just report "no
route". They now recognise that case and point at the launchpad tools instead, and `get_token_info`
adds a `launchpad` field when a mint shows no price or liquidity because it is still on a curve.

**Liquidity** (need `COOKIE_PRIVATE_KEY`): `create_pool`, `add_liquidity`, `remove_liquidity`,
`claim_fees` (Cookiebox DAMM v2, Cookiebox CLMM, and CookieSwap BAMM, venue auto-detected),
`lock_liquidity` (Cookiebox DAMM v2 and Cookiebox CLMM, permanent and irreversible — CLMM locks the
whole position; fees stay claimable either way). Concentrated-liquidity venues (CLMM / BAMM) open a
full-range position by default.

**NFT marketplace** (need `COOKIE_PRIVATE_KEY`, [Baked Bazaar](https://bakedbazaar.art)): `buy_nft`,
`list_nft`, `cancel_listing`, `make_offer`, `accept_offer`, `cancel_offer`. Built on the Cookie Chain
Metaplex Auction House (1% marketplace fee + creator royalties); every action is built and signed
locally.

**Bridge** (need `COOKIE_PRIVATE_KEY`): `bridge` moves a token 1:1 between Cookie Chain and Solana
mainnet over the [Hyperlane](https://hyperlane.cookiescan.io) warp routes (`token` = a symbol or mint,
default `COOK`; `direction` = `cookie-to-solana` | `solana-to-cookie`). Today that is **COOK** (native
COOK on Cookie ⇄ a 6-decimal Token-2022 SPL COOK on Solana) and **SOL** (native SOL on Solana ⇄ a
synthetic SOL token on Cookie, mint `6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb`). Amounts are in the
token's own units either way. One source-chain signature dispatches the transfer; a relayer delivers on
the far side in a few minutes — check with `bridge_status` (a read, by Hyperlane message id).

**New tokens work without an update.** `get_bridge_tokens` and `bridge` don't carry a token list: they
find every warp program on Cookie Chain owned by the bridge's upgrade authority, read each one's
Hyperlane token account (route type, mint, decimals, IGP, enrolled Solana router), and accept a route
only when the Solana program it names is on the Solana mailbox and routes back to it. A token the bridge
team adds is bridgeable as soon as its route is enrolled; a program anyone else deploys is never listed.
Discovery is cached for 10 minutes. If the Cookie RPC ever refuses the program listing, the built-in
COOK and SOL routes are still checked and `get_bridge_tokens` says so in `warnings`.

Simulates first, and **preflights the destination** before signing, because source-chain simulation
cannot see the far side:

- **Collateral.** A route that releases on the far side (native coin, or an escrow) can only pay out
  what that account holds; a larger transfer would take your funds behind an undeliverable message.
  `bridge` refuses it and reports what is there as `destinationCollateral` (null when the destination
  mints the token instead, like SOL on Cookie).
- **A native payout to an empty wallet** must reach the rent-exempt minimum, or the delivery is
  rejected on every retry after your funds are gone. `bridge` refuses anything smaller.
- **The recipient's token account.** A token delivery credits an associated token account; if the
  recipient has none, `bridge` **creates it from your wallet first** (one extra tx on the destination,
  a little of that chain's native coin in rent, reclaimable by closing the account) and confirms it
  before dispatching — so a failure there costs nothing. The warp route can create it itself, but pays
  from a PDA funded once at deploy time; when that runs dry the relayer's delivery fails _in
  simulation_, never reaches the chain, and the transfer hangs with no error anywhere (this happened
  on 2026-08-26). Pass `createRecipientAccount: false` to rely on that PDA instead — then `bridge`
  refuses when it is provably dry. The result reports the account as `recipientTokenAccount`.

The bridge website adds a flat fee to its own transfers (0.01 SOL / 15,000 COOK to the relayer). That
fee is enforced by the site, not by the warp programs, and `bridge` does not add it.
`get_balance` with `chain: "solana"` shows the Solana side before you bridge — the wallet's SPL
COOK (what `solana-to-cookie` spends), its SOL (the fee and interchain gas, and what a SOL bridge
spends), and `bridgeTokens`: every other token the bridge can move out of Solana, discovered on-chain
like the routes. It does not enumerate unrelated Solana tokens. On an RPC that refuses
`getTokenAccountsByOwner` (Shyft's free plan does), it reads each token's standard account instead and
adds a warning that tokens held elsewhere aren't counted.
**Swap on Solana** (`get_quote` / `trade` with `chain: "solana"`): routes **Solana mainnet** liquidity
through [Jupiter](https://jup.ag) instead of Cookie Chain — how you buy or sell the bridged SPL COOK
(`36ZrtQoab5MhhySaP1YSTwUahSk6GRVUTtZ6cuVfm9e1`) once it is on the far side. Same non-custodial shape as
every other swap: Jupiter quotes and builds, we simulate on your Solana RPC, sign locally, send, confirm.
Fees are paid in **SOL**, and the **same `COOKIE_PRIVATE_KEY` signs on both chains** — run `get_wallet`
first. Two things to know:

- **Scoped to COOK on purpose.** One leg must be the SPL COOK mint, so `SOL → COOK` and
  `COOK → USDC` work while an unrelated pair like `SOL → USDC` is refused. Jupiter would route it;
  this server is for Cookie Chain, and every extra pair is surface that can move funds.
- **`So1111…112` is COOK on Cookie Chain but wSOL on Solana** — the identical mint string, a different
  asset. Token metadata is resolved per chain, and the `aggregator` parameter (Cookie Chain only) is
  rejected rather than ignored when `chain: "solana"`.
- **`trade` refuses the public Solana endpoint.** Quotes need no RPC at all, but a swap does, and
  `api.mainnet-beta.solana.com` rate-limits `sendTransaction` hardest — a send that lands late against
  your slippage cap _fails_. Point `SOLANA_RPC_URL` at a dedicated RPC (a free Helius/Triton/QuickNode
  key is enough).

The bridge works out of the box on mainnet. For a different deployment, override the mailboxes
(`COOKIE_MAILBOX` / `SOLANA_MAILBOX`), the upgrade authority discovery trusts
(`BRIDGE_COOKIE_UPGRADE_AUTHORITY`; `""` turns discovery off), and add a Cookie warp program to always
check with `COOKIE_WARP_PROGRAM_ID`. The Solana side and the IGP are read from the routes themselves.

**`.cook` names** ([CookOven](https://book.cookoven.xyz)): `resolve_domain` looks a name up — owner,
registration date, resolver/metadata pointers — or reports it as available with the live price;
`get_owned_domains` lists every name a wallet holds and which is its primary. Writes need
`COOKIE_PRIVATE_KEY`: `register_domain`, `set_primary_domain` (or `clear: true` to unset),
`transfer_domain`, `update_domain`. Everything is read and built straight from the on-chain registry —
no API, no indexer. The suffix is optional everywhere: `chef` and `chef.cook` are the same name.

Once you own a name you can use it instead of an address: `transfer`, `get_balance`,
`get_wallet_nfts`, `get_nft_offers`, `get_launchpad_positions` and `transfer_domain` all accept a
`.cook` name wherever they take a Cookie Chain wallet. A plain base58 address costs no extra lookup.

**`.cook` domain marketplace** ([CookOven Marketplace](https://market.cookoven.xyz)): the secondary
market for names that are already registered — often cheaper than the 15,000–35,000 COOK registration,
and the only way to get a name somebody else already owns. `get_domain_listings` browses it with no key
(filter by `name`, `seller`, `maxPriceCook` or `maxLength`; sort by price, length or recency) and
reports the live marketplace fee, which the seller pays out of the sale price. Writes need
`COOKIE_PRIVATE_KEY`: `list_domain` (asking price in COOK), `buy_domain`, `cancel_domain_listing`.
Read and built straight from the program — no API, no indexer.

> ⚠️ **Listing escrows the name.** `list_domain` hands the domain to the marketplace's escrow account
> in the same instruction, so while it is listed the registry reports the escrow as its owner: the
> seller cannot `transfer_domain`, `update_domain` or `set_primary_domain` on it, and it stops
> resolving to a payable address. Those tools say so explicitly rather than reporting a stranger as the
> owner, and passing a listed name where an address is expected is **refused** — the escrow is a
> program account, so paying it would strand the funds. `cancel_domain_listing` reverses a listing at
> any time and refunds its rent. There is no re-price instruction: cancel, then list again.
>
> `buy_domain` requires `maxPriceCook` for the same reason `register_domain` does — the instruction
> carries no price argument, so that cap is the only guard. Without it you get the asking price
> quoted back and nothing is spent.

Use the COOK / native mint `So11111111111111111111111111111111111111112` for COOK. Every tool returns
JSON; failures return `{ error, hint }` — never a stack trace, never your key.

## Hosted / wallet-signed mode

The default setup assumes you are both the operator and the user. A hosted product — a web chat, a
Telegram bot, a shared agent — cannot hold users' keys and should not ask for them. For that,
cookie-mcp runs **without any key** and lets the user's own wallet sign:

```bash
COOKIE_SIGNER=external COOKIE_MCP_HTTP_TOKEN=<long random secret> \
COOKIE_MCP_ALLOWED_HOSTS=mcp.example.com COOKIE_MCP_CORS_ORIGIN=https://app.example.com \
  npx cookie-mcp --http 3000 --host 0.0.0.0
```

- Every request names the wallet it acts for with an `x-cookie-wallet: <base58>` header (or set
  `COOKIE_WALLET_ADDRESS` for a single-wallet deployment). Reads work as before.
- Every money-moving tool runs **all** of its checks — instruction decoding, spend refusals, the
  simulation and its balance check — and then, instead of signing, returns a normal (non-error)
  result:

  ```json
  {
    "status": "needs_signature",
    "tool": "transfer",
    "kind": "transaction",
    "what": "transfer",
    "signer": "FFWf…4wq2",
    "transactionBase64": "AQAAAA…",
    "version": "legacy",
    "blockhash": "6FdF…TSvT",
    "lastValidBlockHeight": 24638662,
    "submit": { "via": "cookie-rpc" },
    "step": "final",
    "summary": { "to": "…", "symbol": "COOK", "amount": "0.001" },
    "next": "sign transactionBase64 with wallet … then call submit_signed_tx …"
  }
  ```

  Your app hands `transactionBase64` to the browser wallet **unchanged** (it is already co-signed by
  any ephemeral or API-side signers), then calls **`submit_signed_tx`** with the signed bytes and the
  same `submit` / `blockhash` / `lastValidBlockHeight` / `what` fields. It sends on the named route
  (Cookie RPC, Solana RPC, or Candy Shop) and confirms. It refuses bytes that still lack a signature
  and never builds transactions itself.

- `step: "intermediate"` marks a prerequisite (wrapping COOK for a dev buy, creating a Solana token
  account before a bridge, CLMM tick-array init). After it confirms, call the same tool again with the
  same arguments to continue.
- `kind: "message"` (only `deploy_token`, for the launchpad login) asks the wallet to `signMessage`
  the exact text; call `deploy_token` again with `loginSignature: { message, signature }`. In
  external mode the session is not cached server-side (the wallet header proves nothing), so every
  launch asks for its own login signature.
- The NFT tools add `bazaarLog`. Pass it back to `submit_signed_tx` and, once the transaction
  confirms, it tells Baked Bazaar's indexer about the trade (a local signer does this itself), so the
  listing or offer shows up without waiting for the indexer's own scan.
- Blockhashes expire in about a minute. If the wallet prompt is slow, `submit_signed_tx` reports the
  timeout with the signature and a "do not retry blindly" hint; re-run the tool for fresh bytes.
- The HTTP server is stateless (one fresh server per POST) and answers `/healthz`. A loopback bind
  is **not** private: any web page open in a browser on the same machine can reach `127.0.0.1`. So
  every request is checked first. The `Host` must be one the server answers to (loopback names on a
  loopback bind, else `COOKIE_MCP_ALLOWED_HOSTS`), which defeats DNS rebinding. A request from a
  browser (one with an `Origin` header) must match `COOKIE_MCP_CORS_ORIGIN`. Unset, that allows any
  origin with an external signer, where a page can only get unsigned transactions the user's wallet
  still has to approve, and **no** origin when the server holds a local key. With
  `COOKIE_MCP_HTTP_TOKEN` set, `Authorization: Bearer <token>` is required. The server **refuses to
  start** with a local `COOKIE_PRIVATE_KEY` unless both `COOKIE_HTTP_ALLOW_LOCAL_KEY=1` and
  `COOKIE_MCP_HTTP_TOKEN` are set, because anyone reaching the port could spend from that key.

**As a library.** The same flows are importable without MCP:

```ts
import {
  ExternalSigner,
  transfer,
  submitSignedTransaction,
  runWithRequestContext,
} from "cookie-mcp";
import { createServer } from "cookie-mcp/server"; // embed the MCP server in your own process
```

Money functions resolve their signer from `COOKIE_SIGNER` + the request context
(`runWithRequestContext({ wallet }, () => transfer({...}))`) and throw `SignatureRequired` with the
same payload the tool returns. Local agents (`COOKIE_PRIVATE_KEY`, stdio) are unaffected by any of this.

Each domain is also its own entry, so an app that needs one flow does not bundle every venue SDK the
barrel pulls in: `cookie-mcp/trade`, `/transfer`, `/stake`, `/bridge`, `/bridge-routes`, `/nft`,
`/domains`, `/launchpad`, `/limit-orders`, `/dca`, `/liquidity`, `/quote`, `/balances`, plus
`/signer`, `/context`, `/submit` and `/errors`. They share state with the barrel (one request context,
one wallet cache), so mixing them is safe.

```ts
import { trade } from "cookie-mcp/trade"; // ~100 KB gzipped, against ~450 KB for the barrel
import { runWithRequestContext } from "cookie-mcp/context";
import { SignatureRequired } from "cookie-mcp/signer";
```

The library also bundles for edge runtimes (Cloudflare Workers, Vercel Edge). On Workers enable
`nodejs_compat` (for `AsyncLocalStorage`, `node:net`, `node:dns`) and make sure your variables reach
`process.env` — configuration is read from it at import time — which is the default from compatibility
date `2025-04-01`, or the `nodejs_compat_populate_process_env` flag before that. `deploy_token`'s
`imageUrl` fetch goes over `node:https`, which Workers provide from compatibility date `2025-08-15`
(or `enable_nodejs_http_modules`); on an older date pass `imageBase64` instead.

## Safety

Non-custodial: no remote key storage. With a local key it stays in `COOKIE_PRIVATE_KEY`, signs locally,
and is redacted from all output. In hosted mode the process holds no key at all and the user's wallet
signs. Read-only until a signer is configured; every money-moving action is simulated before it is
sent (or handed out for signing).

## Development

```bash
yarn install
yarn test    # lint + format + typecheck + unit tests + boot smoke
yarn mcp     # run the server on stdio from source (tsx)
yarn build   # bundle to dist/ (CLI, `cookie-mcp/server` factory, `cookie-mcp` library + subpaths)
```

To point an agent at a local checkout instead of the published package, set the command to
`npx tsx /ABS/PATH/cookie-mcp/src/mcp/server.ts`. `--http [port]` serves Streamable HTTP instead.

### Release

A release is an npm publish plus a re-publish of the same version to the
[MCP Registry](https://registry.modelcontextprotocol.io); third-party directories (mcpservers.org
and friends) mirror the registry entry, so the registry step is what actually updates them. Keep npm
`latest` current with `main` — the directories scrape GitHub, and a lagging npm gives people a
README that promises tools the installed server does not have.

1. **Bump the version in three places**, all to the same string: `package.json` `version`, and
   `server.json` both top-level `version` and `packages[0].version`. The registry rejects a mismatch,
   and `mcpName` in `package.json` must stay `io.github.cookiechain/cookie-mcp` (the registry checks
   the published tarball for it).
2. **CHANGELOG:** rename the `[Unreleased]` heading to
   `# [X.Y.Z](https://github.com/cookiechain/cookie-mcp/releases/tag/vX.Y.Z)` with a dated line
   under it, then open a fresh `# [Unreleased]` above it for the next cycle.
3. **Gate:** `yarn test` — the same lint / format / typecheck / unit / smoke run as CI. Every new tool
   must be listed in `EXPECTED_TOOLS` in `scripts/smoke.ts` (the smoke only reports _missing_ names,
   so a tool you forgot to add there passes silently) and in the [Tools](#tools) list above.
4. **Check the tarball:** `npm pack --dry-run`. It must contain only `dist/**`, `README.md`,
   `LICENSE` and `package.json` — no `src/`, `.env`, key material or absolute paths.
   `prepublishOnly` runs `yarn build` (tsup) so `dist/` is always rebuilt from the tagged source.
5. **Commit, tag, release:** commit as `Release X.Y.Z`, tag `vX.Y.Z`, `git push --tags`, and create
   the GitHub release from the tag with the CHANGELOG section as its body (the CHANGELOG links point
   at that release page).
6. **Publish to npm:** `npm publish`, then verify with `npm view cookie-mcp version` and a pinned
   boot from a clean directory: `npx -y cookie-mcp@X.Y.Z` must start and register every tool.
   > An `E404 … PUT …/cookie-mcp … could not be found or you do not have permission` from
   > `npm publish` is almost never a missing package — npm reports an unauthenticated publish as 404. Run `npm whoami`; if it fails, `npm login` and publish again.
7. **Publish to the MCP Registry:** `brew install mcp-publisher`, then from the repo root
   `mcp-publisher login github && mcp-publisher publish`. The `io.github.cookiechain/*` namespace
   requires you to be an **owner** of the GitHub org. If the device-flow login still falls back to
   your personal namespace with a 403, the org restricts OAuth apps — log in with a classic PAT
   that has `read:org` instead: `MCP_GITHUB_TOKEN=<pat> mcp-publisher login github`.

## License

This project is licensed under the terms of the MIT license. See the [LICENSE](./LICENSE) file.
