// Pure amount/number formatting. Raw↔UI conversion uses BigInt so large amounts keep full precision.

export function rawToUi(raw: string | bigint, decimals: number): string {
  const n = typeof raw === "bigint" ? raw : BigInt(raw);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}

// A `number` is normalized via toFixed(decimals) first: JS renders tiny numbers in scientific
// notation (0.000000001 → "1e-9"), which the fixed-point parse below can't read. Pass a string for
// exact large amounts.
export function uiToRaw(ui: string | number, decimals: number): bigint {
  const s = typeof ui === "number" ? ui.toFixed(decimals) : ui.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") {
    throw new Error(`invalid amount: "${ui}"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places: "${ui}"`);
  }
  const fracPadded = frac.padEnd(decimals, "0");
  return BigInt((whole || "0") + fracPadded);
}

export function fmtUsd(n: number | string | null | undefined): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(4)}`;
}

export function shortAddr(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 5)}…${addr.slice(-5)}`;
}

export function bpsToPct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}
