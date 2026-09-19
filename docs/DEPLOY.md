# Thrallo production deployment

Thrallo shares the Buildr101 VPS but not its application directory, service, port, environment,
database, or credentials.

Initial production installation, DNS activation, and TLS issuance completed on 2026-07-29.

## Topology

- Repository: `/home/ubuntu/code-agent`
- Web and API service: `thrallo-shell.service`
- Private listener: `10.83.7.1:8788`
- Public application: `https://app.thrallo.com`
- Apex and `www`: redirect to `https://app.thrallo.com`
- Reverse proxy: the existing `buildr-caddy` container
- Database and authentication: dedicated Supabase project `zczgvcsokfafuyognvwx`

Buildr101 remains on port `8787`; Thrallo uses `8788`.
The tracked service definition is `ops/thrallo-shell.service`; the tracked proxy site definition is
`ops/Caddyfile.thrallo`.

## Secret custody

Production secrets live only in `/home/ubuntu/code-agent/shell/.env`, owned by `ubuntu` with mode
`600`. Browser configuration lives in `/home/ubuntu/code-agent/shell/web/.env` and contains only
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The legacy
`VITE_SUPABASE_ANON_KEY` name remains a fallback during key migration. Neither file is shipped
through Git, and service-role/secret keys must never be added to the web environment.

Required production overrides:

```dotenv
SHELL_PORT=8788
SHELL_HOST=10.83.7.1
APP_URL=https://app.thrallo.com
CODE_AGENT_STANDALONE=on
CODE_AGENT_STORE=supabase
CODE_AGENT_WORKER=on
PLATFORM_ENC_KEY=<32 random bytes encoded as 64 hex characters>
CODE_AGENT_EMBEDDING_MODEL=text-embedding-3-small
CODE_AGENT_INDEX_MAX_FILES=600
CODE_AGENT_INDEX_MAX_BYTES=10000000
CODE_AGENT_INDEX_MAX_FILE_BYTES=350000
CODE_AGENT_INDEX_POLL_MS=2500
```

`@openai/codex` is pinned in the root production dependencies. The server uses its app-server
protocol for device sign-in; user authentication state is encrypted with `PLATFORM_ENC_KEY`.
Never copy a developer's local Codex login into production.

The same encryption key protects repository paths and source excerpts and derives scoped HMAC
blind indexes. `OPENAI_API_KEY` enables semantic embeddings; if embedding generation is temporarily
unavailable, agent runs continue with live workspace tools and exact lookup remains available for
an already-built index.

## Verification

```sh
sudo systemctl status thrallo-shell
curl -fsS http://10.83.7.1:8788/api/health
curl -fsS http://10.83.7.1:8788/api/v1/capabilities
curl -fsS https://app.thrallo.com/api/v1/capabilities
```

After a code or environment update, build the release web application with the fail-closed auth
gate. For a V2-only production release, activate the validated deployment manifest, pin the
compatible immutable sandbox through `ops/pin-build-sandbox-image.mjs`, then restart both runtime
consumers of that release identity:

```sh
npm run build:web:production
sudo systemctl restart thrallo-build-worker thrallo-shell
npm run worker:release:verify
node --env-file=shell/.env --env-file=shell/web/.env scripts/smoke-production.mjs \
  --origin https://app.thrallo.com
```

The production build and post-deploy smoke both fail if the public URL/key are absent, the key is
privileged, the deployed assets do not contain the expected public configuration, Supabase Auth
rejects it, or a public environment path exposes credentials. Do not restart Buildr101 services
for a Thrallo-only change.

Install both locked packages before rebuilding: `npm ci` at the repository root, followed by
`npm --prefix shell/web ci`. The web application has its own lockfile and a clean checkout has no
Vite binary until that second install runs. The legacy shell still imports its QA runner at
startup, so `npm ci --omit=dev` is not currently a valid production install.

Initial worker installation and sandbox replacement remain approval-gated in
`docs/BUILD-WORKER-DEPLOYMENT.md`. Once V2-only is active, an ordinary source release must not
restart only the shell: shell admission and the worker both consume the newly activated manifest,
and the zero-model worker release gate must pass before the deployment is called green.
