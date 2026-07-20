/**
 * atlas-notify tests
 *
 * Runs inside the real Workers runtime (workerd), via
 * @cloudflare/vitest-pool-workers, not a Node simulation. That matters
 * specifically here because authenticate() uses real Web Crypto
 * (crypto.subtle) for GitHub's HMAC verification; testing against a
 * mocked crypto implementation would prove nothing about production.
 *
 * The worker's fetch(request, env, ctx) now uses ctx.waitUntil to
 * persist events to KV out-of-band, so we pass a stub ctx with a no-op
 * waitUntil. This also keeps the test signature aligned with the real
 * Workers runtime, which always provides one.
 *
 * Outbound calls to Discord are intercepted by stubbing global fetch, so
 * these tests never depend on, or risk leaking, a real webhook URL.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import worker from "../src/index.js";

// Stub ExecutionContext. waitUntil is a no-op because the promises it
// would receive (KV writes, pulse purges) are best-effort and not the
// subject of these tests; they're covered by their own integration tests.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

const TEST_TOKEN = "test-notify-token-do-not-use-in-prod";
const TEST_ENV = {
  NOTIFY_TOKEN: TEST_TOKEN,
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test-id/test-token",
};

let outboundFetch;
let expectedOutboundCalls;

beforeEach(() => {
  expectedOutboundCalls = 0;
  outboundFetch = vi.fn(async (input) => {
    throw new Error(`Unmocked outbound fetch: ${new URL(input.url ?? input)}`);
  });
  vi.stubGlobal("fetch", outboundFetch);
});

afterEach(() => {
  expect(outboundFetch).toHaveBeenCalledTimes(expectedOutboundCalls);
  vi.unstubAllGlobals();
});

/** Mirrors verifyGitHubSignature's own algorithm, so this proves the
 * worker correctly verifies a signature it didn't generate itself. */
async function signGitHubBody(rawBody, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mockDiscordSuccess(path = "/api/webhooks/test-id/test-token", captureBody) {
  expectedOutboundCalls += 1;
  outboundFetch.mockImplementationOnce(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://discord.com");
    expect(url.pathname).toBe(path);
    expect(request.method).toBe("POST");
    if (captureBody) captureBody(await request.json());
    return Response.json({}, { status: 200 });
  });
}

function makeLogEnv() {
  const store = new Map();
  return {
    env: {
      ...TEST_ENV,
      NOTIFY_LOG: {
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => store.set(key, value),
      },
    },
  };
}

function makeWaitCtx() {
  const pending = [];
  return {
    ctx: {
      waitUntil: (promise) => pending.push(promise),
      passThroughOnException: () => {},
    },
    wait: () => Promise.all(pending),
  };
}

describe("health check", () => {
  it("responds without authentication", async () => {
    const res = await worker.fetch(new Request("https://api.atlas-systems.uk/notify/health"), TEST_ENV, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "atlas-notify" });
  });
});

describe("CORS preflight", () => {
  it("answers OPTIONS /notify with 204 and allows POST", async () => {
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "OPTIONS",
        headers: { Origin: "https://atlas-systems.uk" },
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://atlas-systems.uk");
  });

  it("does not echo an Allow-Origin for an untrusted origin", async () => {
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("envelope dialect (Bearer token)", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        body: JSON.stringify({ source: "alert", level: "info", title: "x" }),
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
        body: JSON.stringify({ source: "alert", level: "info", title: "x" }),
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("accepts a correct token and routes an alert through to Discord", async () => {
    mockDiscordSuccess();
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ source: "alert", level: "success", title: "Deploy finished" }),
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dialect: "envelope", event: "alert" });
  });

  it("persists persist_only alerts to the recent feed without Discord", async () => {
    const { env } = makeLogEnv();
    const waitCtx = makeWaitCtx();
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({
          source: "alert",
          level: "success",
          title: "Deployed: ramone-edge",
          message: "Deployed to production [abc1234]",
          persist_only: true,
        }),
      }),
      env,
      waitCtx.ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dialect: "envelope", event: "alert", persisted: true });
    await waitCtx.wait();

    const recent = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify/recent?limit=5&level=success"),
      env,
      waitCtx.ctx,
    );
    const body = await recent.json();
    expect(body.events[0]).toMatchObject({
      level: "success",
      title: "Deployed: ramone-edge",
      message: "Deployed to production [abc1234]",
    });
  });
});

