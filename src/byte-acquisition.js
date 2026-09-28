import { AcquisitionError, publicTarget, readBounded, validateHeaders } from "./public-network.js";

export const EXACT_BYTE_LIMIT = 10_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function responseMediaType(response) {
  const value = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return value && value.length <= 255 && MEDIA_TYPE.test(value) ? value : undefined;
}

export async function acquirePublicBytes(input, outbound, signal, evidence) {
  let url = publicTarget(input);
  const requestedUrl = url.href;
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
        Accept: "*/*",
        "Accept-Encoding": "identity",
        "User-Agent": "Aper-Web-Access/1.0",
      },
    });
    evidence.upstreamStatus = response.status;
    try {
      validateHeaders(response);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || evidence.redirects.length >= 5)
        throw new AcquisitionError("redirect_limit", 502);
      const next = publicTarget(new URL(location, url).href);
      evidence.redirects.push({ from: url.href, to: next.href, status: response.status });
      url = next;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new AcquisitionError(
        response.status === 206 || response.headers.has("content-range")
          ? "truncated_content"
          : "target_http_error",
        422,
      );
    }
    if (response.headers.has("content-range")) {
      await response.body?.cancel();
      throw new AcquisitionError("truncated_content", 422);
    }
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
      await response.body?.cancel();
      throw new AcquisitionError("unsupported_content_encoding", 422);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^(0|[1-9]\d*)$/.test(declaredLength)) {
        await response.body?.cancel();
        throw new AcquisitionError("truncated_content", 422);
      }
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length > EXACT_BYTE_LIMIT) {
        await response.body?.cancel();
        throw new AcquisitionError("response_too_large", 413);
      }
    }
    const bytes = await readBounded(response.body, EXACT_BYTE_LIMIT, signal);
    if (declaredLength !== null && Number(declaredLength) !== bytes.byteLength)
      throw new AcquisitionError("truncated_content", 422);
    return {
      requestedUrl,
      finalUrl: url.href,
      bytes,
      mediaType: responseMediaType(response),
      redirects: evidence.redirects,
    };
  }
}
