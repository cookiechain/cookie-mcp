// MomoSwap paired launches — pure math and view helpers.
//
// A paired launch is a launchpad curve whose token is a Token-2022 mint with a transfer-fee "holder
// tax"; the harvested tax is sold and paid out to holders in a chosen "pair asset" (COOK, bCOOK, …).
// On chain it is its own pool state (`PairedOpen`, 4) traded by `buy_paired` / `sell_paired`; every
// standard instruction refuses it. Three things change for a trader:
//
//   - **Holdings are real tokens.** There are no curve shares: a buy lands Token-2022 tokens in the
//     wallet (visible in get_balance), and a sell spends them.
//   - **The tax.** Every transfer withholds `ceil(amount × bps / 10_000)` in the RECEIVING account: a
//     buyer receives `tokens_out − tax`; a sell sends `tokens_in` and the curve prices only what reached
//     the vault, `tokens_in − tax`.
//   - **No deadline, and a hard stop at the graduation target.** A buy nets at most
//     `cap = max(target − raised, floor)`; over it the program charges the smallest payment that nets
//     exactly `cap`, so a buyer may be charged LESS than offered.
//
// The quote functions are a line-for-line port of momoswap-backend `paired-quote.ts`, itself a port of
// the program's `paired.rs`, and are pinned by `paired.test.ts` against trades recorded by running the
// program (`__fixtures__/paired-svm-trades.json`) — so a quote here is what the chain does, to the unit.
import { CookieMcpError } from "../errors";
import { reserves, type CurveState } from "./curve";

const BPS = 10_000n;

const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;
const ceilDiv = (a: bigint, b: bigint): bigint => (a % b === 0n ? a / b : a / b + 1n);

const quoteError = (error: string, hint = "check the amount against get_launchpad_token") =>
  new CookieMcpError(error, hint);

/** The tax a transfer of `amount` withholds at `bps` (`transfer_tax`): ceil, 0 for nothing. */
export function pairedTransferTax(amount: bigint, bps: number): bigint {
  if (amount === 0n || bps === 0) return 0n;
  return mulDivCeil(amount, BigInt(bps), BPS);
}

/** The smallest amount whose transfer at `bps` delivers at least `net` (`gross_up_for_tax`). */
export function grossUpForTax(net: bigint, bps: number): bigint {
  if (BigInt(bps) >= BPS) throw quoteError("invalid tax rate");
  return mulDivCeil(net, BPS, BPS - BigInt(bps));
}

/** The smallest net payment that buys at least `tokens` from reserves `(x, y)` (`net_for_tokens`). */
export function netForTokens(x: bigint, y: bigint, tokens: bigint): bigint {
  if (tokens >= y) throw quoteError("not enough tokens left on the curve for this size");
  const newX = ceilDiv(x * y, y - tokens);
  return newX > x ? newX - x : 0n;
}

/** `floor(amount × (10_000 − slippage) / 10_000)` — the on-chain floor for a shown amount. */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  const s = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  return mulDiv(amount, BPS - s, BPS);
}

/** `(payment, fee, net)` for a buy that may net at most `cap` (`paired_buy_amounts`). */
export function pairedBuyAmounts(
  paymentAmount: bigint,
  tradeFeeBps: number,
  cap: bigint,
): { payment: bigint; fee: bigint; net: bigint } {
  const f = BigInt(tradeFeeBps);
  const fee = mulDiv(paymentAmount, f, BPS);
  const net = paymentAmount - fee;
  if (net <= cap) return { payment: paymentAmount, fee, net };
  if (cap === 0n) throw quoteError("this launch has reached its graduation target");
  const payment = mulDiv(cap - 1n, BPS, BPS - f) + 1n;
  const fee2 = mulDiv(payment, f, BPS);
  const net2 = payment - fee2;
  if (net2 !== cap || payment > paymentAmount) {
    throw quoteError("could not fit this buy to the graduation target");
  }
  return { payment, fee: fee2, net: net2 };
}

/** Pool fields a paired quote reads. */
export interface PairedCurveState extends CurveState {
  tradeFeeBps: number;
  graduationTarget: string;
  saleTokenSupply: string;
  minBuy?: string | null;
}

