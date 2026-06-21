/**
 * atlas-notify
 *
 * Centralised event router for the Atlas Systems stack. Every service
 * POSTs events here; this Worker normalises them into Discord embeds
 * and forwards them to a single webhook. It also persists a rolling
 * window of recent events to KV so the Lab page can render a Failure
 * log — the historical companion to the home page's "is it up now"
 * indicator.
 *
 * Three inbound dialects share one NOTIFY_TOKEN secret:
 *   1. Atlas envelope  { source, ... }  with  Authorization: Bearer <token>
 *   2. Native GitHub webhooks, detected via X-GitHub-Event and verified
 *      with HMAC SHA-256 (X-Hub-Signature-256)
 *   3. Cloudflare notification webhooks, verified via cf-webhook-auth
 *
 * Design rule: a malformed or unknown payload should degrade into a
 * visible warning embed, never a silent drop or a crash. The only hard
 * rejections are auth failures and unparseable envelope bodies.
 */

// Brand palette as Discord embed colours (decimal RGB).
// Source of truth: atlas-brand.md.
const COLOURS = {
  success: 0x4ade80, // status green
  failure: 0xe24b4a, // error red
  warning: 0xf5a623, // brand amber doubles as the warning tone
  info: 0xaaa9a0, // dim text grey for neutral events
};

const FOOTER = { text: "atlas-notify // api.atlas-systems.uk" };

// Discord hard limits. Exceeding any of these makes the whole request 400,
// so every formatter routes its strings through truncate().
const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024 };

// Reject oversized bodies before doing any work. 64 KB is far beyond any
// legitimate event payload and keeps a hostile caller from burning CPU time.
const MAX_BODY_BYTES = 64 * 1024;

// Recent-events ring buffer. Stored as a single JSON array under one KV
// key. A single key keeps the read endpoint to one KV op (cheap, fast)
// and the cap keeps the document under KV's 25 MB value ceiling by many
// orders of magnitude. 200 entries is roughly a month of typical events
// without becoming a log file.
const RECENT_KEY = "notify:recent:v1";
const RECENT_MAX = 200;
const RECENT_PAGE_DEFAULT = 10;
const RECENT_PAGE_MAX = 50;

