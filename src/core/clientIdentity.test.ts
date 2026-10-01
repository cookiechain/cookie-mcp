import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetClientTransport,
  CLIENT_HEADER,
  clientHeaders,
  clientIdentity,
  formatUserAgent,
  MAX_APP_ID_LENGTH,
  sanitizeAppId,
  setClientTransport,
} from "./clientIdentity";
import { runWithRequestContext } from "./context";
import { fetchJson } from "./http";
import { VERSION } from "../version";

afterEach(() => {
  _resetClientTransport();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sanitizeAppId", () => {
  it("accepts a plain token and trims it", () => {
    expect(sanitizeAppId("  cookie-chat/2.1 ")).toBe("cookie-chat/2.1");
    expect(sanitizeAppId("app@vendor.com:prod")).toBe("app@vendor.com:prod");
  });
  it("drops empty, oversized, and header-unsafe values", () => {
    expect(sanitizeAppId(undefined)).toBeUndefined();
    expect(sanitizeAppId("   ")).toBeUndefined();
    expect(sanitizeAppId("a".repeat(MAX_APP_ID_LENGTH + 1))).toBeUndefined();
    expect(sanitizeAppId("has space")).toBeUndefined();
    expect(sanitizeAppId("semi;colon")).toBeUndefined();
    expect(sanitizeAppId("(paren)")).toBeUndefined();
    expect(sanitizeAppId("line\nbreak")).toBeUndefined();
    expect(sanitizeAppId("-leading-dash")).toBeUndefined();
  });
});

describe("formatUserAgent", () => {
  it("is cookie-mcp/<version> (<transport>; <signer>[; app=<id>])", () => {
    expect(formatUserAgent({ version: "1.2.3", transport: "stdio", signer: "local" })).toBe(
      "cookie-mcp/1.2.3 (stdio; local)",
    );
    expect(
      formatUserAgent({ version: "1.2.3", transport: "http", signer: "external", app: "x/1" }),
    ).toBe("cookie-mcp/1.2.3 (http; external; app=x/1)");
  });
});

describe("clientIdentity", () => {
  it("reports the package version and 'library' until a transport is chosen", () => {
    const id = clientIdentity();
    expect(id.version).toBe(VERSION);
    expect(id.transport).toBe("library");
    expect(id.userAgent).toBe(`cookie-mcp/${VERSION} (library; ${id.signer})`);
    setClientTransport("stdio");
    expect(clientIdentity().transport).toBe("stdio");
  });

  it("names the app from the request context, which beats the process-wide id", async () => {
    expect(clientIdentity().app).toBeUndefined();
    await runWithRequestContext({ app: "per-request" }, async () => {
      expect(clientIdentity().app).toBe("per-request");
      expect(clientIdentity().userAgent).toMatch(/; app=per-request\)$/);
    });
    await runWithRequestContext({ app: "not a token" }, async () => {
      expect(clientIdentity().app).toBeUndefined();
    });
  });
});

describe("clientHeaders", () => {
  it("sets User-Agent and X-Cookie-Client to the same identity", () => {
    const h = clientHeaders();
    expect(h["User-Agent"]).toBe(clientIdentity().userAgent);
    expect(h[CLIENT_HEADER]).toBe(h["User-Agent"]);
  });

  it("omits the custom header in a browser, where it would force a CORS preflight", () => {
    vi.stubGlobal("document", {});
    const h = clientHeaders();
    expect(h["User-Agent"]).toBeDefined();
    expect(h[CLIENT_HEADER]).toBeUndefined();
  });
});

describe("fetchJson", () => {
  it("sends the identity headers on every request, under the caller's own headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    setClientTransport("http");

    await fetchJson("https://venue.example/api", { headers: { "x-custom": "1" } });
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(`cookie-mcp/${VERSION} (http; ${clientIdentity().signer})`);
    expect(headers[CLIENT_HEADER]).toBe(headers["User-Agent"]);
    expect(headers["x-custom"]).toBe("1");
  });
});
