# Why this exists

## Context

The Atlas stack generates events in four or five places: Cloudflare
Pages deploys, GitHub pushes, Docker container health on SPECULAR-CORE,
and ad hoc script failures. Each source has its own native notification
mechanism, which means either configuring four separate Discord
integrations with four different payload formats, or having no unified
view at all. The stack needed one place where everything lands.

## Options considered

**Discord webhooks per source.** Zero code. Also zero consistency: each
integration formats differently, secrets multiply, and adding a source
means dashboard work in a different product every time.

**A self-hosted router on SPECULAR-CORE.** Full control, but the
machine that hosts the containers being monitored cannot also be the
thing that reports them down. The notifier has to live off-box.

**A Cloudflare Worker.** Always on, free tier covers it many times
over, no server to patch, and it lives on infrastructure that fails
independently of the home machine. The trade-off is the Workers
runtime: no Node built-ins, Web Crypto only. For HMAC verification and
JSON reshaping, that constraint costs nothing.

## Decision

A single Worker at `api.atlas-systems.uk/notify` accepting three
dialects on one shared secret: an explicit Atlas envelope for anything
self-built, native GitHub webhooks verified by HMAC signature, and
native Cloudflare notifications verified by header. Native dialects
matter because the alternative is adapter scripts, and every adapter is
another thing that silently breaks.

Two behaviours were chosen deliberately. Unknown-but-authenticated
sources get delivered as warning embeds instead of rejected, because a
notifier that drops unrecognised events recreates the blind spot it
exists to remove. And formatter exceptions degrade to a raw fallback
embed, because a formatting bug should cost prettiness, not visibility.

## Consequences

Adding a new event source is now one of: point a native webhook at the
endpoint, or POST a four-field `alert` envelope. No new secrets, no new
integrations, no dashboard archaeology. The cost is that the Worker is
a single point of failure for notifications; acceptable, because it
runs on Cloudflare's edge and its failure mode (silence) is the same as
not having built it.

The transferable principle: when several systems need to talk to one
sink, put an anti-corruption layer at the boundary and let it own
authentication, normalisation, and delivery. Producers stay trivial,
and the messy translation logic lives in exactly one place.
