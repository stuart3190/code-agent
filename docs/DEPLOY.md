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
```

`@openai/codex` is pinned in the root production dependencies. The server uses its app-server
protocol for device sign-in; user authentication state is encrypted with `PLATFORM_ENC_KEY`.
Never copy a developer's local Codex login into production.

## Verification

```sh
sudo systemctl status thrallo-shell
curl -fsS http://10.83.7.1:8788/api/health
curl -fsS http://10.83.7.1:8788/api/v1/capabilities
curl -fsS https://app.thrallo.com/api/v1/capabilities
```

After a code or environment update, rebuild the web application and restart only
`thrallo-shell`. Do not restart Buildr101 services for a Thrallo-only change.
