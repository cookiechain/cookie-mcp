// JSON fetch with a timeout and one retry — but only for idempotent requests (GET / no body).
// POST calls (swap-tx, submit-tx) are never retried: a retry could double-submit. 4xx is never
// retried (won't self-heal); timeouts, network errors, and 429/5xx are transient.
import { HTTP_TIMEOUT_MS } from "./config";
import { CookieMcpError } from "./errors";

class TransientError extends Error {}

function isIdempotent(init?: RequestInit): boolean {
  const m = init?.method?.toUpperCase();
  return !m || m === "GET";
}

async function attempt<T>(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new CookieMcpError(
        `${url} returned non-JSON (${res.status})`,
        "the upstream service may be down or rate-limiting; retry shortly",
      );
    }
    if (!res.ok) {
      const msg = (data as { error?: string })?.error ?? `request failed (HTTP ${res.status})`;
      if (res.status === 429 || res.status >= 500) throw new TransientError(msg);
      throw new CookieMcpError(msg, "check the inputs; if it persists the service may be degraded");
    }
    return data as T;
  } catch (e) {
    if (e instanceof CookieMcpError || e instanceof TransientError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new TransientError(`request to ${url} timed out`);
    }
    throw new TransientError(`network error calling ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const maxAttempts = isIdempotent(init) ? 2 : 1;
  let lastTransient: TransientError | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt<T>(url, init);
    } catch (e) {
      if (e instanceof CookieMcpError) throw e;
      if (e instanceof TransientError) {
        lastTransient = e;
        if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
  throw new CookieMcpError(
    lastTransient?.message ?? `request to ${url} failed`,
    "check connectivity to Cookie Chain services and retry",
  );
}
