import { relayRequest, searchServices } from "./search-relay.js";
import { AcquisitionError, publicTarget, readBounded } from "./public-network.js";
import { renderPublicDocument } from "./browser-rendering.js";
import { relayMarkdownNew } from "./markdown-new-relay.js";
export { publicTarget } from "./public-network.js";
export const INFO = Object.freeze({
  kind: "aper-web-access",
  protocolVersion: "1.3",
  buildId: "1.3.0",
  capabilities: {
    staticFetch: true,
    browserRun: false,
    searchRelay: searchServices,
    markdownNewRelay: true,
  },
});

async function acquire(input, outbound, signal, evidence) {
  let url = publicTarget(input);
  const requestedUrl = url.href;
  const redirects = evidence.redirects;
  for (;;) {
    evidence.contacts.push(url.href);
    const target = new URL(url);
    target.hash = "";
    const response = await outbound(target.href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain",
        "User-Agent": "Aper-Web-Access/1.0",
      },
    });
    evidence.upstreamStatus = response.status;
    let headerBytes = 0;
    for (const [key, value] of response.headers)
      headerBytes += new TextEncoder().encode(key + value).length;
    if (headerBytes > 32768) {
      await response.body?.cancel();
      throw new AcquisitionError("headers_too_large", 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects.length >= 5) throw new AcquisitionError("redirect_limit", 502);
      const next = publicTarget(new URL(location, url).href);
      redirects.push({ from: url.href, to: next.href, status: response.status });
      url = next;
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      response.status !== 200 ||
      response.headers.has("content-range") ||
      !/^(text\/(html|plain)|application\/xhtml\+xml)(;|$)/i.test(contentType)
    ) {
      await response.body?.cancel();
      throw new AcquisitionError(
        response.status === 200 || response.status === 206
          ? "unsupported_document"
          : "target_http_error",
        422,
      );
    }
    if (Number(response.headers.get("content-length")) > 2_000_000) {
      await response.body?.cancel();
      throw new AcquisitionError("response_too_large", 413);
    }
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
    const bytes = await readBounded(response.body, 2_000_000, signal);
    let body;
    try {
      body = new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch {
      throw new AcquisitionError("invalid_encoding", 422);
    }
    return {
      requestedUrl,
      finalUrl: url.href,
      status: response.status,
      contentType,
      body,
      byteCount: bytes.byteLength,
      redirects,
    };
  }
}

async function authenticated(header, secret) {
  if (!/^[a-f0-9]{64}$/.test(secret ?? "")) return false;
  const supplied = header ?? "";
  if (supplied.length > 128) return false;
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(supplied), digest(`Bearer ${secret}`)]);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

export async function handleRequest(
  request,
  env,
  outbound = fetch,
  waitUntil = () => {},
  render = renderPublicDocument,
) {
  const headers = {
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  const json = (value, status = 200) => Response.json(value, { status, headers });
  let origin;
  try {
    origin = new URL(env.APER_ALLOWED_ORIGIN);
    if (origin.origin !== env.APER_ALLOWED_ORIGIN || !["https:", "http:"].includes(origin.protocol))
      throw new Error();
  } catch {
    return json({ error: "configuration_invalid" }, 503);
  }
  if (request.headers.get("origin") !== origin.origin)
    return json({ error: "origin_forbidden" }, 403);
  headers["Access-Control-Allow-Origin"] = origin.origin;
  const url = new URL(request.url);
  const service = /^\/v1\/search\/(brave|exa|firecrawl|you)$/.exec(url.pathname)?.[1];
  const method =
    url.pathname === "/v1/info"
      ? "GET"
      : ["/v1/fetch", "/v1/render", "/v1/markdown-new"].includes(url.pathname) || service
        ? "POST"
        : null;
  if (!method || url.search) return json({ error: "route_not_found" }, 404);
  if (request.method === "OPTIONS") {
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      request.headers.get("access-control-request-method") !== method ||
      requestedHeaders.some((value) => !["authorization", "content-type"].includes(value))
    )
      return json({ error: "preflight_forbidden" }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": method,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }
  if (request.method !== method) return json({ error: "method_not_allowed" }, 405);
  if (!/^[a-f0-9]{64}$/.test(env.APER_RUNTIME_SECRET ?? ""))
    return json({ error: "configuration_invalid" }, 503);
  if (!(await authenticated(request.headers.get("authorization"), env.APER_RUNTIME_SECRET)))
    return json({ error: "unauthorized" }, 401);
  if (method === "GET")
    return json({ ...INFO, capabilities: { ...INFO.capabilities, browserRun: !!env.BROWSER } });
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 15000);
  const evidence = { contacts: [], redirects: [] };
  try {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
      throw new AcquisitionError("invalid_request");
    const bytes = await readBounded(request.body, 10000, controller.signal);
    let input;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new AcquisitionError("invalid_request");
    }
    if (service) {
      let relay;
      try {
        relay = relayRequest(service, input);
      } catch {
        throw new AcquisitionError("invalid_search_request");
      }
      if (input.credential === env.APER_RUNTIME_SECRET)
        throw new AcquisitionError("invalid_search_credential");
      evidence.contacts.push(relay.endpoint);
      const response = await outbound(relay.endpoint, { ...relay.init, signal: controller.signal });
      let headerBytes = 0;
      for (const [key, value] of response.headers)
        headerBytes += new TextEncoder().encode(key + value).length;
      if (headerBytes > 32768 || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        throw new AcquisitionError(
          headerBytes > 32768 ? "headers_too_large" : "search_redirect_forbidden",
          502,
        );
      }
      const quota = {};
      for (const name of [
        "retry-after",
        "x-ratelimit-remaining",
        "x-ratelimit-limit",
        "x-ratelimit-reset",
      ]) {
        const value = response.headers.get(name);
        if (
          value &&
          value.length <= 100 &&
          /^[A-Za-z0-9, .:+-]+$/.test(value) &&
          !value.includes(input.credential) &&
          !value.includes(env.APER_RUNTIME_SECRET)
        )
          quota[name] = value;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return json({ status: response.status, body: null, quota, ...evidence });
      }
      if (!response.headers.get("content-type")?.startsWith("application/json")) {
        await response.body?.cancel();
        throw new AcquisitionError("invalid_search_response", 502);
      }
      const bytes = await readBounded(response.body, 2_000_000, controller.signal);
      let body;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new AcquisitionError("invalid_search_response", 502);
      }
      return json({
        status: response.status,
        body,
        quota,
        byteCount: bytes.byteLength,
        ...evidence,
      });
    }
    if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("url" in input))
      throw new AcquisitionError("invalid_request");
    if (url.pathname === "/v1/markdown-new")
      return json(await relayMarkdownNew(input.url, outbound, controller.signal, evidence));
    if (url.pathname === "/v1/render")
      return json(
        await render(input.url, env.BROWSER, outbound, controller.signal, evidence, waitUntil),
      );
    return json(await acquire(input.url, outbound, controller.signal, evidence));
  } catch (error) {
    if (controller.signal.aborted)
      return json({ error: "deadline_or_cancelled", ...evidence }, 504);
    return error instanceof AcquisitionError
      ? json({ error: error.message, ...evidence }, error.status)
      : json({ error: "acquisition_failed", ...evidence }, 502);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}

export default {
  fetch: (request, env, context) =>
    handleRequest(request, env, fetch, (task) => context.waitUntil(task)),
};
