# Web Access Worker

Release **1.2.0**, protocol **1.2**, deployment kind **aper-web-access**. One user-owned Cloudflare Worker provides static public-document acquisition, allowlisted search relaying, and optional Browser Run. Acquisition stays here; extraction, normalization, backend policy and Callable projection stay in Aper. There is no persistence, telemetry, account-management client, MCP route, crawler, or browser-command API.

## Install and connect

1. In Aper, open **Settings → Local Tools → Web Access Worker → Set up Worker** (or **Replace Worker**).
2. Choose **Copy secret**, then **Deploy to Cloudflare**. Cloudflare needs your Cloudflare account and a GitHub or GitLab account and copies [this template](https://github.com/ent3m/aper-web-access) into your Git account.
3. Set `APER_ALLOWED_ORIGIN` to the exact origin shown in Aper, including any development port. Paste the copied value into the **secret** `APER_RUNTIME_SECRET`. Keep it out of source, ordinary variables, URLs, and command arguments.
4. Complete deployment, return to Aper, enter the new Worker URL, and choose **Connect**. The template declares `browser: { binding: "BROWSER" }`; no separate Worker, provisioned database, or Cloudflare management credential is needed.
5. Aper checks authentication and static acquisition, then actually renders example.com when supported. These explicit setup checks consume quota. A failed rendering check is shown separately and does not prevent use of verified static fetch and supported search relays. Binding presence and a build identifier are compatibility observations, not proof of service availability or source integrity.

The installer follows the public repository's default branch; no immutable release pin is claimed. Your repository copy does not automatically receive updates. Replacement uses a fresh secret and endpoint and switches local configuration only after mandatory verification. Failed/cancelled setup retains the old connection and infrastructure. **Disconnect** removes only Aper's connection; deletion and secret revocation remain actions in Cloudflare.

Cloudflare documents Browser Run on [Workers Free and Paid plans](https://developers.cloudflare.com/browser-run/pricing/), with plan-specific quotas. The hosted installer has displayed a Workers Paid warning while successfully deploying this template on a Free account. Aper's actual rendering check establishes service availability at the recorded time; the installer message and binding declaration do not.

For CLI deployment use `vp install --frozen-lockfile`, configure the origin in `wrangler.jsonc`, enter the secret through `vp exec wrangler secret put APER_RUNTIME_SECRET`, and deploy with `vp exec wrangler deploy`. CLI authorization stays in your account. Local configuration uses the gitignored `.dev.vars` copied from the empty example.

## HTTP contract

All routes require exact Origin and a separate 256-bit runtime bearer secret. CORS is browser policy, not authentication. Only route-specific GET/POST preflight and Authorization/Content-Type are accepted; responses disable caching. Request bodies are bounded to 10 KB.

| Route                        | Input                       | Result                                                                                                                         |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/info`               | Authentication              | Kind, protocol, build, and supported capabilities; `browserRun` reports binding presence                                       |
| `POST /v1/fetch`             | Only `{ url }`              | Requested/final URL, status, content type, decoded body, byte count, ordered HTTP redirects                                    |
| `POST /v1/render`            | Only `{ url }`              | Same document fields, rendered acquisition marker, navigation/contact evidence, resource counts and isolation/readiness policy |
| `POST /v1/search/<provider>` | Only `{ body, credential }` | Upstream status, bounded JSON body, allowlisted quota headers and contact evidence                                             |

Non-2xx errors return sanitized `{ error, contacts, redirects, ... }` evidence. Codes distinguish target policy, authentication, unsupported/partial content, encoding, response bounds, deadlines, browser eligibility/quota, browser execution and cleanup. Raw exceptions, upstream error bodies and credentials are not returned or logged. Protocol-major compatibility preserves existing static/relay clients; rendering requires the 1.2 envelope.

## Acquisition and rendering

`public-network.js` owns shared target and body validation. Only public HTTP(S) DNS names on default ports are supported. IP literals, credentials, local/reserved names and unsafe schemes fail before dispatch. Limits are 8,192 URL characters, five HTTP redirects, 32 KB observed headers, 2 MB per response and a 15-second request deadline. Static acquisition constructs GET requests with fixed Accept/User-Agent and no forwarded cookies, authorization, body or browser headers; redirects are followed manually and revalidated. Only complete HTTP 200 HTML/XHTML/plain text with valid decoding succeeds. Known partial responses, oversize bodies and decoding errors fail.

`browser-rendering.js` uses pinned `@cloudflare/puppeteer@1.1.0` through `env.BROWSER`. It checks binding quota before launching once, creates a fresh isolated context, disables recording/cache/service-worker reuse, denies downloads and unused permissions, and closes the entire browser on success, failure or cancellation. There is no session lookup, reuse or retry. Late acquisition after cancellation is closed; failed cleanup is visible. The binding's minimum 10-second idle expiry bounds orphaned service sessions when cleanup cannot be acknowledged.

Rendering keeps Chromium offline and fulfills intercepted GET requests through the same strictly-public Worker fetch boundary. This avoids giving the remote browser a separate HTTP egress policy and keeps cookies, storage-generated auth and incoming credentials out of target requests. Original page CSP is retained alongside restrictive script/resource policy; frames, workers, forms, popups, WebSocket, WebTransport and WebRTC entry points are disabled, and images/media/fonts are not acquired. Remote code has no Aper bridge or ordinary browser profile. These restrictions can make some public apps unusable; failure is preferred to widening the operation into interactive automation.

Every navigation and redirect is revalidated. Rendering allows at most 80 requests, 8 MB aggregate acquired bytes, six recorded navigation targets and one HTML snapshot after DOMContentLoaded plus a fixed one-second stabilization window. Outstanding acquisition at capture fails. In-flight acquisition is aborted when the browser closes. The returned raw DOM is extracted by Aper using the same inert local pipeline as static HTML. No clicking, scrolling, form submission, login, CAPTCHA bypass, remote extraction or model-selected browser commands exist.

`global_fetch_strictly_public` applies to all Worker HTTP acquisition, including intercepted browser resources. Workers exposes no trustworthy DNS pinning here; hostname validation and public platform routing are defense in depth, not a complete DNS-rebinding guarantee. Header bounds apply after platform acquisition. Browser cancellation is best effort across a remote connection; the Worker deadline still bounds work if client disconnection is not propagated. Account quota, concurrency and service eligibility remain external constraints.

## Search relay

`search-relay.js` validates each provider's exact supported request shape and fixed defaults, constructs its allowlisted endpoint/POST/auth header, and refuses arbitrary URLs, headers, redirects, methods, synthesis or scraping options. Provider credentials are distinct from the runtime secret. Responses are bounded to 2 MB before decoding; rejected upstream responses preserve status and safe quota headers with a null body. Search normalization stays in Aper. Rendering service failures do not mutate relay or static availability.

## Verification

Run `vp check --fix`, `vp test`, `vp build`, and `vp exec wrangler deploy --dry-run --outdir dist/deploy`. Vite's library build leaves the Worker-only browser package external; Wrangler performs the deployable bundle with its platform compatibility. Unit tests cover routing/auth/CORS, targets, redirects, decoding/resource bounds, provider allowlists, rendering service/quota failure, cancellation and late-browser cleanup.

From the adjacent Aper repository, `vp exec node scripts/verify-web-worker-browser.mjs` checks real Chromium HTTP/CORS for static and search routes. `vp exec node scripts/verify-web-rendering-browser.mjs` executes the production renderer against isolated Chromium with deterministic upstreams, proving JavaScript/fragment rendering, storage isolation, credential stripping, auxiliary-API restrictions, private requests/redirects, POST rejection, navigation bounds and cleanup. Aper's Web, configuration and settings suites verify extraction, explicit fallback policy and replacement publication. These local checks do not prove Cloudflare service availability.

User-observed hosted installation on a Workers Free account deployed release 1.2.0 to [aper-web-access-test-1dot2](https://aper-web-access-test-1dot2.badmovie100.workers.dev) at `2026-09-12T23:52:06.819Z` (Cloudflare version `c8cac93a-cda6-4085-a5c8-13572983452d`). Aper reported protocol 1.2 and **Browser rendering: verified**, checked `2026-09-12T23:52:50.725Z`. This establishes authenticated static acquisition and a successful example.com render through the installed browser binding, beyond binding presence alone. It does not establish arbitrary-page completeness, live provider relay behavior, or ongoing availability.

References: [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/), [Browser binding](https://developers.cloudflare.com/browser-run/reference/wrangler/), [Puppeteer binding and limits](https://developers.cloudflare.com/browser-run/puppeteer/), [Worker fetch routing](https://developers.cloudflare.com/workers/runtime-apis/fetch/).
