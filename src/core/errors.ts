// Every tool failure returns { error, hint } — never a stack trace, never a secret.

export type ToolError = {
  error: string;
  hint?: string;
};

export class CookieMcpError extends Error {
  readonly hint?: string;
  constructor(error: string, hint?: string) {
    super(error);
    this.name = "CookieMcpError";
    this.hint = hint;
  }
}

// Strip anything shaped like a private key: keygen JSON byte arrays and long (>=80 char) base58 runs
// (full secret keys). Pubkeys/signatures are shorter and left intact.
export function redact(text: string): string {
  return text
    .replace(/\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g, "[REDACTED_KEYPAIR]")
    .replace(/[1-9A-HJ-NP-Za-km-z]{80,}/g, "[REDACTED]");
}

export function toToolError(e: unknown): ToolError {
  if (e instanceof CookieMcpError) {
    return { error: redact(e.message), ...(e.hint ? { hint: redact(e.hint) } : {}) };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { error: redact(msg) };
}
