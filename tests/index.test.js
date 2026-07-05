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
 * Outbound calls to Discord are intercepted with fetchMock from
 * cloudflare:test rather than hitting the network, so these tests never
 * depend on, or risk leaking, a real webhook URL.
 */
import { fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, it, expect } from "vitest";
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

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect(); // any unmocked outbound call throws loudly instead of hitting the real network
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors(); // catches a registered mock that never actually got called
});

/** Mirrors verifyGitHubSignature's own algorithm, so this proves the
 * worker correctly verifies a signature it didn't generate itself. */
async function signGitHubBody(rawBody, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mockDiscordSuccess() {
  fetchMock
    .get("https://discord.com")
    .intercept({ method: "POST", path: "/api/webhooks/test-id/test-token" })
    .reply(200, {});
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
