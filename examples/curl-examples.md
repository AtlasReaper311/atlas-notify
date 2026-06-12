# Sending events to atlas-notify

Every example targets production. For local testing, run `npx wrangler dev`
and swap the URL for `http://localhost:8787/notify`.

Set the token once per shell:

```bash
# bash / WSL
export NOTIFY_TOKEN="paste-from-proton-pass"
```

```powershell
# PowerShell
$env:NOTIFY_TOKEN = "paste-from-proton-pass"
```

---

## Pages deploy (`payloads/pages-deploy.json`)

```bash
curl -sS -X POST "https://api.atlas-systems.uk/notify" \
  -H "Authorization: Bearer $NOTIFY_TOKEN" \
  -H "Content-Type: application/json" \
  --data @payloads/pages-deploy.json
```

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.atlas-systems.uk/notify" `
  -Headers @{ Authorization = "Bearer $env:NOTIFY_TOKEN" } `
  -ContentType "application/json" `
  -Body (Get-Content payloads/pages-deploy.json -Raw)
```

## Docker health change (`payloads/docker-health.json`)

```bash
curl -sS -X POST "https://api.atlas-systems.uk/notify" \
  -H "Authorization: Bearer $NOTIFY_TOKEN" \
  -H "Content-Type: application/json" \
  --data @payloads/docker-health.json
```

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.atlas-systems.uk/notify" `
  -Headers @{ Authorization = "Bearer $env:NOTIFY_TOKEN" } `
  -ContentType "application/json" `
  -Body (Get-Content payloads/docker-health.json -Raw)
```

For live container events, see `docker-health-watcher.sh` in this folder.

## GitHub push, envelope dialect (`payloads/github-push.json`)

Use this shape when one of your own scripts reports a push. Real GitHub
webhooks should point at the endpoint directly instead; the Worker
verifies their HMAC signature natively (README, "Wiring sources").

```bash
curl -sS -X POST "https://api.atlas-systems.uk/notify" \
  -H "Authorization: Bearer $NOTIFY_TOKEN" \
  -H "Content-Type: application/json" \
  --data @payloads/github-push.json
```

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.atlas-systems.uk/notify" `
  -Headers @{ Authorization = "Bearer $env:NOTIFY_TOKEN" } `
  -ContentType "application/json" `
  -Body (Get-Content payloads/github-push.json -Raw)
```

## Generic alert (`payloads/generic-alert.json`)

The catch-all for anything else in the stack. `level` selects the embed
colour: `success`, `failure`, `warning`, or `info`.

```bash
curl -sS -X POST "https://api.atlas-systems.uk/notify" \
  -H "Authorization: Bearer $NOTIFY_TOKEN" \
  -H "Content-Type: application/json" \
  --data @payloads/generic-alert.json
```

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.atlas-systems.uk/notify" `
  -Headers @{ Authorization = "Bearer $env:NOTIFY_TOKEN" } `
  -ContentType "application/json" `
  -Body (Get-Content payloads/generic-alert.json -Raw)
```

## Health check

```bash
curl -sS "https://api.atlas-systems.uk/notify/health"
```

Returns `{"ok":true,"service":"atlas-notify"}`. Point Uptime Kuma at this.

## Expected responses

| Status | Meaning |
|---|---|
| `200` | Delivered to Discord |
| `400` | Body is not valid JSON |
| `401` | Token or signature failed |
| `405` | Non-POST to /notify |
| `413` | Body over 64 KB |
| `500` | A secret is missing on the Worker |
| `502` | Discord rejected the forward (check `Retry-After`) |
