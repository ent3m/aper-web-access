import { describe, expect, it, vi } from "vite-plus/test";
import { handleRequest } from "./worker.js";
import { relayRequest } from "./search-relay.js";

const env = { APER_ALLOWED_ORIGIN: "https://aper.run", APER_RUNTIME_SECRET: "a".repeat(64) };
const bodies = {
  brave: {
    q: "hello",
    count: 3,
    maximum_number_of_urls: 3,
    safesearch: "moderate",
    spellcheck: false,
    enable_local: false,
  },
  exa: {
    query: "hello",
    numResults: 3,
    type: "auto",
    contents: { highlights: true },
    moderation: true,
  },
  firecrawl: { query: "hello", limit: 3, sources: ["web"] },
  you: { query: "hello", count: 3, safesearch: "off" },
};
const request = (service, input, headers = {}) =>
  new Request(`https://worker.example.org/v1/search/${service}`, {
    method: "POST",
    headers: {
      Origin: env.APER_ALLOWED_ORIGIN,
      Authorization: `Bearer ${env.APER_RUNTIME_SECRET}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(input),
  });
describe("allowlisted search relay", () => {
  it.each(Object.keys(bodies))(
    "constructs only the %s profile with distinct credentials",
    async (service) => {
      const outbound = vi.fn(async () =>
        Response.json(
          { results: [] },
          { headers: { "X-Ratelimit-Remaining": "8", "Set-Cookie": "secret" } },
        ),
      );
      const input = { body: bodies[service], credential: "provider-key" };
      const result = await handleRequest(request(service, input), env, outbound);
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        status: 200,
        body: { results: [] },
        quota: { "x-ratelimit-remaining": "8" },
        redirects: [],
      });
      const [url, init] = outbound.mock.calls[0];
      expect(url).toBe(relayRequest(service, input).endpoint);
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      expect(JSON.stringify(init)).not.toContain(env.APER_RUNTIME_SECRET);
      expect(JSON.stringify(init)).toContain("provider-key");
      expect(init.headers.Cookie).toBeUndefined();
    },
  );
  it("rejects arbitrary routes, controls, credentials and native provider features before contact", async () => {
    const outbound = vi.fn();
    for (const input of [
      { body: bodies.exa, credential: "provider-key", url: "https://evil.org" },
      { body: { ...bodies.exa, contents: { text: true } }, credential: "provider-key" },
      { body: { ...bodies.exa, url: "https://evil.org" }, credential: "provider-key" },
      { body: { ...bodies.exa, type: "deep" }, credential: "provider-key" },
      { body: bodies.exa, credential: "key\r\nAuthorization: evil" },
      { body: bodies.exa, credential: env.APER_RUNTIME_SECRET },
      { body: bodies.exa, credential: "provider-key", headers: { Cookie: "private" } },
    ])
      expect((await handleRequest(request("exa", input), env, outbound)).status).toBe(400);
    expect((await handleRequest(request("unknown", {}), env, outbound)).status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });
  it("enforces runtime authentication and origin on search independently", async () => {
    const outbound = vi.fn();
    for (const headers of [
      { Origin: "https://evil.org" },
      { Authorization: "Bearer provider-key" },
      { Authorization: "" },
    ]) {
      expect([401, 403]).toContain(
        (
          await handleRequest(
            request("exa", { body: bodies.exa, credential: "provider-key" }, headers),
            env,
            outbound,
          )
        ).status,
      );
    }
    expect(outbound).not.toHaveBeenCalled();
  });
  it("rejects redirects and oversized responses; preserves quota without rejection bodies", async () => {
    const input = { body: bodies.exa, credential: "provider-key" };
    const redirect = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "https://evil.org" } }),
    );
    expect(await (await handleRequest(request("exa", input), env, redirect)).json()).toMatchObject({
      error: "search_redirect_forbidden",
    });
    expect(redirect).toHaveBeenCalledTimes(1);
    const quota = await handleRequest(
      request("exa", input),
      env,
      async () => new Response("provider-key", { status: 429, headers: { "Retry-After": "10" } }),
    );
    expect(await quota.json()).toMatchObject({
      status: 429,
      body: null,
      quota: { "retry-after": "10" },
    });
    const large = await handleRequest(request("exa", input), env, async () =>
      Response.json({ data: "x".repeat(2_000_000) }),
    );
    expect(large.status).toBe(413);
  });
});
