import { describe, expect, it, vi } from "vite-plus/test";
import { handleRequest } from "./worker.js";

const env = { APER_ALLOWED_ORIGIN: "https://aper.run", APER_RUNTIME_SECRET: "a".repeat(64) };
const request = (input = { url: "https://example.com/" }, init = {}) =>
  new Request("https://worker.example.org/v1/markdown-new", {
    method: "POST",
    body: JSON.stringify(input),
    ...init,
    headers: {
      Origin: env.APER_ALLOWED_ORIGIN,
      Authorization: `Bearer ${env.APER_RUNTIME_SECRET}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
const external = () =>
  Response.json({ success: true, url: "https://example.com/", content: "Article" });

describe("fixed markdown.new relay", () => {
  it("relays one conversion without Browser Run or forwarded credentials", async () => {
    const render = vi.fn(() => {
      throw new Error("Browser quota exhausted");
    });
    const bindingFetch = vi.fn(() => {
      throw new Error("Browser quota exhausted");
    });
    const outbound = vi.fn(async () => external());
    const response = await handleRequest(
      request(undefined, { headers: { Cookie: "private-session", "X-Forwarded-For": "private" } }),
      { ...env, BROWSER: { fetch: bindingFetch } },
      outbound,
      () => {},
      render,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 200,
      contentType: "application/json",
      contacts: ["https://markdown.new/"],
      body: await external().text(),
    });
    expect(outbound).toHaveBeenCalledExactlyOnceWith("https://markdown.new/", {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: "https://example.com/", method: "auto", retain_images: false }),
    });
    expect(render).not.toHaveBeenCalled();
    expect(bindingFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(outbound.mock.calls)).not.toMatch(/private|a{64}/);
  });
  it("requires runtime authentication and exact-origin CORS before service contact", async () => {
    const outbound = vi.fn();
    for (const headers of [{ Authorization: "" }, { Origin: "https://other.org" }]) {
      expect((await handleRequest(request(undefined, { headers }), env, outbound)).ok).toBe(false);
    }
    const preflight = await handleRequest(
      request(undefined, {
        method: "OPTIONS",
        body: undefined,
        headers: {
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
      env,
      outbound,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(env.APER_ALLOWED_ORIGIN);
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each([
    { url: "http://127.0.0.1/" },
    { url: "https://user:secret@example.com/" },
    { url: "file:///private" },
    { url: "https://example.com/", endpoint: "https://other.org" },
    { url: "https://example.com/", method: "browser" },
    { url: "https://example.com/", headers: { Authorization: "private" } },
  ])("rejects forbidden targets and arbitrary relay controls: %j", async (input) => {
    const outbound = vi.fn();
    expect((await handleRequest(request(input), env, outbound)).ok).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each([
    [() => new Response("private upstream error", { status: 429 }), "markdown_new_quota"],
    [() => new Response("private upstream error", { status: 500 }), "markdown_new_http_error"],
    [
      () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }),
      "markdown_new_redirect_forbidden",
    ],
    [() => new Response("partial", { status: 206 }), "truncated_content"],
    [
      () => new Response("partial", { headers: { "Content-Range": "bytes 0-6/100" } }),
      "truncated_content",
    ],
    [() => new Response("partial", { headers: { "X-Truncated": "true" } }), "truncated_content"],
    [
      () => new Response("html", { headers: { "Content-Type": "text/html" } }),
      "markdown_new_invalid_response",
    ],
    [
      () =>
        new Response(new Uint8Array([255]), { headers: { "Content-Type": "application/json" } }),
      "invalid_encoding",
    ],
    [
      () =>
        new Response("x".repeat(1_000_001), { headers: { "Content-Type": "application/json" } }),
      "response_too_large",
    ],
    [
      () =>
        new Response("{}", {
          headers: { "Content-Type": "application/json", "X-Large": "x".repeat(33000) },
        }),
      "headers_too_large",
    ],
  ])(
    "fails unsafe or unusable upstream responses without retries (%s)",
    async (makeResponse, code) => {
      const outbound = vi.fn(async () => makeResponse());
      const response = await handleRequest(request(), env, outbound);
      const result = await response.json();
      expect(result).toMatchObject({ error: code, contacts: ["https://markdown.new/"] });
      expect(JSON.stringify(result)).not.toContain("private upstream error");
      expect(outbound).toHaveBeenCalledTimes(1);
    },
  );
  it("cancels pending response reads and rejects cancellation before dispatch", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const outbound = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const pending = handleRequest(request(undefined, { signal: controller.signal }), env, outbound);
    await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await (await pending).json()).toMatchObject({ error: "deadline_or_cancelled" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    outbound.mockClear();
    await handleRequest(request(undefined, { signal: controller.signal }), env, outbound);
    expect(outbound).not.toHaveBeenCalled();
  });
});
