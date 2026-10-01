import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./createServer";
import { checkRequest, handleHttpRequest, resolveHttpSecurity, type HttpSecurity } from "./http";

describe("resolveHttpSecurity", () => {
  it("pins a loopback bind to loopback names on its own port", () => {
    const sec = resolveHttpSecurity({ host: "127.0.0.1", port: 3000 }, {});
    expect([...sec.allowedHosts!].sort()).toEqual([
      "127.0.0.1:3000",
      "[::1]:3000",
      "localhost:3000",
    ]);
    expect(sec.token).toBeNull();
  });

  it("defaults to any browser origin without a key, and to none with a local key", () => {
    const bind = { host: "127.0.0.1", port: 3000 };
    expect(resolveHttpSecurity(bind, {}).allowedOrigins).toBe("*");
    expect(
      resolveHttpSecurity(bind, { COOKIE_SIGNER: "external", COOKIE_PRIVATE_KEY: "k" })
        .allowedOrigins,
    ).toBe("*");
    expect(resolveHttpSecurity(bind, { COOKIE_PRIVATE_KEY: "k" }).allowedOrigins).toEqual(
      new Set(),
    );
    expect(
      resolveHttpSecurity(bind, {
        COOKIE_PRIVATE_KEY: "k",
        COOKIE_MCP_CORS_ORIGIN: "https://a.example",
      }).allowedOrigins,
    ).toEqual(new Set(["https://a.example"]));
  });

  it("leaves a public bind unpinned unless COOKIE_MCP_ALLOWED_HOSTS says otherwise", () => {
    expect(resolveHttpSecurity({ host: "0.0.0.0", port: 3000 }, {}).allowedHosts).toBeNull();
    const sec = resolveHttpSecurity(
      { host: "0.0.0.0", port: 3000 },
      { COOKIE_MCP_ALLOWED_HOSTS: "MCP.example.com, mcp.example.com:8443" },
    );
    expect(sec.allowedHosts).toEqual(new Set(["mcp.example.com", "mcp.example.com:8443"]));
  });

  it("reads the origin list, an explicit '*', and the token", () => {
    const sec = resolveHttpSecurity(
      { host: "127.0.0.1", port: 1 },
      {
        COOKIE_MCP_CORS_ORIGIN: "https://app.example/, https://b.example",
        COOKIE_MCP_HTTP_TOKEN: " t ",
      },
    );
    expect(sec.allowedOrigins).toEqual(new Set(["https://app.example", "https://b.example"]));
    expect(sec.token).toBe("t");
    expect(
      resolveHttpSecurity({ host: "127.0.0.1", port: 1 }, { COOKIE_MCP_CORS_ORIGIN: "*" })
        .allowedOrigins,
    ).toBe("*");
  });
});