const VALID_LEVELS = new Set(["success", "info", "warning", "failure"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Liveness probe for Uptime Kuma. Deliberately unauthenticated and
    // side-effect free: it confirms the Worker is routed and running,
    // nothing more.
    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      return json(200, { ok: true, service: "atlas-notify" }, corsHeaders(request));
    }

    // Recent events feed for the Lab page Failure log. Read-only,
    // unauthenticated (same trust posture as /pulse — the data is
    // already destined for a public webhook), CORS-restricted to the
    // site origins so other sites can't quietly build on this cache.
    if (request.method === "GET" && url.pathname.endsWith("/notify/recent")) {
      return handleRecent(url, env, corsHeaders(request));
    }

    if (request.method === "OPTIONS" && url.pathname.endsWith("/notify/recent")) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // API index. Lets a visitor discover every live endpoint under this
    // hostname without reading source. Unauthenticated and side-effect free.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      const data = {
        service: "Atlas Systems API",
        generatedAt: new Date().toISOString(),
        endpoints: [
          // atlas-notify
          { method: "GET",  path: "/",                    worker: "atlas-notify",  description: "This index" },
          { method: "POST", path: "/notify",              worker: "atlas-notify",  description: "Deliver an event into the Discord pipeline (auth required)" },
          { method: "GET",  path: "/notify/recent",       worker: "atlas-notify",  description: "Recent events feed (optional ?limit=, ?level=)" },
          { method: "GET",  path: "/notify/health",       worker: "atlas-notify",  description: "Liveness probe, unauthenticated" },
          // github-pulse
          { method: "GET",  path: "/pulse",               worker: "github-pulse",  description: "Aggregate GitHub stats across the account, KV-cached" },
          { method: "GET",  path: "/pulse?repo=<name>",   worker: "github-pulse",  description: "Stats for one repository in detail" },
          { method: "GET",  path: "/pulse/heatmap",       worker: "github-pulse",  description: "Per-day commit counts for the last 90 days" },
          // site-pulse
          { method: "GET",  path: "/site-pulse",          worker: "site-pulse",    description: "Site visit stats for the last 24h, KV-cached" },
          { method: "GET",  path: "/site-pulse/weekly",   worker: "site-pulse",    description: "Rolling 7-day visit total from daily snapshots" },
          { method: "GET",  path: "/site-pulse/health",   worker: "site-pulse",    description: "Liveness probe, unauthenticated" },
          // deploy-watch
          { method: "GET",  path: "/deploy-watch/latest", worker: "deploy-watch",  description: "Latest Cloudflare Pages deploy snapshot (used by homepage)" },
          { method: "GET",  path: "/deploy-watch/health", worker: "deploy-watch",  description: "Liveness probe, unauthenticated" },
          { method: "GET",  path: "/deploy-watch/run",    worker: "deploy-watch",  description: "Manually trigger a deploy check (auth required)" },
        ],
        repos: {
          "atlas-notify":  "https://github.com/AtlasReaper311/atlas-notify",
          "github-pulse":  "https://github.com/AtlasReaper311/github-pulse",
          "site-pulse":    "https://github.com/AtlasReaper311/site-pulse",
          "deploy-watch":  "https://github.com/AtlasReaper311/deploy-watch",
        },
      };

      const accept = request.headers.get("accept") || "";
      if (accept.includes("text/html")) {
        return new Response(renderIndexHtml(data), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return json(200, data);
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "POST events to this endpoint" }, { Allow: "POST" });
    }

    // Fail loudly on misconfiguration. A router that silently swallows
    // events because a secret is missing is worse than one that errors.
    if (!env.DISCORD_WEBHOOK_URL) {
      return json(500, { ok: false, error: "DISCORD_WEBHOOK_URL secret is not set" });
    }
    if (!env.NOTIFY_TOKEN) {
      return json(500, { ok: false, error: "NOTIFY_TOKEN secret is not set" });
    }

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: "payload too large" });
    }

    // The body can only be read once, and GitHub HMAC verification needs
    // the exact raw bytes, so read text here and parse JSON later.
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: "payload too large" });
    }

    const auth = await authenticate(request, rawBody, env.NOTIFY_TOKEN);
    if (!auth.ok) {
      return json(401, { ok: false, error: auth.reason });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      if (auth.dialect === "cloudflare") {
        // Cloudflare sends a plain-text ping when you save a webhook
        // destination. Accepting it as an info embed lets the destination
        // verify on the first try instead of failing setup.
        payload = null;
      } else {
        return json(400, { ok: false, error: "body is not valid JSON" });
      }
    }

    // Build the embed. A formatter bug must not take the router down, so
    // any exception degrades to a fallback embed that still surfaces the
    // raw event in Discord where a human will see it.
    let embed;
    let eventLabel;
    try {
      ({ embed, eventLabel } = buildEmbed(auth.dialect, request, payload, rawBody));
    } catch (err) {
      embed = fallbackEmbed(auth.dialect, rawBody, err);
      eventLabel = "formatter-error";
    }

    const discord = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!discord.ok) {
      // Pass Discord's rate-limit hint through so a well-behaved caller
      // can back off instead of hammering the webhook.
      const headers = {};
      const retryAfter = discord.headers.get("retry-after");
      if (retryAfter) headers["Retry-After"] = retryAfter;
      return json(502, { ok: false, error: "Discord rejected the webhook", discordStatus: discord.status }, headers);
    }
    if (auth.dialect === "github" && request.headers.get("x-github-event") === "push") {
      ctx.waitUntil(purgePulseCache(env));
    }

    // Persist a compact summary of this event to the recent-events ring
    // buffer for the Lab Failure log. Best-effort: any KV failure must
    // not propagate to the caller, since the event has already been
    // delivered to Discord and Discord is the source of truth.
    ctx.waitUntil(persistRecent(env, auth.dialect, eventLabel, embed));

    return json(200, { ok: true, dialect: auth.dialect, event: eventLabel });
  },
};

