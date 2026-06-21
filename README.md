<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# atlas-notify
 
```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // atlas-notify              │
│  one endpoint in, one Discord channel out   │
└─────────────────────────────────────────────┘
```

[![CI](https://github.com/AtlasReaper311/atlas-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/AtlasReaper311/atlas-notify/actions)
![Cloudflare Worker](https://img.shields.io/badge/cloudflare-worker-f5a623?style=flat-square&labelColor=0a0a0f)
![Runtime](https://img.shields.io/badge/runtime-workers-4ade80?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

Centralised event router for the Atlas Systems stack. Services POST events to one authenticated endpoint; this Worker normalises them into colour-coded Discord embeds and forwards them to a single webhook.

```
Pages deploys ─┐
GitHub pushes ─┤
Docker health ─┼──▶  api.atlas-systems.uk/notify  ──▶  Discord #push-log
Anything else ─┘         (auth, validate, format)
```

Green for success, red for failure, amber for warnings, grey for neutral events. Unknown but authenticated events still get delivered as amber embeds; the router's job is visibility, not gatekeeping.

## Inbound dialects

One `NOTIFY_TOKEN` secret authenticates three different calling styles, so native webhooks plug in without adapter scripts.

| Dialect | Detected by | Verified with |
|---|---|---|
| Atlas envelope | JSON body with a `source` field | `Authorization: Bearer <token>` |
| GitHub webhook | `X-GitHub-Event` header | HMAC SHA-256 over the raw body (`X-Hub-Signature-256`) |
| Cloudflare notification | `cf-webhook-auth` header | Header equality check |

Envelope sources currently formatted: `pages_deploy`, `docker_health`, `github_push`, `alert`. The `alert` source is the catch-all: any service can report anything with a `level` of `success`, `failure`, `warning`, or `info`. Payload shapes live in [`examples/payloads/`](examples/payloads/).

## Prerequisites

- Node 22+ and `npx` (wrangler runs through it, no global install; the test toolchain specifically requires 22+)
- A Cloudflare account holding the `atlas-systems.uk` zone
- A Discord server where you can create a webhook
- A proxied DNS record for `api.atlas-systems.uk` (Setup, step one)

## Setup

1. **Route the api subdomain.** Worker routes only intercept traffic that resolves through the Cloudflare proxy, so the hostname needs a proxied record. In the Cloudflare dashboard: DNS, add record, type `AAAA`, name `api`, content `100::`, proxy status on. `100::` is the IPv6 discard prefix; the Worker answers before any origin is contacted, so the record exists only to give the proxy something to resolve.

   A single Worker route only ever claims the exact pattern it's given; `api.atlas-systems.uk/notify*` claims that one path, nothing else. Adding a new top-level path later (like the index route below) means adding a second, broader route, `api.atlas-systems.uk/*`, in **both** the Cloudflare dashboard and `wrangler.toml`. Wrangler treats the config file as the absolute source of truth on every deploy, so a route that exists only in the dashboard gets silently deleted the next time anyone runs `wrangler deploy`.

2. **Create the Discord webhook.** Server settings, Integrations, Webhooks, New Webhook. Pick the channel, copy the URL.

3. **Generate the shared token** and store it in Proton Pass:

   ```bash
   openssl rand -hex 32
   ```

4. **Install and deploy:**

   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put DISCORD_WEBHOOK_URL
   npx wrangler secret put NOTIFY_TOKEN
   npx wrangler deploy
   ```

5. **Send a test event:**

   ```bash
   export NOTIFY_TOKEN="the-token-you-generated"
   curl -sS -X POST "https://api.atlas-systems.uk/notify" \
     -H "Authorization: Bearer $NOTIFY_TOKEN" \
     -H "Content-Type: application/json" \
     --data @examples/payloads/generic-alert.json
   ```

   An amber embed should appear in Discord within a second.

## Usage

Full bash and PowerShell examples for every event type live in [`examples/curl-examples.md`](examples/curl-examples.md).

| Method and path | Purpose |
|---|---|
| `GET /` | Self-documenting JSON index of every live Atlas Systems endpoint |
| `POST /notify` | Deliver an event |
| `GET /notify/health` | Liveness probe (no auth) |

Responses: `200` delivered, `400` invalid JSON, `401` auth failed, `405` wrong method, `413` body over 64 KB, `500` missing secret, `502` Discord rejected the forward (`Retry-After` passed through).

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npx wrangler dev                 # serves http://localhost:8787
```

## Testing

```bash
npm test
```

Tests run inside the real Workers runtime via [`@cloudflare/vitest-pool-workers`](https://www.npmjs.com/package/@cloudflare/vitest-pool-workers), not a Node simulation, which matters specifically for `verifyGitHubSignature`: it calls real Web Crypto, so a passing test here is a guarantee about production behaviour, not an approximation of one.

Coverage focuses on the security-critical layer: every authentication dialect (Bearer token, GitHub HMAC, Cloudflare header) is proven on both its accept and reject path, plus request validation (oversized bodies, malformed JSON, wrong methods). Full formatter coverage for every envelope source (`pages_deploy`, `docker_health`, `github_push`) is a deliberate next step, not a gap in what's here; today's suite proves the layer where a silent bug would actually be dangerous.

CI runs this suite on every push to `main` and reports its own result into Discord, success or failure, using this repo's own `COLOURS` constants. The router that decides what colour an event should be reports on itself using its own rules.

## Wiring sources

**GitHub repos.** Repo settings, Webhooks, Add webhook. Payload URL `https://api.atlas-systems.uk/notify`, content type `application/json`, secret set to your `NOTIFY_TOKEN`, events: pushes. GitHub signs every delivery and the Worker verifies the signature natively. The ping event on save shows up as a green "Webhook connected" embed.

**Cloudflare Pages deploys.** Cloudflare dashboard, Notifications, Add, pick the Pages events, destination Webhooks, URL as above with secret `NOTIFY_TOKEN`. Cloudflare sends a verification request on save; the Worker accepts it and posts an info embed.

**Docker containers.** Run [`examples/docker-health-watcher.sh`](examples/docker-health-watcher.sh) on the container host. It streams `docker events` health changes into the endpoint. Uptime Kuma can also POST here directly with a custom webhook body using the `alert` envelope.

**Your own scripts.** POST an `alert` envelope. Four fields, done.

## How it fits into Atlas Systems

Every other service in the stack treats this Worker as its event bus. [`github-pulse`](https://github.com/AtlasReaper311/github-pulse) reports upstream GitHub failures here; [`ollama-rag-kit`](https://github.com/AtlasReaper311/ollama-rag-kit) reports ingest errors and startup; CI and deploy hooks land here as they come online. One endpoint, one channel, one place to look.

The transferable pattern is fan-in: producers stay simple because the single consumer owns formatting, authentication, and delivery.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