describe("checkRequest", () => {
  // With a local key, so no browser origin is allowed by default.
  const loopback = resolveHttpSecurity(
    { host: "127.0.0.1", port: 38123 },
    { COOKIE_PRIVATE_KEY: "k" },
  );

  it("lets a non-browser client on a loopback name through", () => {
    expect(checkRequest(loopback, { host: "127.0.0.1:38123" })).toBeNull();
    expect(checkRequest(loopback, { host: "localhost:38123" })).toBeNull();
  });

  it("refuses a rebinding Host, a missing Host and a wrong port", () => {
    expect(checkRequest(loopback, { host: "attacker.example:38123" })?.status).toBe(403);
    expect(checkRequest(loopback, {})?.status).toBe(403);
    expect(checkRequest(loopback, { host: "127.0.0.1" })?.status).toBe(403);
    expect(checkRequest(loopback, { host: "127.0.0.1:80" })?.status).toBe(403);
  });

  it("refuses any browser origin unless it is listed", () => {
    expect(
      checkRequest(loopback, { host: "127.0.0.1:38123", origin: "https://evil.example" })?.status,
    ).toBe(403);
    const pinned: HttpSecurity = { ...loopback, allowedOrigins: new Set(["https://app.example"]) };
    expect(
      checkRequest(pinned, { host: "127.0.0.1:38123", origin: "https://app.example" }),
    ).toBeNull();
    expect(
      checkRequest(pinned, { host: "127.0.0.1:38123", origin: "https://evil.example" })?.status,
    ).toBe(403);
  });

  it("requires the bearer token, but not on a preflight", () => {
    const sec: HttpSecurity = { ...loopback, token: "s3cret" };
    const host = "127.0.0.1:38123";
    expect(checkRequest(sec, { host })?.status).toBe(401);
    expect(checkRequest(sec, { host, authorization: "Bearer nope" })?.status).toBe(401);
    expect(checkRequest(sec, { host, authorization: "Bearer s3cret" })).toBeNull();
    expect(checkRequest(sec, { host }, { skipToken: true })).toBeNull();
  });

  it("matches a configured host with or without its port", () => {
    const sec = resolveHttpSecurity(
      { host: "0.0.0.0", port: 3000 },
      { COOKIE_MCP_ALLOWED_HOSTS: "mcp.example.com" },
    );
    expect(checkRequest(sec, { host: "mcp.example.com" })).toBeNull();
    expect(checkRequest(sec, { host: "mcp.example.com:443" })).toBeNull();
    expect(checkRequest(sec, { host: "evil.example" })?.status).toBe(403);
  });
});

// The audit's reproduction, end to end over a real socket.
describe("handleHttpRequest", () => {
  let server: http.Server;
  let port: number;
  let sec: HttpSecurity;
  let serversCreated = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const counted = () => {
        serversCreated++;
        return createServer();
      };
      void handleHttpRequest(counted, req, res, "/mcp", sec);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    sec = resolveHttpSecurity(
      { host: "127.0.0.1", port },
      { COOKIE_PRIVATE_KEY: "k", COOKIE_MCP_HTTP_TOKEN: "s3cret" },
    );
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  function post(headers: Record<string, string>) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  }

  it("sends no CORS allow-origin to a foreign page's preflight", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a foreign origin even with the token", async () => {
    const res = await post({ origin: "https://evil.example", authorization: "Bearer s3cret" });
    expect(res.status).toBe(403);
  });

  it("refuses a call without the token", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("serves a tokened non-browser client", async () => {
    const res = await post({ authorization: "Bearer s3cret" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: unknown[] } };
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });

  it("scopes an x-cookie-app header to that request's venue identity", async () => {
    const call = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer s3cret",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_wallet", arguments: {} },
        }),
      });
    const client = async (headers: Record<string, string>) => {
      const res = await call(headers);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { content: { text: string }[] } };
      return (JSON.parse(body.result.content[0]!.text) as { client: string }).client;
    };
    expect(await client({ "x-cookie-app": "cookie-chat/2.1" })).toMatch(
      /; app=cookie-chat\/2.1\)$/,
    );
    expect(await client({})).not.toMatch(/app=/);
    expect(await client({ "x-cookie-app": "not a token" })).not.toMatch(/app=/);
  });

  it("refuses a rebinding Host before any MCP server is created", async () => {
    const before = serversCreated;
    // `fetch` drops a caller-set Host (a forbidden header), so forge it with a raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: `attacker.example:${port}`,
            authorization: "Bearer s3cret",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    });
    expect(status).toBe(403);
    expect(serversCreated).toBe(before);
  });

  it("without a key, answers a browser page with allow-origin * on the wire", async () => {
    const withKey = sec;
    sec = resolveHttpSecurity({ host: "127.0.0.1", port }, {});
    try {
      const res = await post({ origin: "https://app.example" });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      // A browser-side wallet integrator gets its preflight through too.
      const pre = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "https://app.example", "access-control-request-method": "POST" },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      sec = withKey;
    }
  });
});
