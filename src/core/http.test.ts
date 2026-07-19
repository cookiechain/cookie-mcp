import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchJson } from "./http";

function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchJson retry policy", () => {
  it("retries an idempotent GET once on 503, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(503, { error: "busy" }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson("https://x/api")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a POST (non-idempotent) on 503", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(503, { error: "busy" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson("https://x/api", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 4xx immediately without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(404, { error: "not found" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson("https://x/api")).rejects.toThrow(/not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network error on a GET then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson("https://x/api")).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
