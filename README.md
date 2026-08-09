# Knowtes Jarvis Worker

Cloudflare Worker for authenticated voice transcription and Knowte generation.

Requires Node.js 22 or newer.

## Local checks

```bash
npm ci
npx tsc --noEmit
npx wrangler deploy --dry-run
```

Copy `.dev.vars.example` to `.dev.vars` for local development. In Cloudflare,
store `ANTHROPIC_API_KEY` and `JARVIS_TOKEN_SECRET` as encrypted secrets. The
same `JARVIS_TOKEN_SECRET` must be configured in the Knowtes backend.

`GET /health` returns 200 only when required bindings and secrets exist.