/* ------------------------------------------------------------------ */
/* Recent events store + read endpoint                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /notify/recent — last N events as JSON for the Lab page.
 * Query params:
 *   ?limit=<1..50>          how many to return (default 10)
 *   ?level=<success|info|warning|failure>   filter by level (optional,
 *                                           repeatable: ?level=warning&level=failure)
 */
async function handleRecent(url, env, cors) {
  if (!env.NOTIFY_LOG) {
    // KV not bound — fail informatively rather than silently empty.
    return json(503, { ok: false, error: "NOTIFY_LOG KV not bound; see wrangler.toml" }, cors);
  }

  const limit = clampInt(url.searchParams.get("limit"), 1, RECENT_PAGE_MAX, RECENT_PAGE_DEFAULT);
  const levelParams = url.searchParams.getAll("level").filter((l) => VALID_LEVELS.has(l));
  const wantLevels = levelParams.length ? new Set(levelParams) : null;

  let events = [];
  try {
    const raw = await env.NOTIFY_LOG.get(RECENT_KEY);
    events = raw ? JSON.parse(raw) : [];
  } catch {
    events = [];
  }

  const filtered = wantLevels
    ? events.filter((e) => wantLevels.has(e.level))
    : events;
  const sliced = filtered.slice(0, limit);

  // Always include the available level set so a frontend can render
  // accurate filter chips without a second round trip.
  const counts = {};
  for (const e of events) counts[e.level] = (counts[e.level] || 0) + 1;

  return new Response(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    total: events.length,
    returned: sliced.length,
    levelCounts: counts,
    events: sliced,
  }), {
    status: 200,
    headers: {
      ...cors,
      "content-type": "application/json",
      // 60s browser cache: the panel polls; we don't want every reload
      // to be a KV read either. The frontend can bypass with ?t=.
      "Cache-Control": "public, max-age=60",
    },
  });
}

/**
 * Append a compact summary of the event to the recent ring buffer.
 * Stores the smallest useful shape: enough for a UI line, not enough
 * to leak payload contents. Discord is the rich view; this is the
 * historical companion.
 *
 * Note on concurrency: KV is eventually consistent and read-modify-write
 * is not atomic. With one Worker instance and event rates measured in
 * dozens/day, the practical loss is ~zero. If two events arrive in the
 * same millisecond, one overwrites; that's acceptable for a Failure
 * log whose source of truth is Discord.
 */
async function persistRecent(env, dialect, eventLabel, embed) {
  if (!env.NOTIFY_LOG) return;
  try {
    const level = colourToLevel(embed?.color);
    const summary = {
      ts: embed?.timestamp || new Date().toISOString(),
      level,
      dialect,
      event: eventLabel,
      title: embed?.title || "",
      // Description can be a code-fenced raw body for fallback embeds;
      // trim hard so the ring buffer stays small.
      message: truncate(stripCodeFences(embed?.description || ""), 280),
    };

    const raw = await env.NOTIFY_LOG.get(RECENT_KEY);
    const existing = raw ? safeParseArray(raw) : [];
    existing.unshift(summary);
    if (existing.length > RECENT_MAX) existing.length = RECENT_MAX;
    await env.NOTIFY_LOG.put(RECENT_KEY, JSON.stringify(existing));
  } catch {
    // Best-effort; nothing useful to do here. The event already shipped
    // to Discord and that is the canonical record.
  }
}

function colourToLevel(color) {
  if (color === COLOURS.success) return "success";
  if (color === COLOURS.failure) return "failure";
  if (color === COLOURS.warning) return "warning";
  return "info";
}

