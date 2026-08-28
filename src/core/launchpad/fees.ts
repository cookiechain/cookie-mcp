// Per-pool fee resolution — pure.
//
// `create_pool` SNAPSHOTS the whole fee schedule onto the Pool account, so a later admin
// `update_config` cannot re-price a pool that is already trading. Quoting a specific pool off the
// GLOBAL `/config` bps is therefore wrong for every pool created before the last retune, and the two
// already disagree on-chain today (pool SAKURA carries 75 bps / 3500-2500-2500-1500 while `/config`
// reports 100 / 3000-3500-2000-1500).
//
// So: ALWAYS resolve a pool's fee through here; never read `cfg.tradeFeeBps` directly for a pool.
//
// The snapshot fields are OPTIONAL on `LaunchpadPool` on purpose, and as of 2026-08-28 they are STILL
// never sent: the program's `Pool` account carries them (`trade_fee_bps` … `buyback_fee_bps`), but the
// backend's pool serializer — `DecodedPool` in `momoswap-backend/src/services/launchpad/program.ts` —
// simply does not copy them out, on `main` or in production. So every pool JSON arrives without them
// and every call here falls through to `/config`, i.e. exactly the behaviour this module replaces.
// That makes the module a no-op today and correct the moment the backend starts serving them — which
// is the point: nothing here has to change when it does.
import type { LaunchpadConfig, LaunchpadPool } from "./api";

/** The launch default (1%), used only when neither the pool nor `/config` states a fee. */
export const DEFAULT_TRADE_FEE_BPS = 100;

/** 100% in bps. Every value resolved here is a bps fraction OF this, so it is also the ceiling. */
const BPS_DENOMINATOR = 10_000;

/** The four fee-split shares a pool snapshots. Each is a share OF the trade fee, in bps. */
export type FeeShare = "treasury" | "creator" | "referral" | "buyback";

const SHARE_FIELD: Record<FeeShare, keyof LaunchpadConfig & keyof LaunchpadPool> = {
  treasury: "treasuryFeeBps",
  creator: "creatorFeeBps",
  referral: "referralFeeBps",
  buyback: "buybackFeeBps",
};

/**
 * First candidate that is a usable bps value.
 *
 * Coerces and range-checks rather than relying on `??` alone, for two reasons: a value can arrive as
 * a *string* (it is JSON off the wire), and garbage must fall through to the next source instead of
 * poisoning a quote with `NaN`. `0` is a legitimate fee — the zero-fee deployment `EZWe5C5g…` really
 * does run at 0 bps — so it must be honoured, never treated as missing. That rules out `||`.
 *
 * The upper bound is `BPS_DENOMINATOR`, **not** the program's `MAX_TRADE_FEE_BPS` (1000). 100% is a
 * mathematical ceiling for anything expressed as bps of the denominator, whereas 1000 is a policy
 * constant a later upgrade can raise — bound at 1000 and the day the cap moves, a pool with a
 * legitimate higher snapshot gets discarded in favour of `/config` and we understate the fee the
 * chain is actually charging, which is the very failure this module exists to prevent. So the bound
 * only ever catches a corrupt response, and then it falls through instead of poisoning a quote.
 */
function firstBps(candidates: unknown[], fallback: number): number {
  for (const c of candidates) {
    if (c === null || c === undefined || c === "") continue;
    // Only a number or a numeric string is a candidate. This is stricter than the frontend's
    // equivalent helper on purpose — do not "sync" it back: `Number([])` is 0, so an array-valued
    // field would be honoured as a 0% fee, silently understating what the chain charges. Every other
    // object coerces to NaN and falls through anyway, so this only closes the array hole.
    if (typeof c !== "number" && typeof c !== "string") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0 && n <= BPS_DENOMINATOR) return n;
  }
  return fallback;
}

/** The trade fee to quote THIS pool with, in bps. Pool snapshot → global config → 1%. */
export function poolTradeFeeBps(
  pool: Partial<LaunchpadPool> | null | undefined,
  cfg: Partial<LaunchpadConfig> | null | undefined,
): number {
  return firstBps([pool?.tradeFeeBps, cfg?.tradeFeeBps], DEFAULT_TRADE_FEE_BPS);
}

/**
 * One share OF the trade fee for THIS pool, in bps (creator = 3500 means the creator gets 35% *of*
 * the fee, not 35% of the trade). Falls back to 0 — unknown means "don't claim a split".
 *
 * This resolves its source independently of `poolTradeFeeBps`, so in principle a caller reporting
 * both could pair a pool's fee with the config's share. It cannot in practice, and the reason is an
 * invariant worth keeping: the API serializes a pool's snapshot fields together, so a pool's schedule
 * arrives whole or not at all. Should that ever become per-field, callers start mixing two schedules.
 */
export function poolFeeShareBps(
  pool: Partial<LaunchpadPool> | null | undefined,
  cfg: Partial<LaunchpadConfig> | null | undefined,
  share: FeeShare,
): number {
  const field = SHARE_FIELD[share];
  return firstBps([pool?.[field], cfg?.[field]], 0);
}