describe("GitHub dialect (HMAC)", () => {
  it("rejects a request missing the signature header", async () => {
    const body = JSON.stringify({ zen: "test", repository: { full_name: "x/y" } });
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { "X-GitHub-Event": "ping" },
        body,
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request with an invalid signature", async () => {
    const body = JSON.stringify({ zen: "test", repository: { full_name: "x/y" } });
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=0000" },
        body,
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("accepts a correctly signed ping event", async () => {
    mockDiscordSuccess();
    const body = JSON.stringify({ zen: "Speak like a human.", repository: { full_name: "AtlasReaper311/atlas-notify" } });
    const signature = await signGitHubBody(body, TEST_TOKEN);
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": signature },
        body,
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dialect: "github", event: "github:ping" });
  });
});

describe("Cloudflare dialect (header equality)", () => {
  it("rejects a mismatched cf-webhook-auth header", async () => {
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { "cf-webhook-auth": "wrong-value" },
        body: JSON.stringify({ name: "test", text: "deploy success" }),
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("accepts a matching header, including a plain-text verification ping", async () => {
    mockDiscordSuccess();
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { "cf-webhook-auth": TEST_TOKEN },
        body: "verification ping, not JSON",
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dialect: "cloudflare", event: "cloudflare" });
  });
});

describe("request validation", () => {
  it("rejects malformed JSON on the envelope dialect", async () => {
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        body: "{not valid json",
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a GET to /notify itself", async () => {
    const res = await worker.fetch(new Request("https://api.atlas-systems.uk/notify"), TEST_ENV, ctx);
    expect(res.status).toBe(405);
  });

  it("rejects a body over the 64 KB limit", async () => {
    const huge = "x".repeat(70 * 1024);
    const res = await worker.fetch(
      new Request("https://api.atlas-systems.uk/notify", {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, "content-length": String(huge.length) },
        body: huge,
      }),
      TEST_ENV,
      ctx,
    );
    expect(res.status).toBe(413);
  });
});

describe("signal-class channel routing (v1.1.0)", () => {
  // The routing table lives in src/index.js as CLASS_WEBHOOK_SECRETS.
  // These tests prove three things: a configured class reaches its own
  // webhook, an unconfigured class degrades to the default webhook, and
  // a classed alert renders through the generic alert formatter rather
  // than the "Unrecognised source" warning path.
  const ROUTED_ENV = {
    ...TEST_ENV,
    INFRA_HEALTH_WEBHOOK_URL:
      "https://discord.com/api/webhooks/infra-id/infra-token",
    RAG_QUERIES_WEBHOOK_URL:
      "https://discord.com/api/webhooks/rag-id/rag-token",
    RAMONE_WEBHOOK_URL:
      "https://discord.com/api/webhooks/ramone-id/ramone-token",
  };

  function envelope(body) {
    return new Request("https://api.atlas-systems.uk/notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("routes signal_class infra_health to its dedicated webhook", async () => {
    let captured = null;
    mockDiscordSuccess("/api/webhooks/infra-id/infra-token", (body) => {
      captured = body;
    });

    const res = await worker.fetch(
      envelope({
        source: "alert",
        signal_class: "infra_health",
        level: "warning",
        title: "WSL2 IP drift detected",
        message: "eth0 moved; downstream .env files may be stale",
        fields: { previous: "172.20.1.5", current: "172.20.9.2" },
      }),
      ROUTED_ENV,
      ctx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event).toBe("infra_health");
    // Rendered by the alert formatter: the title survives verbatim,
    // which the unrecognised-source path would not preserve.
    expect(captured.embeds[0].title).toBe("WSL2 IP drift detected");
  });

  it("routes signal_class rag_queries to its dedicated webhook", async () => {
    mockDiscordSuccess("/api/webhooks/rag-id/rag-token");

    const res = await worker.fetch(
      envelope({
        source: "alert",
        signal_class: "rag_queries",
        level: "info",
        title: "RAG queries, last hour",
        message: "7 queries",
        fields: { top_terms: "tunnel, portproxy, ollama" },
      }),
      ROUTED_ENV,
      ctx,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).event).toBe("rag_queries");
  });

  it("falls back to the default webhook when the class secret is unset", async () => {
    mockDiscordSuccess(); // default webhook interceptor
    const res = await worker.fetch(
      envelope({
        source: "alert",
        signal_class: "infra_health",
        level: "failure",
        title: "fallback path",
        message: "no INFRA_HEALTH_WEBHOOK_URL configured",
      }),
      TEST_ENV, // deliberately missing the class secret
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).event).toBe("infra_health");
  });

  it("keeps ramone routing intact (regression)", async () => {
    mockDiscordSuccess("/api/webhooks/ramone-id/ramone-token");

    const res = await worker.fetch(
      envelope({
        signal_class: "ramone",
        level: "info",
        title: "ramone event",
        message: "still on its own channel",
      }),
      ROUTED_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).event).toBe("ramone");
  });
});