function stripCodeFences(s) {
  return String(s).replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
}

function safeParseArray(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

/**
 * Identify the caller's dialect from headers and verify the shared token.
 * GitHub gets HMAC verification because that is its native mechanism;
 * everything else compares the token directly in constant time.
 */
async function authenticate(request, rawBody, token) {
  const githubEvent = request.headers.get("x-github-event");
  if (githubEvent) {
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature) return { ok: false, reason: "missing X-Hub-Signature-256" };
    const valid = await verifyGitHubSignature(rawBody, signature, token);
    return valid
      ? { ok: true, dialect: "github" }
      : { ok: false, reason: "GitHub signature verification failed" };
  }

  const cfAuth = request.headers.get("cf-webhook-auth");
  if (cfAuth !== null) {
    return timingSafeEqual(cfAuth, token)
      ? { ok: true, dialect: "cloudflare" }
      : { ok: false, reason: "cf-webhook-auth mismatch" };
  }

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false, reason: "missing Authorization: Bearer token" };
  return timingSafeEqual(bearer, token)
    ? { ok: true, dialect: "envelope" }
    : { ok: false, reason: "bearer token mismatch" };
}

/**
 * Constant-time string comparison. A naive === short-circuits on the
 * first differing byte, which leaks timing information an attacker can
 * use to recover the token byte by byte. XOR-accumulating over the full
 * length removes that signal. Length mismatch returns early; leaking the
 * token's length is accepted practice (HMAC libraries do the same).
 */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

/**
 * Verify GitHub's HMAC SHA-256 signature over the raw request body.
 * The webhook secret on the GitHub side must equal NOTIFY_TOKEN.
 */
async function verifyGitHubSignature(rawBody, signatureHeader, token) {
  const expectedHex = signatureHeader.replace(/^sha256=/, "");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const actualHex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(actualHex, expectedHex);
}

/* ------------------------------------------------------------------ */
/* Embed construction                                                  */
/* ------------------------------------------------------------------ */

function buildEmbed(dialect, request, payload, rawBody) {
  if (dialect === "github") {
    const eventName = request.headers.get("x-github-event");
    return { embed: formatGitHubEvent(eventName, payload), eventLabel: `github:${eventName}` };
  }

  if (dialect === "cloudflare") {
    return { embed: formatCloudflareNotification(payload, rawBody), eventLabel: "cloudflare" };
  }

  // Envelope dialect: the caller declares its source explicitly.
  const source = payload?.source;
  const formatter = ENVELOPE_FORMATTERS[source];
  if (formatter) {
    return { embed: formatter(payload), eventLabel: source };
  }

  // Unknown sources still get delivered. The router's job is visibility;
  // rejecting events from a service someone wired up tomorrow would
  // create exactly the blind spot this layer exists to remove.
  return {
    embed: {
      title: truncate(`Unrecognised source: ${source ?? "(none)"}`, LIMITS.title),
      description: codeBlock(rawBody, LIMITS.description),
      color: COLOURS.warning,
      footer: FOOTER,
      timestamp: new Date().toISOString(),
    },
    eventLabel: "unknown-source",
  };
}

/**
 * Formatters for the Atlas envelope dialect. Each takes the parsed
 * payload and returns a complete Discord embed. Adding a new event type
 * to the stack means adding one entry here and nothing else.
 */
