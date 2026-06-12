#!/usr/bin/env bash
#
# docker-health-watcher.sh
#
# Streams Docker health_status events into atlas-notify as docker_health
# envelopes. Run it on the machine that hosts your containers (for the
# Atlas stack that is WSL2 on SPECULAR-CORE):
#
#   NOTIFY_TOKEN=... ./docker-health-watcher.sh
#
# Runs until interrupted. For something permanent, wrap it in a systemd
# user service or a tmux session; it is intentionally a thin pipe, not a
# daemon, so there is nothing to install or upgrade.

set -euo pipefail

NOTIFY_URL="${NOTIFY_URL:-https://api.atlas-systems.uk/notify}"

if [[ -z "${NOTIFY_TOKEN:-}" ]]; then
  echo "NOTIFY_TOKEN is not set. Export it or prefix the command." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (sudo apt install jq)." >&2
  exit 1
fi

echo "Watching Docker health events -> ${NOTIFY_URL}"

# --format keeps the stream as one JSON object per line, which jq turns
# into the envelope shape atlas-notify expects. Docker only emits the new
# state in health events, so old_state is reported as unknown.
docker events \
  --filter 'event=health_status' \
  --format '{{json .}}' |
while read -r event; do
  payload=$(jq -c '{
    source: "docker_health",
    container: .Actor.Attributes.name,
    old_state: "unknown",
    new_state: (.Action | sub("health_status: "; "")),
    host: "'"$(hostname)"'"
  }' <<<"$event")

  # Fire and forget: a notify outage should never stall the watcher loop.
  curl -sS -o /dev/null -X POST "$NOTIFY_URL" \
    -H "Authorization: Bearer ${NOTIFY_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload" || echo "warn: failed to deliver event" >&2
done
