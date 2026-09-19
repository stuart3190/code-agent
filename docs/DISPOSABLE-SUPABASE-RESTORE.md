# Disposable Supabase restore isolation

Supabase's local stack is a development service with default credentials, no TLS and no rate
limiting. It must not be reachable from another host. CLI `2.111.0` has no host-bind option, and
the port settings in `supabase/config.toml` select numbers only; they do not change Docker's
all-interface publish address.

Thrallo therefore blocks external TCP connections whose original Docker-published destination is
`55320-55327`. The rule is in `DOCKER-USER`, before Docker's accept rules, and applies to IPv4 and
IPv6. Localhost traffic does not traverse that forwarding path and remains available. No other
port or Docker workload is affected.

Install the reversible boot-persistent guard:

```bash
sudo ops/disposable-supabase-isolation.sh install-service
sudo ops/disposable-supabase-isolation.sh status
```

Uninstall only when no disposable restore can run:

```bash
sudo /usr/local/sbin/thrallo-disposable-supabase-isolation uninstall-service
```

Before any restore, start an empty stack and capture `ss -ltnp`, `docker inspect`, both
`DOCKER-USER` chains, successful localhost probes and an independent external probe of every port.
The external probe must run from a different host or network namespace:

```powershell
./ops/Test-DisposableSupabaseExternalIsolation.ps1 `
  -HostName 51.195.136.189 -DurationSeconds 60 -OutputPath external-empty-proof.jsonl
```

Any successful external connection is a hard stop. `ops/run-isolated-restore.sh` also refuses to
run unless both firewall rules are present.

For the complete restore lifetime, retain timestamped logs from every `supabase_*` container.
Kong/API gateway access logs provide HTTP source addresses. Enable PostgreSQL connection logging
in the disposable database before restoring, and archive Docker events for the start/stop window.
Run `ops/archive-disposable-supabase-logs.sh <evidence-dir>` before stopping containers; normal
cleanup must never remove the evidence directory.

Cleanup destroys disposable containers, Docker volumes and restored filesystem namespaces, then
proves all eight ports closed locally and externally. The source production backup and the
checksummed evidence/log archive remain intact.
