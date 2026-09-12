export class AcquisitionError extends Error {
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
    url.href.length > 8192 ||
    host.length > 253 ||
    host.split(".").some((label) => label.length > 63) ||
    !host.includes(".") ||
    host.includes(":") ||
    /^[\d.]+$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)
  )
    throw new AcquisitionError("forbidden_target", 403);
  return url;
}

export async function readBounded(body, limit, signal, consume = () => {}) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      consume(value.byteLength);
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

export function validateHeaders(response) {
  let bytes = 0;
  for (const [key, value] of response.headers)
    bytes += new TextEncoder().encode(key + value).length;
  if (bytes > 32768) throw new AcquisitionError("headers_too_large", 502);
}
