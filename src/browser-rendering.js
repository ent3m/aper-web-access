import { AcquisitionError, publicTarget, readBounded, validateHeaders } from "./public-network.js";

const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' http: https:",
  "style-src 'unsafe-inline' http: https:",
  "connect-src http: https:",
  "img-src data:",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts allow-same-origin",
].join("; ");

async function launchBrowser(binding, signal) {
  if (!binding) throw new AcquisitionError("rendering_unavailable", 503);
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  const endpoint = {
    fetch: async (input, init) => {
      signal.throwIfAborted();
      const response = await binding.fetch(input, { ...init, signal });
      if (response.status >= 400) {
        await response.body?.cancel();
        throw new AcquisitionError(
          response.status === 429
            ? "rendering_quota"
            : response.status === 401 || response.status === 403
              ? "rendering_unavailable"
              : "rendering_failed",
          response.status === 429 ? 429 : 503,
        );
      }
      return response;
    },
  };
  const limits = await puppeteer.limits(endpoint);
  signal.throwIfAborted();
  if (
    !Number.isFinite(limits.allowedBrowserAcquisitions) ||
    !Array.isArray(limits.activeSessions) ||
    !Number.isFinite(limits.maxConcurrentSessions)
  )
    throw new AcquisitionError("rendering_failed", 502);
  if (
    limits.allowedBrowserAcquisitions < 1 ||
    limits.activeSessions.length >= limits.maxConcurrentSessions
  )
    throw new AcquisitionError("rendering_quota", 429);
  return puppeteer.launch(endpoint, { keep_alive: 10_000, recording: false });
}

