// Library entry point (`import { ... } from "cookie-mcp"`). Everything the MCP tools do is here as
// plain async functions, so a web app, a bot, or another MCP server can reuse the same
// build → verify → simulate → sign → send flows without speaking MCP — and, with an `ExternalSigner`,
// without ever holding a key. See README § "Embedding / hosted mode".
export * from "./core/signer";
export * from "./core/context";
export * from "./core/submit";
export * from "./core/wallet";
export * from "./core/errors";
export * from "./core/config";
export * from "./core/format";
export * from "./core/confirm";
export * from "./core/rpc";
export * from "./core/health";
export * from "./core/pools";
export * from "./core/token";
export * from "./core/quote";
export * from "./core/balances";
export * from "./core/trade";
export * from "./core/transfer";
export * from "./core/stake";
export * from "./core/bridge";
export * from "./core/limitOrders";
export * from "./core/dca";
export * from "./core/liquidity";
export * from "./core/nft";
// The `.cook` domain tools. Its `filterSortListings` / `toListingView` clash with the NFT ones, so the
// domain module is exported as a namespace rather than flattened.
export * as domains from "./core/domains";
export {
  resolveDomain,
  getOwnedDomains,
  getDomainListings,
  registerDomain,
  setPrimaryDomain,
  transferDomain,
  updateDomain,
  listDomain,
  buyDomain,
  cancelDomainListing,
  resolveWallet,
} from "./core/domains";
export * from "./core/launchpad";
export { VERSION } from "./version";
