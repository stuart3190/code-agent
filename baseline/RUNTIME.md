# RUNTIME.md — Phase 4 Container Preview Baseline

_Recorded 2026-06-30 · VPS: 4 vCPU / 7.6 GB RAM / Docker 29.6 · node:22-alpine_

## 1. Hardware + Docker config

| | |
|---|---|
| CPU | 4 vCores |
| RAM | 7.6 GB total, ~6.3 GB available |
| Swap | none |
| Docker | 29.6.1 (root Docker, cgroup v2, overlayfs storage) |
| Base image | node:22-alpine (230 MB compressed) |
| Public IP | 51.195.136.189 |
| Subdomain DNS | `*.<hex>.nip.io` via nip.io hex-IP format (hex of 51.195.136.189 = 33c388bd) |

## 2. Architecture

```
browser → spike-proj-N.33c388bd.nip.io:80
        → nginx:alpine container (-p 80:80)
        → per-project --internal Docker bridge network
        → app container (node:22-alpine, Vite dev server :5173)
```

**Network topology:**
- `spike-preview-net` (non-internal bridge) — nginx only. **Docker silently ignores `-p`
  port publishing when the container is solely on `--internal` networks** — the host port
  never binds. Fix: nginx must be on at least one non-internal network for `-p 80:80` to work.
- `spike-proj-N-net` (--internal bridge) — each app container + nginx (connected via
  `docker network connect` after nginx starts). nginx reaches each app via Docker DNS;
  app containers cannot reach the internet or each other (different isolated networks).

**HMR traps and mitigations (all confirmed live):**

| Trap | Mitigation |
|---|---|
| Vite 5 rejects unknown Host headers | `server.allowedHosts: "all"` in vite.config |
| Browser HMR WS connects to wrong port | `server.hmr.clientPort: 80` (the proxy port) |
| nginx drops WebSocket Upgrade header | `proxy_set_header Upgrade $http_upgrade; Connection "upgrade"` |
| nginx resolves container hostnames at startup only | `resolver 127.0.0.11 valid=30s` + variable in `proxy_pass` |
| Long-idle HMR connection drops | `proxy_read_timeout 86400` |
| Vite 5 ignores upgrades without subprotocol | Forward `Sec-WebSocket-Protocol: vite-hmr` via nginx |

**vite.config.js** is NOT baked into the image — the entrypoint writes it from env vars
(`VITE_HOST`, `VITE_CLIENT_PORT`) so one image serves all projects.

**Container isolation hardening:**

```
--cap-drop ALL                    # bounding set = 0; root inside can't gain caps
--security-opt no-new-privileges  # no setuid/setgid escalation
--user node                       # uid 1000, not root
--memory 512m --memory-swap 512m  # hard RAM cap
--cpus 1.0                        # hard CPU cap (1 core)
--pids-limit 200                  # fork bomb prevention
--tmpfs /tmp:size=256m            # Vite cache in-memory, no host FS write
```

## 3. HMR proof

| Check | Result |
|---|---|
| HTTP 200 from Vite via nginx | PASS |
| WebSocket 101 Switching Protocols via nginx | PASS |
| File edit inside container → HMR rebuild in Vite log | PASS |

Proof method (VPS has no GUI browser):
1. `curl` with WebSocket upgrade headers → nginx → Vite returns **101** (WS handshake accepted).
2. `docker exec` writes a comment to `/app/src/App.jsx` inside the container; Vite's inotify
   watcher detects it; `docker logs` confirms `[vite] hmr update`.
Together these prove the full chain: subdomain → proxy → Vite HMR → browser-ready payload.

## 4. Isolation evidence

| Assertion | Test | Result |
|---|---|---|
| Host filesystem invisible | `ls /home/ubuntu` → No such file or directory | PASS |
| No internet egress | `wget http://1.1.1.1` → Network unreachable | PASS |
| Cannot reach peer container | DNS / connect for adjacent container → fails | PASS |
| Non-root user | `id` → uid=1000(node) | PASS |
| Zero capability bounding set | `CapBnd: 0000000000000000` | PASS |

**Known limitation (spike scope):** nginx is connected to all project networks, so a container
that sends an HTTP request to nginx with a foreign `Host:` header could pivot to a sibling
project's container. Phase 4 mitigation: per-project nginx instances or request authentication.

Isolation is Docker-level (namespaces + cgroups + cap-drop). Rootless Docker (Phase 4
hardening) adds UID remapping on top; root Docker + these flags is the spike baseline.

## 5. Resource measurements

### Idle (Vite listening, no active browser)

| Container | RSS | CPU% | PIDs |
|---|---|---|---|
| spike-proj-1 | 120.9 MiB | 18.8% | 30 |
| spike-proj-2 | 116.9 MiB | 0.1% | 29 |
| spike-proj-3 | 116.5 MiB | 8.5% | 29 |
| **Average** | **118.1 MiB** | **18.8%** | |

### Active RAM (HMR rebuild in progress — RSS barely changes)

| Container | RSS | CPU% | PIDs |
|---|---|---|---|
| spike-proj-1 | 120.8 MiB | 0.6% | 30 |
| spike-proj-2 | 117.0 MiB | 0.6% | 29 |
| spike-proj-3 | 116.8 MiB | 0.1% | 29 |
| **Average** | **118.2 MiB** | | |

### Active CPU — streamed during HMR window (6 s, catches the <200 ms burst)

Peak CPU per container during HMR rebuild: **0.57%** (100% = 1 core)

Note: `docker stats --no-stream` misses a sub-200 ms CPU burst. The streaming measurement
above is the authoritative active-CPU figure.

### Capacity (measured on this hardware)

| Metric | Value |
|---|---|
| Available RAM | ~6500 MB |
| Idle RSS per container | **118.1 MiB** |
| Active RSS per container | **118.2 MiB** (RAM barely moves during HMR) |
| Max idle containers (RAM-bound) | **55** |
| Max active containers (RAM-bound) | **54** |
| Active build CPU (peak, streaming) | 0.57% per container (100% = 1 core) |
| Max concurrent builds (CPU-bound) | **701** |
| **Binding constraint** | **RAM** |

> **Replaces the old VM extrapolation.** These are real measured numbers on 4 vCPU / 7.6 GB.

## 6. Idle-suspend recommendation

**Recommendation: `docker stop` idle containers (not `docker pause`).**

| Strategy | RAM freed? | Cold-start latency | Verdict |
|---|---|---|---|
| `docker pause` | No (RAM stays resident) | ~0 ms (frozen) | Bad — no RAM benefit |
| `docker stop` | Yes (full RSS freed) | ~3–5 s (Vite cold-start) | **Preferred** |

Track idleness via nginx access-log timestamps or a `/ping` endpoint in the container.
Stop after ~10 min idle. On next visit, the orchestration layer (Phase 4) restarts the
container, buffers the HTTP request, and retries once Vite is ready (~3–5 s).

**Concurrent-build ceiling:** RAM is the binding constraint (54 containers within 6500 MB). CPU headroom is ample. Cap concurrent containers at available_ram / 118_MB.