export async function renderPublicDocument(
  input,
  binding,
  outbound,
  signal,
  evidence,
  waitUntil = () => {},
  launch = launchBrowser,
) {
  const requestedUrl = publicTarget(input).href;
  signal.throwIfAborted();
  const stop = new AbortController();
  const networkSignal = AbortSignal.any([signal, stop.signal]);
  const pendingRequests = new Set();
  let browser,
    context,
    page,
    failure,
    closing,
    stopped = false;
  let browserRequests = 0,
    networkBytes = 0;
  const navigations = (evidence.navigations = [requestedUrl]);
  const close = () =>
    (closing ??= (async () => {
      stopped = true;
      stop.abort();
      if (!browser) return;
      let timer;
      try {
        await Promise.race([
          browser.close(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new AcquisitionError("rendering_cleanup_failed", 502)),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })());
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    rejectAbort(new AcquisitionError("deadline_or_cancelled", 504));
    if (browser) waitUntil(close().catch(() => {}));
  };
  signal.addEventListener("abort", abort, { once: true });
  const task = (async () => {
    try {
      browser = await launch(binding, signal);
      signal.throwIfAborted();
      context = await browser.createBrowserContext();
      page = await context.newPage();
      const cdp = await page.createCDPSession();
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "deny",
        browserContextId: context.id,
      });
      await page.setBypassServiceWorker(true);
      await page.setCacheEnabled(false);
      await page.setRequestInterception(true);
      await page.setOfflineMode(true);
      await page.evaluateOnNewDocument(() => {
        for (const name of [
          "RTCPeerConnection",
          "webkitRTCPeerConnection",
          "WebTransport",
          "WebSocket",
          "Worker",
          "SharedWorker",
          "open",
        ]) {
          Object.defineProperty(globalThis, name, {
            value: undefined,
            writable: false,
            configurable: false,
          });
        }
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      const handle = async (request) => {
        try {
          if (stopped || signal.aborted || failure) {
            await request.abort();
            return;
          }
          const target = publicTarget(request.url());
          if (++browserRequests > 80) throw new AcquisitionError("rendering_request_limit", 422);
          if (request.method() !== "GET")
            throw new AcquisitionError("rendering_method_forbidden", 403);
          if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) {
            await request.abort();
            return;
          }
          if (["image", "media", "font"].includes(request.resourceType())) {
            await request.abort();
            return;
          }
          const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
          if (main && navigations.at(-1) !== target.href) {
            if (navigations.length >= 6)
              throw new AcquisitionError("rendering_navigation_limit", 422);
            navigations.push(target.href);
          }
          evidence.contacts.push(target.origin + "/");
          target.hash = "";
          const response = await outbound(target.href, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            signal: networkSignal,
            headers: {
              Accept: main ? "text/html,application/xhtml+xml,text/plain" : "*/*",
              "User-Agent": "Aper-Web-Access/1.2",
            },
          });
          try {
            validateHeaders(response);
            if (main) evidence.upstreamStatus = response.status;
            const headers = {};
            for (const name of [
              "content-type",
              "access-control-allow-origin",
              "access-control-allow-methods",
              "access-control-allow-headers",
            ]) {
              const value = response.headers.get(name);
              if (value) headers[name] = value;
            }
            headers["cache-control"] = "no-store";
            if (main) {
              headers["content-security-policy"] = [
                response.headers.get("content-security-policy"),
                policy,
              ]
                .filter(Boolean)
                .join(", ");
              headers["permissions-policy"] =
                "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), payment=()";
            }
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get("location");
              if (!location || request.redirectChain().length >= 5)
                throw new AcquisitionError("redirect_limit", 422);
              const next = publicTarget(new URL(location, target).href);
              if (main) {
                if (evidence.redirects.length >= 5)
                  throw new AcquisitionError("redirect_limit", 422);
                evidence.redirects.push({
                  from: publicTarget(request.url()).href,
                  to: next.href,
                  status: response.status,
                });
              }
              headers.location = next.href;
              await request.respond({ status: response.status, headers });
              return;
            }
            if (main && response.status !== 200)
              throw new AcquisitionError("target_http_error", 422);
            if (
              main &&
              !/^(text\/(html|plain)|application\/xhtml\+xml)(;|$)/i.test(
                headers["content-type"] ?? "",
              )
            )
              throw new AcquisitionError("unsupported_document", 422);
            if (response.status === 206 || response.headers.has("content-range"))
              throw new AcquisitionError("unsupported_document", 422);
            const bytes = await readBounded(response.body, 2_000_000, networkSignal, (size) => {
              networkBytes += size;
              if (networkBytes > 8_000_000) {
                failure ??= new AcquisitionError("response_too_large", 413);
                stop.abort();
                throw failure;
              }
            });
            if (main) {
              const charset =
                /charset\s*=\s*["']?([^;\s"']+)/i.exec(headers["content-type"])?.[1] ?? "utf-8";
              try {
                new TextDecoder(charset, { fatal: true }).decode(bytes);
              } catch {
                throw new AcquisitionError("invalid_encoding", 422);
              }
            }
            signal.throwIfAborted();
            await request.respond({ status: response.status, headers, body: bytes });
          } finally {
            await response.body?.cancel().catch(() => {});
          }
        } catch (error) {
          if (!stopped)
            failure ??=
              error instanceof AcquisitionError
                ? error
                : new AcquisitionError("rendering_failed", 502);
          await request.abort().catch(() => {});
        }
      };
      page.on("request", (request) => {
        const pending = handle(request);
        pendingRequests.add(pending);
        void pending.finally(() => pendingRequests.delete(pending));
        waitUntil(pending);
      });
      await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 12_000 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      signal.throwIfAborted();
      if (failure) throw failure;
      if (pendingRequests.size) throw new AcquisitionError("rendering_failed", 502);
      const finalUrl = publicTarget(page.url()).href;
      if (navigations.at(-1) !== finalUrl) {
        if (navigations.length >= 6) throw new AcquisitionError("rendering_navigation_limit", 422);
        navigations.push(finalUrl);
      }
      const body = await page.content();
      signal.throwIfAborted();
      if (failure) throw failure;
      const byteCount = new TextEncoder().encode(body).byteLength;
      if (!body.trim() || byteCount > 2_000_000)
        throw new AcquisitionError("response_too_large", 413);
      return {
        requestedUrl,
        finalUrl,
        status: 200,
        contentType: "text/html; charset=utf-8",
        body,
        byteCount,
        acquisition: "rendered",
        contacts: evidence.contacts,
        redirects: evidence.redirects,
        navigations,
        browserRequests,
        networkBytes,
        isolation: "fresh_context",
        readiness: "domcontentloaded+1000ms",
      };
    } catch (error) {
      if (failure) throw failure;
      if (signal.aborted || error?.name === "TimeoutError")
        throw new AcquisitionError("deadline_or_cancelled", 504);
      if (error instanceof AcquisitionError) throw error;
      throw new AcquisitionError("rendering_failed", 502);
    } finally {
      if (browser) await close();
    }
  })();
  waitUntil(task.catch(() => {}));
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
