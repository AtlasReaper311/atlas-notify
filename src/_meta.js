/**
 * _meta.js: the Atlas Systems /_meta convention. CANONICAL COPY.
 *
 * Contract (fixed estate-wide):
 *
 *   GET <route-prefix>/_meta  ->  200 application/json
 *   {
 *     "name":        "worker-name",
 *     "description": "one sentence",
 *     "version":     "1.0.0",
 *     "endpoints":   [{ "method": "GET", "path": "/x", "description": "..." }],
 *     "status":      "live",
 *     "source":      "https://github.com/AtlasReaper311/<repo>"
 *   }
 *
 * Vendored (copied into each Worker's src/), not npm-published: one
 * file and one import line per Worker, zero registry dependency.
 * This file in atlas-api-index/shared/ is the source of truth; copies
 * elsewhere carry a pointer back here.
 *
 * Usage, one line inside fetch():
 *   const meta = handleMeta(url, META); if (meta) return meta;
 */

/**
 * Answer GET /_meta under any route prefix, or return null.
 * Matching on the path suffix means the same module works whether the
 * Worker owns api.example.com/thing* or a bare workers.dev hostname.
 * @param {URL} url - the parsed request URL
 * @param {object} meta - the Worker's self-description (see contract)
 * @returns {Response|null}
 */
export function handleMeta(url, meta) {
  const path = url.pathname;
  if (path !== "/_meta" && !path.endsWith("/_meta")) return null;
  return Response.json(
    { status: "live", ...meta },
    {
      headers: {
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
      },
    },
  );
}
