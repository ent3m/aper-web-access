import { AcquisitionError, publicTarget, readBounded, validateHeaders } from "./public-network.js";

export async function relayMarkdownNew(input, outbound, signal, evidence) {
  const url = publicTarget(input).href;
  signal.throwIfAborted();
  const endpoint = "https://markdown.new/";
  evidence.contacts.push(endpoint);
  let response;
  try {
    response = await outbound(endpoint, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url, method: "auto", retain_images: false }),
    });
  } catch {
    signal.throwIfAborted();
    throw new AcquisitionError("markdown_new_network_error", 502);
  }
  evidence.upstreamStatus = response.status;
  try {
    validateHeaders(response);
    if (response.status >= 300 && response.status < 400)
      throw new AcquisitionError("markdown_new_redirect_forbidden", 502);
    if (
      response.status === 206 ||
      response.headers.has("content-range") ||
      response.headers.get("x-truncated") === "true"
    )
      throw new AcquisitionError("truncated_content", 422);
    if (response.status !== 200)
      throw new AcquisitionError(
        response.status === 429 ? "markdown_new_quota" : "markdown_new_http_error",
        502,
      );
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:;|$)/i.test(contentType))
      throw new AcquisitionError("markdown_new_invalid_response", 502);
    if (Number(response.headers.get("content-length")) > 1_000_000)
      throw new AcquisitionError("response_too_large", 413);
    const bytes = await readBounded(response.body, 1_000_000, signal);
    let body;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AcquisitionError("invalid_encoding", 422);
    }
    return { status: 200, contentType, body, byteCount: bytes.byteLength, ...evidence };
  } finally {
    if (!response.body?.locked) await response.body?.cancel().catch(() => {});
  }
}