export interface PairedQuote {
  side: "buy" | "sell";
  taxBps: number;
  /** Raw token units withheld by the tax (on the buyer's receipt, or on the way into the vault). */
  taxAmount: bigint;
  /** What lands in the wallet: tokens net of tax (buy), COOK net of the trade fee (sell). */
  amountOut: bigint;
  /** `amountOut` after slippage — the on-chain floor. */
  minOut: bigint;
  /** Buy: COOK the program charges (less than offered when it stops at the target). Sell: tokens in. */
  amountInUsed: bigint;
  /** The trade fee, in COOK. */
  feeRaw: bigint;
  /** Buy: tokens leaving the vault (before tax). Sell: tokens reaching the vault (after tax). */
  curveTokens: bigint;
  /** Buy: net payment the curve prices. Sell: the curve's gross payout before the fee. */
  curvePayment: bigint;
  /** Curve slippage in bps, fee and tax excluded. */
  priceImpactBps: number;
}

const big = (v: string | number | null | undefined): bigint =>
  v === null || v === undefined || v === "" ? 0n : BigInt(String(v));

/** Quote `buy_paired(paymentRaw)` — `process_buy_paired` from the cap through the tax. */
export function quotePairedBuy(
  state: PairedCurveState,
  paymentRaw: bigint,
  taxBps: number,
  slippageBps = 100,
): PairedQuote {
  if (paymentRaw <= 0n) throw quoteError("amount must be greater than 0");
  const minBuy = big(state.minBuy);
  if (paymentRaw < minBuy) throw quoteError(`amount is below this pool's minimum buy`);
  const { x, y } = reserves(state);
  const raised = big(state.paymentRaisedNet);
  const target = big(state.graduationTarget);
  const remaining = target > raised ? target - raised : 0n;
  if (remaining === 0n) {
    throw quoteError(
      "this launch has reached its graduation target",
      "it is migrating to its market — once that pool exists, trade it with trade / get_quote",
    );
  }
  const floor = netForTokens(x, y, grossUpForTax(1n, taxBps));
  const cap = remaining > floor ? remaining : floor;
  const { payment, fee, net } = pairedBuyAmounts(paymentRaw, state.tradeFeeBps, cap);
  if (net <= 0n) throw quoteError("amount is entirely consumed by the fee", "increase the amount");
  const tokensOut = y - ceilDiv(x * y, x + net);
  if (tokensOut <= 0n)
    throw quoteError("amount too small to buy a whole token unit", "increase the amount");
  if (big(state.tokensSold) + tokensOut > big(state.saleTokenSupply)) {
    throw quoteError("not enough tokens left on the curve for this size", "lower the amount");
  }
  const tax = pairedTransferTax(tokensOut, taxBps);
  const received = tokensOut - tax;
  if (received <= 0n)
    throw quoteError("amount too small to deliver a token after the tax", "increase the amount");
  const impact = (net * y * BPS) / (tokensOut * x) - BPS;
  return {
    side: "buy",
    taxBps,
    taxAmount: tax,
    amountOut: received,
    minOut: withSlippage(received, slippageBps),
    amountInUsed: payment,
    feeRaw: fee,
    curveTokens: tokensOut,
    curvePayment: net,
    priceImpactBps: Number(impact < 0n ? 0n : impact),
  };
}

/** Quote `sell_paired(tokensRaw)` — tax off on the way in, the curve prices what arrived, fee off that. */
export function quotePairedSell(
  state: PairedCurveState,
  tokensRaw: bigint,
  taxBps: number,
  slippageBps = 100,
): PairedQuote {
  if (tokensRaw <= 0n) throw quoteError("amount must be greater than 0");
  const { x, y } = reserves(state);
  const tax = pairedTransferTax(tokensRaw, taxBps);
  const arrived = tokensRaw - tax;
  if (arrived <= 0n)
    throw quoteError("amount too small to reach the pool after the tax", "increase the amount");
  if (arrived > big(state.tokensSold))
    throw quoteError("more tokens than the curve has sold", "lower the amount");
  const gross = x - ceilDiv(x * y, y + arrived);
  if (gross <= 0n)
    throw quoteError("amount too small to sell for a whole COOK unit", "increase the amount");
  if (big(state.paymentRaisedNet) < gross) {
    throw quoteError("the pool has insufficient liquidity for this size", "lower the amount");
  }
  const fee = mulDiv(gross, BigInt(state.tradeFeeBps), BPS);
  const out = gross - fee;
  if (out <= 0n)
    throw quoteError("proceeds are entirely consumed by the fee", "increase the amount");
  const impact = BPS - (gross * y * BPS) / (arrived * x);
  return {
    side: "sell",
    taxBps,
    taxAmount: tax,
    amountOut: out,
    minOut: withSlippage(out, slippageBps),
    amountInUsed: tokensRaw,
    feeRaw: fee,
    curveTokens: arrived,
    curvePayment: gross,
    priceImpactBps: Number(impact < 0n ? 0n : impact),
  };
}

