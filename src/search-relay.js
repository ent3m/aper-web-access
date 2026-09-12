const profiles = Object.freeze({
  brave: ["https://api.search.brave.com/res/v1/llm/context", "X-Subscription-Token"],
  exa: ["https://api.exa.ai/search", "x-api-key"],
  firecrawl: ["https://api.firecrawl.dev/v2/search", "Authorization"],
  you: ["https://ydc-index.io/v1/search", "X-API-Key"],
});
export const searchServices = Object.freeze(Object.keys(profiles));

export function relayRequest(service, input) {
  const invalid = () => {
    throw new Error("invalid_search_request");
  };
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!object(input) || Object.keys(input).sort().join() !== "body,credential") invalid();
  const { body, credential } = input;
  if (
    !Object.hasOwn(profiles, service) ||
    typeof credential !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/.test(credential) ||
    !object(body)
  )
    invalid();
  const required = {
    brave: ["q", "count", "maximum_number_of_urls", "safesearch", "spellcheck", "enable_local"],
    exa: ["query", "numResults", "type", "contents", "moderation"],
    firecrawl: ["query", "limit", "sources"],
    you: ["query", "count", "safesearch"],
  }[service];
  const optional =
    service === "exa"
      ? ["userLocation", "startPublishedDate", "endPublishedDate"]
      : ["country", service === "firecrawl" ? "tbs" : "freshness"];
  if (
    required.some((key) => !Object.hasOwn(body, key)) ||
    Object.keys(body).some((key) => ![...required, ...optional].includes(key))
  )
    invalid();
  const query = body[service === "brave" ? "q" : "query"];
  const count =
    body[service === "exa" ? "numResults" : service === "firecrawl" ? "limit" : "count"];
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 400 ||
    query.trim().split(/\s+/u).length > 50 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 50
  )
    invalid();
  const country = body.country ?? body.userLocation;
  if (country !== undefined && (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)))
    invalid();
  if ((service === "brave" || service === "you") && !["moderate", "off"].includes(body.safesearch))
    invalid();
  if (
    service === "brave" &&
    (body.maximum_number_of_urls !== count ||
      body.spellcheck !== false ||
      body.enable_local !== false)
  )
    invalid();
  if (
    service === "exa" &&
    (body.type !== "auto" ||
      typeof body.moderation !== "boolean" ||
      !object(body.contents) ||
      Object.keys(body.contents).join() !== "highlights" ||
      body.contents.highlights !== true)
  )
    invalid();
  if (service === "firecrawl" && JSON.stringify(body.sources) !== '["web"]') invalid();
  for (const key of ["freshness", "tbs", "startPublishedDate", "endPublishedDate"]) {
    if (body[key] === undefined) continue;
    const pattern =
      key === "freshness"
        ? /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/
        : key === "tbs"
          ? /^cdr:1,cd_min:\d{2}\/\d{2}\/\d{4},cd_max:\d{2}\/\d{2}\/\d{4}$/
          : /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;
    if (typeof body[key] !== "string" || !pattern.test(body[key])) invalid();
  }
  const [endpoint, header] = profiles[service];
  return {
    endpoint,
    init: {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [header]: service === "firecrawl" ? `Bearer ${credential}` : credential,
        ...(service === "brave" ? { "Api-Version": "2026-07-31" } : {}),
      },
      body: JSON.stringify(body),
    },
  };
}