const ENVELOPE_FORMATTERS = {
  pages_deploy(p) {
    const ok = p.status === "success";
    return {
      title: truncate(`Pages deploy ${ok ? "succeeded" : "failed"}: ${p.project ?? "unknown project"}`, LIMITS.title),
      color: ok ? COLOURS.success : COLOURS.failure,
      fields: compactFields([
        { name: "Branch", value: inlineCode(p.branch), inline: true },
        { name: "Commit", value: inlineCode(shortSha(p.commit)), inline: true },
        { name: "URL", value: p.url, inline: false },
      ]),
      footer: FOOTER,
      timestamp: new Date().toISOString(),
    };
  },

  docker_health(p) {
    // healthy -> green, unhealthy -> red, anything transitional -> amber.
    const colour =
      p.new_state === "healthy" ? COLOURS.success
      : p.new_state === "unhealthy" ? COLOURS.failure
      : COLOURS.warning;
    return {
      title: truncate(`Container health: ${p.container ?? "unknown"}`, LIMITS.title),
      description: truncate(`${p.old_state ?? "unknown"} -> ${p.new_state ?? "unknown"}`, LIMITS.description),
      color: colour,
      fields: compactFields([{ name: "Host", value: inlineCode(p.host), inline: true }]),
      footer: FOOTER,
      timestamp: new Date().toISOString(),
    };
  },

  github_push(p) {
    return {
      title: truncate(`Push to ${p.repo ?? "unknown repo"}`, LIMITS.title),
      description: truncate(p.message ?? "", LIMITS.description),
      color: COLOURS.info,
      fields: compactFields([
        { name: "Branch", value: inlineCode(p.branch), inline: true },
        { name: "Author", value: p.author, inline: true },
      ]),
      footer: FOOTER,
      timestamp: new Date().toISOString(),
    };
  },

  alert(p) {
    const colour = COLOURS[p.level] ?? (p.level === "error" ? COLOURS.failure : COLOURS.info);
    return {
      title: truncate(p.title ?? "Alert", LIMITS.title),
      description: truncate(p.message ?? "", LIMITS.description),
      color: colour,
      fields: compactFields(
        Object.entries(p.fields ?? {}).map(([name, value]) => ({
          name,
          value: String(value),
          inline: true,
        })),
      ),
      footer: FOOTER,
      timestamp: new Date().toISOString(),
    };
  },
};

/**
 * Native GitHub webhook events. Only ping and push get rich treatment;
 * any other event the repo is configured to send still lands in Discord
 * as a neutral embed rather than vanishing.
 */
