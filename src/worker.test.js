import { describe, expect, it, vi } from "vite-plus/test";
import worker, { handleRequest, INFO, publicTarget } from "./worker.js";

const env = { APER_ALLOWED_ORIGIN: "https://aper.run", APER_RUNTIME_SECRET: "a".repeat(64) };
const request = (path, init = {}) =>
  new Request(`https://worker.example${path}`, {
    ...init,
    headers: {
      Origin: env.APER_ALLOWED_ORIGIN,
      Authorization: `Bearer ${env.APER_RUNTIME_SECRET}`,
      ...init.headers,
    },
  });
const fetchRequest = (url, extra = {}) =>
  request("/v1/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...extra }),
  });
const bytesRequest = (url, extra = {}) =>
  request("/v1/bytes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...extra }),
  });

describe("Web Access production template", () => {
  it("requires exact origin and independent runtime authentication on its versioned routes", async () => {
    expect(await (await worker.fetch(request("/v1/info"), env, {})).json()).toEqual(INFO);
    for (const headers of [
      { Origin: "https://evil.org" },
      { Origin: "null" },
      { Authorization: "" },
      { Authorization: `Bearer ${"b".repeat(64)}` },
    ]) {
      const response = await handleRequest(request("/v1/info", { headers }), env);
      expect([401, 403]).toContain(response.status);
      expect(JSON.stringify(await response.json())).not.toContain(env.APER_RUNTIME_SECRET);
    }
    expect(
      (await handleRequest(request("/v1/info"), { ...env, APER_RUNTIME_SECRET: "placeholder" }))
        .status,
    ).toBe(503);
    expect((await handleRequest(request("/mcp"), env)).status).toBe(404);
  });
  it("accepts only route-specific preflight methods and headers", async () => {
    const response = await handleRequest(
      request("/v1/fetch", {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(env.APER_ALLOWED_ORIGIN);
    expect(
      (
        await handleRequest(
          request("/v1/fetch", {
            method: "OPTIONS",
            headers: { "Access-Control-Request-Method": "DELETE" },
          }),
          env,
        )
      ).status,
    ).toBe(403);
  });
  it.each([
    "http://127.0.0.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://10.0.0.1",
    "http://169.254.169.254",
    "http://[::1]",
    "https://machine.local",
    "https://localhost.",
    "file:///x",
    "https://user:pass@example.com",
    "https://example.com:444",
  ])("rejects restricted target %s", (url) => {
    expect(() => publicTarget(url)).toThrow();
  });
  it("constructs GET requests without ambient credentials and revalidates every redirect", async () => {
    const outbound = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "/document" } }),
      )
      .mockResolvedValueOnce(
        new Response("<h1>Document</h1>", { headers: { "Content-Type": "text/html" } }),
      );
    const response = await handleRequest(fetchRequest("https://example.com"), env, outbound);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      finalUrl: "https://example.com/document",
      body: "<h1>Document</h1>",
      redirects: [{ status: 302 }],
    });
    expect(outbound.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
    });
    expect(JSON.stringify(outbound.mock.calls)).not.toContain(env.APER_RUNTIME_SECRET);
    const unsafe = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest" } }),
      );
    expect((await handleRequest(fetchRequest("https://example.com"), env, unsafe)).status).toBe(
      403,
    );
    expect(unsafe).toHaveBeenCalledTimes(1);
  });
  it("relays complete bounded bytes with validated metadata and no target credentials", async () => {
    const payload = new Uint8Array([0, 255, 17, 42]);
    const outbound = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "/asset.bin" } }),
      )
      .mockResolvedValueOnce(
        new Response(payload, {
          headers: { "Content-Type": "application/octet-stream", "Content-Length": "4" },
        }),
      );
    const response = await handleRequest(bytesRequest("https://example.com/start"), env, outbound);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    expect(response.headers.get("aper-final-url")).toBe("https://example.com/asset.bin");
    expect(response.headers.get("aper-byte-count")).toBe("4");
    expect(response.headers.get("aper-media-type")).toBe("application/octet-stream");
    expect(response.headers.get("aper-redirect-count")).toBe("1");
    expect(outbound.mock.calls[1][1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "identity",
        "User-Agent": "Aper-Web-Access/1.0",
      },
    });
    expect(JSON.stringify(outbound.mock.calls)).not.toContain(env.APER_RUNTIME_SECRET);
  });
  it("rejects byte truncation, encoded bodies, unsafe redirects, and model controls", async () => {
    for (const response of [
      new Response(new Uint8Array([1, 2]), { headers: { "Content-Length": "3" } }),
      new Response(new Uint8Array([1, 2]), { headers: { "Content-Encoding": "gzip" } }),
      new Response(new Uint8Array([1, 2]), { status: 206 }),
    ]) {
      const result = await handleRequest(
        bytesRequest("https://example.com/asset"),
        env,
        async () => response,
      );
      expect(result.ok).toBe(false);
    }
    const unsafe = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest" },
        }),
    );
    expect(
      (await handleRequest(bytesRequest("https://example.com/asset"), env, unsafe)).status,
    ).toBe(403);
    expect(unsafe).toHaveBeenCalledTimes(1);
    const controlled = vi.fn();
    expect(
      (
        await handleRequest(
          bytesRequest("https://example.com/asset", { headers: { Cookie: "private" } }),
          env,
          controlled,
        )
      ).status,
    ).toBe(400);
    expect(controlled).not.toHaveBeenCalled();
  });
  it("rejects arbitrary controls, binary documents, oversized bodies and sanitized upstream errors", async () => {
    const outbound = vi.fn();
    expect(
      (
        await handleRequest(
          fetchRequest("https://example.com", { headers: { Cookie: "secret" } }),
          env,
          outbound,
        )
      ).status,
    ).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
    for (const response of [
      new Response("binary", { headers: { "Content-Type": "application/pdf" } }),
      new Response("x".repeat(2_000_001), { headers: { "Content-Type": "text/plain" } }),
    ]) {
      expect(
        (await handleRequest(fetchRequest("https://example.com"), env, async () => response)).ok,
      ).toBe(false);
    }
    const failure = await handleRequest(fetchRequest("https://example.com"), env, () => {
      throw new Error(env.APER_RUNTIME_SECRET);
    });
    expect(await failure.json()).toEqual({
      error: "acquisition_failed",
      contacts: ["https://example.com/"],
      redirects: [],
    });
  });
  it("caps redirects and rejects partial responses, invalid encoding and large headers", async () => {
    const loop = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { Location: "https://example.com/again" } }),
      ),
    );
    expect((await handleRequest(fetchRequest("https://example.com"), env, loop)).status).toBe(502);
    expect(loop).toHaveBeenCalledTimes(6);
    for (const response of [
      new Response("partial", { status: 206, headers: { "Content-Type": "text/plain" } }),
      new Response(new Uint8Array([255]), { headers: { "Content-Type": "text/plain" } }),
      new Response("x", {
        headers: { "Content-Type": "text/plain", "X-Large": "x".repeat(33000) },
      }),
    ])
      expect(
        (await handleRequest(fetchRequest("https://example.com"), env, async () => response)).ok,
      ).toBe(false);
  });
});
