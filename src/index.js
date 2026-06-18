/**
 * atlas-notify
 *
 * Centralised event router for the Atlas Systems stack. Every service
 * POSTs events here; this Worker normalises them into Discord embeds
 * and forwards them to a single webhook.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Liveness probe for Uptime Kuma. Deliberately unauthenticated and
    // side-effect free: it confirms the Worker is routed and running,
    // nothing more.
    if (request.method === "GET" && url.pathname.endsWith("/health")) {
  return json(200, { ok: true, service: "atlas-notify" }, { "Access-Control-Allow-Origin": "https://status.atlas-systems.uk" });
}
    
// API index. Lets a visitor, or you in six months, discover every
    // live endpoint under this hostname without reading source.
    // Deliberately unauthenticated and side-effect free, same spirit
    // as the health check above it.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return json(200, {
        service: "Atlas Systems API",
        generatedAt: new Date().toISOString(),
        endpoints: [
          {
            method: "POST",
            path: "/notify",
            worker: "atlas-notify",
            description: "Deliver an event into the Discord notification pipeline",
          },
          {
            method: "GET",
            path: "/notify/health",
            worker: "atlas-notify",
            description: "Liveness probe, unauthenticated",
          },
          {
            method: "GET",
            path: "/pulse",
            worker: "github-pulse",
            description: "Aggregate GitHub stats across the account, KV-cached",
          },
          {
            method: "GET",
            path: "/pulse?repo=<name>",
            worker: "github-pulse",
            description: "Stats for one repository in detail",
          },
        ],
        repos: {
          "atlas-notify": "https://github.com/AtlasReaper311/atlas-notify",
          "github-pulse": "https://github.com/AtlasReaper311/github-pulse",
        },
      });
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

    return json(200, { ok: true, dialect: auth.dialect, event: eventLabel });
  },
};

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