describe("estate pipeline channels and failure mirror (v1.2.0)", () => {
  // Adds the pipeline routing classes and the failure mirror: any failure
  // is copied to the alerts channel so one phone push covers the estate,
  // while the topical channel still keeps the full history. The mirror is
  // deduped against the primary webhook and never fires on success.
  const PIPE_ENV = {
    ...TEST_ENV,
    CICD_WEBHOOK_URL: "https://discord.com/api/webhooks/cicd-id/cicd-token",
    API_DEPLOY_WEBHOOK_URL:
      "https://discord.com/api/webhooks/apidep-id/apidep-token",
    ALERTS_WEBHOOK_URL:
      "https://discord.com/api/webhooks/alerts-id/alerts-token",
  };

  function envelope(body) {
    return new Request("https://api.atlas-systems.uk/notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("routes signal_class cicd to the ci-cd webhook", async () => {
    mockDiscordSuccess("/api/webhooks/cicd-id/cicd-token");
    const res = await worker.fetch(
      envelope({
        source: "alert",
        signal_class: "cicd",
        level: "success",
        title: "CI passed: atlas-api-public",
      }),
      PIPE_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).event).toBe("cicd");
  });

  it("mirrors a failure to the alerts channel and its topical channel", async () => {
    // Order proves the primary is posted first, then the mirror.
    mockDiscordSuccess("/api/webhooks/apidep-id/apidep-token");
    mockDiscordSuccess("/api/webhooks/alerts-id/alerts-token");
    const res = await worker.fetch(
      envelope({
        source: "alert",
        signal_class: "api_deploy",
        level: "failure",
        title: "Deploy failed: github-pulse",
      }),
      PIPE_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    // afterEach asserts both outbound calls (topical + mirror) happened.
  });

  it("does not mirror a success", async () => {
    mockDiscordSuccess("/api/webhooks/apidep-id/apidep-token");
    const res = await worker.fetch(
      envelope({
        source: "alert",
        signal_class: "api_deploy",
        level: "success",
        title: "Deploy ok: github-pulse",
      }),
      PIPE_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    // Single outbound call (no mirror) enforced by afterEach.
  });

  it("does not double-post a failure already on the alerts channel", async () => {
    mockDiscordSuccess("/api/webhooks/alerts-id/alerts-token");
    const res = await worker.fetch(
      envelope({
        source: "alert",
        signal_class: "alerts",
        level: "failure",
        title: "already on alerts",
      }),
      PIPE_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    // Deduped: single outbound call enforced by afterEach.
  });
});

describe("GitHub event routing (v1.3.0)", () => {
  const GH_ENV = {
    ...TEST_ENV,
    DEPS_SECURITY_WEBHOOK_URL:
      "https://discord.com/api/webhooks/deps-id/deps-token",
    REVIEWS_WEBHOOK_URL: "https://discord.com/api/webhooks/rev-id/rev-token",
  };

  async function ghRequest(event, payload) {
    const body = JSON.stringify(payload);
    const signature = await signGitHubBody(body, TEST_TOKEN);
    return new Request("https://api.atlas-systems.uk/notify", {
      method: "POST",
      headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": signature },
      body,
    });
  }

  it("routes a dependabot_alert to the deps_security channel", async () => {
    let captured = null;
    mockDiscordSuccess("/api/webhooks/deps-id/deps-token", (b) => {
      captured = b;
    });
    const res = await worker.fetch(
      await ghRequest("dependabot_alert", {
        action: "created",
        alert: {
          dependency: { package: { name: "lodash" } },
          security_vulnerability: { severity: "high" },
          security_advisory: { summary: "Prototype pollution" },
          html_url: "https://github.com/x/y/security/dependabot/1",
        },
        repository: { full_name: "AtlasReaper311/x" },
      }),
      GH_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(captured.embeds[0].title).toContain("Dependabot alert created");
  });

  it("routes an opened issue to the reviews channel", async () => {
    mockDiscordSuccess("/api/webhooks/rev-id/rev-token");
    const res = await worker.fetch(
      await ghRequest("issues", {
        action: "opened",
        issue: {
          number: 7,
          title: "Bug",
          user: { login: "atlas" },
          html_url: "https://github.com/x/y/issues/7",
        },
        repository: { full_name: "AtlasReaper311/x" },
      }),
      GH_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("routes a review request to the reviews channel", async () => {
    mockDiscordSuccess("/api/webhooks/rev-id/rev-token");
    const res = await worker.fetch(
      await ghRequest("pull_request", {
        action: "review_requested",
        pull_request: {
          number: 3,
          title: "Feature",
          user: { login: "atlas" },
          html_url: "https://github.com/x/y/pull/3",
        },
        repository: { full_name: "AtlasReaper311/x" },
      }),
      GH_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("routes a dependabot pull request to the deps_security channel", async () => {
    mockDiscordSuccess("/api/webhooks/deps-id/deps-token");
    const res = await worker.fetch(
      await ghRequest("pull_request", {
        action: "opened",
        pull_request: {
          number: 9,
          title: "bump lodash",
          user: { login: "dependabot[bot]" },
          html_url: "https://github.com/x/y/pull/9",
        },
        repository: { full_name: "AtlasReaper311/x" },
      }),
      GH_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("leaves a push event on the default channel", async () => {
    mockDiscordSuccess();
    const res = await worker.fetch(
      await ghRequest("push", {
        ref: "refs/heads/main",
        head_commit: {
          id: "abc1234",
          message: "do things",
          url: "https://github.com/x/y/commit/abc1234",
        },
        repository: { full_name: "AtlasReaper311/x" },
        pusher: { name: "atlas" },
      }),
      GH_ENV,
      ctx,
    );
    expect(res.status).toBe(200);
  });
});

describe("reliability signal class (v1.2.0)", () => {
  // The producer (atlas-api-public's evaluator) owns deduplication,
  // cooldown, and storm suppression; these tests prove the router side:
  // a dedicated channel when configured, default-webhook degradation when
  // not, a bespoke formatter that keeps wide fields readable, and the
  // failure mirror that gives the alerts channel its single phone push.
  const RELIABILITY_ENV = {
    ...TEST_ENV,
    RELIABILITY_WEBHOOK_URL:
      "https://discord.com/api/webhooks/reliability-id/reliability-token",
  };

  function reliabilityEnvelope(overrides = {}) {
    return new Request("https://api.atlas-systems.uk/notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        source: "alert",
        signal_class: "reliability",
        level: "warning",
        title: "Reliability: atlas-notify is budget at risk",
        message: "fast burn rate 2.78 is at or above the risk threshold",
        fields: {
          service: "atlas-notify",
          objective: "atlas-notify-availability-30d",
          from_state: "objective_met",
          to_state: "budget_at_risk",
          remaining_budget: "0.8634",
          fast_burn: "2.78",
          slow_burn: "0.56",
          runbook: "atlas-infra/docs/runbooks/reliability-budget-exhausted.md",
          dedup_key:
            "reliability:atlas-notify:atlas-notify-availability-30d:objective_met->budget_at_risk:2026-07-19",
        },
        ...overrides,
      }),
    });
  }

  it("routes to the dedicated webhook and renders the bespoke formatter", async () => {
    let captured = null;
    mockDiscordSuccess("/api/webhooks/reliability-id/reliability-token", (body) => {
      captured = body;
    });

    const res = await worker.fetch(reliabilityEnvelope(), RELIABILITY_ENV, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).event).toBe("reliability");

    const embed = captured.embeds[0];
    expect(embed.title).toBe("Reliability: atlas-notify is budget at risk");
    const runbook = embed.fields.find((field) => field.name === "runbook");
    expect(runbook.inline).toBe(false);
    expect(runbook.value).toMatch(/reliability-budget-exhausted\.md$/);
    const service = embed.fields.find((field) => field.name === "service");
    expect(service.inline).toBe(true);
  });

  it("degrades to the default webhook when the class secret is unset", async () => {
    mockDiscordSuccess();
    const res = await worker.fetch(reliabilityEnvelope(), TEST_ENV, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).event).toBe("reliability");
  });

  it("mirrors a failure-level reliability event to the alerts channel", async () => {
    const env = {
      ...RELIABILITY_ENV,
      ALERTS_WEBHOOK_URL:
        "https://discord.com/api/webhooks/alerts-id/alerts-token",
    };
    mockDiscordSuccess("/api/webhooks/reliability-id/reliability-token");
    mockDiscordSuccess("/api/webhooks/alerts-id/alerts-token");

    const waitCtx = makeWaitCtx();
    const res = await worker.fetch(
      reliabilityEnvelope({
        level: "failure",
        title: "Reliability: atlas-notify is budget exhausted",
      }),
      env,
      waitCtx.ctx,
    );
    expect(res.status).toBe(200);
    await waitCtx.wait();
  });
});