/** Config fields `pairedSeedCappedAtTarget` reads. */
export interface PairedLaunchConfig {
  graduationTarget: string;
  defaultVirtualPaymentReserve?: string;
  defaultVirtualTokenReserve?: string;
  defaultTotalSupply: string;
  creatorVestBps: number;
  graduationFee: string;
}

/**
 * Would a launch at `taxBps` graduate with its market seed cut short (`paired_seed_capped_at_target`)?
 * `create_paired_pool` refuses such a tier with `InvalidTaxTier` (6065). Null when the launch curve is
 * not published, so it cannot be worked out.
 */
export function pairedSeedCappedAtTarget(cfg: PairedLaunchConfig, taxBps: number): boolean | null {
  if (!cfg.defaultVirtualPaymentReserve || !cfg.defaultVirtualTokenReserve) return null;
  const target = big(cfg.graduationTarget);
  const vx = big(cfg.defaultVirtualPaymentReserve);
  const vy = big(cfg.defaultVirtualTokenReserve);
  const sold = vy - ceilDiv(vx * vy, vx + target);
  const x = vx + target;
  const y = vy - sold;
  const vest = mulDiv(target, BigInt(cfg.creatorVestBps), BPS);
  const afterVest = target - vest;
  const gradFee = big(cfg.graduationFee);
  const lpPayment = afterVest - (gradFee < afterVest ? gradFee : afterVest);
  const priced = mulDiv(lpPayment, y, x);
  const unsold = big(cfg.defaultTotalSupply) - sold;
  return grossUpForTax(grossUpForTax(priced, taxBps), taxBps) > unsold;
}

// --- pool view ------------------------------------------------------------------------------------

/** The launchpad API's phase for a paired pool. `migrating` = target reached, market not open yet. */
export type PairedPhase = "live" | "soon" | "migrating" | "graduated";

/** A pair asset as the API reports it on a pool. */
export interface PairAssetRef {
  mint: string;
  symbol: string;
  decimals: number;
  logo?: string | null;
}

/** i64::MAX in seconds — a paired pool's `end_ts`. Anything this far out means "no deadline". */
const NO_DEADLINE_SECS = 1e15;

/** An ISO time for a pool timestamp, or null when it is "never" (a paired pool's end) or invalid. */
export function poolTimeIso(secs: number): string | null {
  if (!Number.isFinite(secs) || secs <= 0 || secs >= NO_DEADLINE_SECS) return null;
  const d = new Date(secs * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Tax bps → "3%". */
export function taxPct(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** What a paired pool's phase means for a holder, in words (pure). */
export function pairedPhaseNote(
  phase: PairedPhase | null | undefined,
  p: { symbol: string; taxBps: number; pairSymbol: string },
): string {
  const tax =
    `every ${p.symbol} transfer (buys and sells included) withholds a ${taxPct(p.taxBps)} holder tax, ` +
    `paid out daily to holders in ${p.pairSymbol}`;
  switch (phase) {
    case "graduated":
      return `Paired launch, graduated: ${p.symbol} trades on its market — use trade / get_quote. ${cap(tax)}.`;
    case "migrating":
      return (
        `Paired launch, migrating: the curve hit its graduation target and is closed; its market opens ` +
        `once the launchpad seeds it (usually within minutes). Until then nothing can trade it. ${cap(tax)}.`
      );
    default:
      return (
        `Paired launch on its curve: buy with launchpad_buy, sell with launchpad_sell. Holdings are ` +
        `real ${p.symbol} tokens in the wallet (not curve shares), there is no deadline, and it ` +
        `graduates when the raise reaches the target. ${cap(tax)}.`
      );
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
