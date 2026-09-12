import { describe, expect, it, vi } from "vite-plus/test";
import { handleRequest } from "./worker.js";
import { renderPublicDocument } from "./browser-rendering.js";
import { AcquisitionError } from "./public-network.js";
const env = {
  APER_ALLOWED_ORIGIN: "https://aper.run",
  APER_RUNTIME_SECRET: "a".repeat(64),
  BROWSER: {},
};
const request = (path, body) =>
  new Request("https://worker.example.org" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: env.APER_ALLOWED_ORIGIN,
      Authorization: "Bearer " + env.APER_RUNTIME_SECRET,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
describe("optional rendering on the Web Access Worker", () => {
  it.each(["rendering_quota", "rendering_unavailable", "rendering_failed"])(
    "preserves static and relay capability after %s",
    async (code) => {
      const render = vi.fn(async () => {
        throw new AcquisitionError(code, 503);
      });
      const outbound = vi.fn(
        async () => new Response("Complete text", { headers: { "Content-Type": "text/plain" } }),
      );
      const rendering = await handleRequest(
        request("/v1/render", { url: "https://example.com/" }),
        env,
        outbound,
        () => {},
        render,
      );
      expect(rendering.status).toBe(503);
      expect(await rendering.json()).toMatchObject({ error: code });
      const info = await (await handleRequest(request("/v1/info"), env)).json();
      expect(info.capabilities).toMatchObject({
        staticFetch: true,
        browserRun: true,
        searchRelay: ["brave", "exa", "firecrawl", "you"],
      });
      expect(
        (await handleRequest(request("/v1/fetch", { url: "https://example.com/" }), env, outbound))
          .status,
      ).toBe(200);
    },
  );
  it("rejects arbitrary browser commands and forbidden targets before launch", async () => {
    const render = vi.fn();
    expect(
      (
        await handleRequest(
          request("/v1/render", { url: "https://example.com", script: "execute()" }),
          env,
          fetch,
          () => {},
          render,
        )
      ).status,
    ).toBe(400);
    expect(render).not.toHaveBeenCalled();
    const launch = vi.fn();
    await expect(
      renderPublicDocument(
        "http://127.0.0.1/",
        {},
        fetch,
        new AbortController().signal,
        { contacts: [], redirects: [] },
        () => {},
        launch,
      ),
    ).rejects.toThrow("forbidden_target");
    expect(launch).not.toHaveBeenCalled();
  });
  it("does not launch when cancelled and closes a late-acquired browser", async () => {
    const launch = vi.fn();
    await expect(
      renderPublicDocument(
        "https://example.com/",
        {},
        fetch,
        AbortSignal.abort(),
        { contacts: [], redirects: [] },
        () => {},
        launch,
      ),
    ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
    const controller = new AbortController();
    let release;
    const close = vi.fn(async () => {});
    const pendingLaunch = new Promise((resolve) => {
      release = resolve;
    });
    const tasks = [];
    const task = renderPublicDocument(
      "https://example.com/",
      {},
      fetch,
      controller.signal,
      { contacts: [], redirects: [] },
      (task) => tasks.push(task),
      () => pendingLaunch,
    );
    controller.abort();
    await expect(task).rejects.toThrow("deadline_or_cancelled");
    release({ close });
    await Promise.all(tasks);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("uses only the browser binding for quota and eligibility checks", async () => {
    for (const status of [403, 429, 503]) {
      const binding = { fetch: vi.fn(async () => new Response("must never escape", { status })) };
      await expect(
        renderPublicDocument("https://example.com/", binding, fetch, new AbortController().signal, {
          contacts: [],
          redirects: [],
        }),
      ).rejects.toThrow(
        status === 429
          ? "rendering_quota"
          : status === 403
            ? "rendering_unavailable"
            : "rendering_failed",
      );
      expect(binding.fetch).toHaveBeenCalledTimes(1);
      const [, init] = binding.fetch.mock.calls[0];
      expect(init.headers).toBeUndefined();
    }
  });
});