function formatGitHubEvent(eventName, payload) {
  if (eventName === "ping") {
    return {
      title: truncate(`Webhook connected: ${payload?.repository?.full_name ?? "GitHub"}`, LIMITS.title),
      description: truncate(payload?.zen ?? "", LIMITS.description),
      color: COLOURS.success,
      footer: FOOTER,
      timestamp: new Date().toISOString(),
    };
  }

  if (eventName === "push") {
    const repo = payload?.repository?.full_name ?? "unknown repo";
    const branch = (payload?.ref ?? "").replace("refs/heads/", "");

    // A branch deletion arrives as a push with deleted=true and no
    // head_commit. Worth flagging in amber: deletions are usually
    // intentional but occasionally a force-push accident.
    if (payload?.deleted) {
      return {
        title: truncate(`Branch deleted on ${repo}`, LIMITS.title),
        description: truncate(inlineCode(branch), LIMITS.description),
        color: COLOURS.warning,
        footer: FOOTER,
        timestamp: new Date().toISOString(),
      };
    }

    const head = payload?.head_commit;
    return {
      title: truncate(`Push to ${repo}`, LIMITS.title),
      description: truncate(firstLine(head?.message), LIMITS.description),
      color: COLOURS.info,
      fields: compactFields([
        { name: "Branch", value: inlineCode(branch), inline: true },
        { name: "Author", value: head?.author?.name ?? payload?.pusher?.name, inline: true },
        { name: "Commit", value: head?.url ? `[${shortSha(head?.id)}](${head.url})` : inlineCode(shortSha(head?.id)), inline: true },
        { name: "Compare", value: payload?.compare, inline: false },
      ]),
      footer: FOOTER,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    title: truncate(`GitHub event: ${eventName}`, LIMITS.title),
    description: truncate(payload?.repository?.full_name ?? "", LIMITS.description),
    color: COLOURS.info,
    footer: FOOTER,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Cloudflare notification webhooks carry loosely structured payloads
 * that vary by alert type, so this formatter is deliberately defensive:
 * take whatever name/text exists and infer severity from the words.
 */
function formatCloudflareNotification(payload, rawBody) {
  const name = payload?.name ?? "Cloudflare notification";
  const text = payload?.text ?? (payload ? JSON.stringify(payload) : rawBody);
  const lower = String(text).toLowerCase();
  const colour = /fail|error|down/.test(lower) ? COLOURS.failure
    : /success|resolved|deploy/.test(lower) ? COLOURS.success
    : COLOURS.info;
  return {
    title: truncate(name, LIMITS.title),
    description: truncate(String(text), LIMITS.description),
    color: colour,
    footer: FOOTER,
    timestamp: new Date().toISOString(),
  };
}

/** Last-resort embed when a formatter throws. */
function fallbackEmbed(dialect, rawBody, err) {
  return {
    title: truncate(`Event received (${dialect}) but formatting failed`, LIMITS.title),
    description: codeBlock(rawBody, LIMITS.description),
    color: COLOURS.warning,
    fields: compactFields([{ name: "Formatter error", value: String(err?.message ?? err), inline: false }]),
    footer: FOOTER,
    timestamp: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function truncate(value, max) {
  const s = String(value ?? "");
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

function inlineCode(value) {
  return value ? `\`${truncate(value, 100)}\`` : value;
}

function codeBlock(value, max) {
  // Reserve room for the fences so truncation never breaks the block.
  const body = truncate(value, max - 8);
  return "```json\n" + body + "\n```";
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : sha;
}

function firstLine(message) {
  return message ? String(message).split("\n")[0] : "";
}

const ALLOWED_ORIGINS = ["https://atlas-systems.uk", "https://www.atlas-systems.uk", "https://status.atlas-systems.uk"];

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

async function purgePulseCache(env) {
  if (!env.PULSE_PURGE_URL || !env.PULSE_PURGE_TOKEN) return;
  try {
    await fetch(env.PULSE_PURGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PULSE_PURGE_TOKEN}` },
    });
  } catch {
    // best-effort; the hourly TTL is still the fallback if this fails
  }
}
/** Terminal-styled HTML view of the API index for browser visitors. */
function renderIndexHtml(data) {
  const rows = data.endpoints
    .map(
      (e) => `<tr>
        <td class="m">${e.method}</td>
        <td>${e.path}</td>
        <td class="w">${e.worker}</td>
        <td class="d">${e.description}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>api.atlas-systems.uk</title>
<style>
  body{background:#0a0a0f;color:#e8e8e0;font-family:'IBM Plex Mono',monospace;font-size:13px;padding:3rem 2rem;max-width:900px;margin:0 auto}
  h1{color:#f5a623;font-size:14px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:0.5rem}
  .meta{color:#888880;font-size:11px;margin-bottom:2rem}
  table{width:100%;border-collapse:collapse}
  td{padding:0.5rem 0.75rem;border-bottom:1px solid rgba(255,255,255,0.08);vertical-align:top}
  td.m{color:#f5a623;font-weight:600;white-space:nowrap}
  td.w{color:#888880;white-space:nowrap}
  td.d{color:#aaa9a0}
  a{color:#e8e8e0}
</style></head>
<body>
  <h1>// atlas systems api</h1>
  <div class="meta">generated ${data.generatedAt}</div>
  <table>${rows}</table>
</body></html>`;
}

/**
 * Drop fields with empty values and clamp the rest to Discord's limits.
 * Discord rejects the whole embed if a single field has an empty value,
 * so filtering here keeps optional payload keys genuinely optional.
 */
function compactFields(fields) {
  return fields
    .filter((f) => f.value !== undefined && f.value !== null && String(f.value).length > 0)
    .map((f) => ({
      name: truncate(f.name, LIMITS.fieldName),
      value: truncate(f.value, LIMITS.fieldValue),
      inline: Boolean(f.inline),
    }))
    .slice(0, 25);
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
