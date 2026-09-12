export const INFO = Object.freeze({
  kind: "aper-web-access",
  protocolVersion: "1.0",
  buildId: "1.0.0",
  capabilities: { staticFetch: true, browserRun: false, searchRelay: [] },
});

class AcquisitionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}

export function publicTarget(input) {
  if (typeof input !== "string" || input.length > 8192)
    throw new AcquisitionError("invalid_target");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new AcquisitionError("invalid_target");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !host.includes(".") ||
    host.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)
  )
    throw new AcquisitionError("forbidden_target", 403);
  // DNS names use the platform's strictly public egress; IP literals are deliberately unsupported.
  if (/^[\d.]+$/.test(host)) throw new AcquisitionError("forbidden_target", 403);
  url.hash = "";
  return url;
}

async function readBounded(body, limit, signal) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AcquisitionError("response_too_large", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}

async function acquire(input, outbound, signal) {
  let url = publicTarget(input);
  const requestedUrl = url.href;
  const redirects = [];
  for (;;) {
    const response = await outbound(url.href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain",
        "User-Agent": "Aper-Web-Access/1.0",
      },
    });
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
      !/^(text\/(html|plain)|application\/xhtml\+xml)(;|$)/i.test(contentType)
    ) {
      await response.body?.cancel();
      throw new AcquisitionError("unsupported_document", 422);
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

export async function handleRequest(request, env, outbound = fetch) {
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
  const method = url.pathname === "/v1/info" ? "GET" : url.pathname === "/v1/fetch" ? "POST" : null;
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
  if (method === "GET") return json(INFO);
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 15000);
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
    if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("url" in input))
      throw new AcquisitionError("invalid_request");
    return json(await acquire(input.url, outbound, controller.signal));
  } catch (error) {
    if (controller.signal.aborted) return json({ error: "deadline_or_cancelled" }, 504);
    return error instanceof AcquisitionError
      ? json({ error: error.message }, error.status)
      : json({ error: "acquisition_failed" }, 502);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}

export default { fetch: (request, env) => handleRequest(request, env) };
