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
the Supabase URL and publishable key. Neither file is shipped through Git.

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

After a code or environment update, rebuild the web application and restart only
`thrallo-shell`. Do not restart Buildr101 services for a Thrallo-only change.

Use the full root lockfile install (`npm ci`) before restart. The legacy shell still imports its QA
runner at startup, so `npm ci --omit=dev` is not currently a valid production install.
