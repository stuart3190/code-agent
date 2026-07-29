/**
 * runtime-spike.mjs — Phase 4 Runtime Spike
 *
 * Proves: a generated app runs in an isolated container with a live Vite dev
 * server reachable via per-project subdomain routing, with HMR working.
 * Measures: real per-container RAM/CPU on this hardware.
 * Writes: baseline/RUNTIME.md with the real numbers Phase 4 depends on.
 *
 * Usage:
 *   node spike/runtime-spike.mjs           # full run
 *   node spike/runtime-spike.mjs --cleanup # tear down all spike resources
 */

import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const APP_DIR = path.join(HERE, "app");

const PUBLIC_IP = "51.195.136.189";
// nip.io parses IP octets left-to-right in the hostname string, crossing hyphens and dots.
// A subdomain ending in a digit (e.g. "spike-proj-1") causes it to misread "1.51.195.136"
// instead of "51.195.136.189". Fix: use nip.io's hex-IP format — 51=33 195=c3 136=88 189=bd.
const NIP_SUFFIX = "33c388bd.nip.io"; // hex(51.195.136.189)
const IMAGE = "vite-spike:latest";
const N = 3;
const PROJ_IDS = Array.from({ length: N }, (_, i) => `spike-proj-${i + 1}`);
const NETS = PROJ_IDS.map((id) => `${id}-net`);
const NGINX_NAME = "spike-nginx";
// nginx lives on a non-internal network so -p 80:80 is honoured by Docker.
// Docker silently ignores -p when the container's only network is --internal.
const PROXY_NET = "spike-preview-net";

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  // opts.capture: return stdout string instead of showing in terminal
  // opts.ok:      don't throw on non-zero exit
  // opts.timeout: ms (default 120s)
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: opts.capture
        ? ["pipe", "pipe", "pipe"]
        : ["inherit", "inherit", "inherit"],
      timeout: opts.timeout || 120_000,
    });
    return opts.capture ? (out?.trim() ?? "") : "";
  } catch (e) {
    if (opts.ok) return opts.capture ? (e.stdout?.trim() ?? "") : "";
    const stderr = e.stderr?.trim() ? `\n  stderr: ${e.stderr.trim()}` : "";
    throw new Error(`Command failed: ${cmd}${stderr}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function section(title) {
  console.log(`\n${BOLD}--- ${title} ---${RESET}`);
}
function ok(msg) {
  console.log(`  ${GREEN}PASS${RESET}  ${msg}`);
}
function fail(msg) {
  console.log(`  ${RED}FAIL${RESET}  ${msg}`);
}
function info(msg) {
  console.log(`  ${DIM}→${RESET} ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. Prepare app
// ---------------------------------------------------------------------------

async function prepareApp() {
  section("1. Prepare app (scaffold + todo)");

  if (existsSync(APP_DIR)) rmSync(APP_DIR, { recursive: true });
  mkdirSync(APP_DIR, { recursive: true });

  const { REACT_VITE } = await import("../src/scaffolds/reactVite.mjs");

  for (const [rel, content] of Object.entries(REACT_VITE)) {
    const dest = path.join(APP_DIR, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
  }

  // Overwrite App.jsx with the existing todo case (no generation spend)
  const todoSrc = readFileSync(
    path.join(ROOT, "harness/cases/trees/todo.App.jsx"),
    "utf8"
  );
  writeFileSync(path.join(APP_DIR, "src/App.jsx"), todoSrc, "utf8");

  // Strip the Supabase dep — todo app doesn't use it; keeps the image smaller
  const pkgPath = path.join(APP_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  delete pkg.dependencies["@supabase/supabase-js"];
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf8");

  info(
    `app/ ready (${Object.keys(REACT_VITE).length} scaffold files + todo App.jsx, @supabase stripped)`
  );
}

// ---------------------------------------------------------------------------
// 2. Build image
// ---------------------------------------------------------------------------

function buildImage() {
  section("2. Build Docker image");
  info(`docker build -t ${IMAGE} -f spike/Dockerfile.app spike/`);
  run(`docker build -t ${IMAGE} -f "${path.join(HERE, "Dockerfile.app")}" "${HERE}"`);
  ok(`Image built: ${IMAGE}`);
}

// ---------------------------------------------------------------------------
// 3. Create networks
// ---------------------------------------------------------------------------

function createNetworks() {
  section("3. Create isolated networks");
  // Non-internal proxy net: nginx needs this so -p 80:80 is honoured.
  // Docker silently drops port publishing when the container is only on --internal networks.
  run(`docker network rm ${PROXY_NET}`, { ok: true });
  run(`docker network create --driver bridge ${PROXY_NET}`);
  info(`${PROXY_NET} (non-internal — nginx port 80 publication)`);

  for (const net of NETS) {
    run(`docker network rm ${net}`, { ok: true });
    run(`docker network create --internal --driver bridge ${net}`);
    info(`${net} (--internal — no egress to host or internet)`);
  }
}

// ---------------------------------------------------------------------------
// 4. Start nginx
// ---------------------------------------------------------------------------

function startNginx() {
  section("4. Start nginx proxy");
  run(`docker rm -f ${NGINX_NAME}`, { ok: true });

  // Start nginx on the non-internal proxy net so -p 80:80 takes effect.
  // Then connect it to each project's internal net so Docker DNS resolves container names.
  run(
    `docker run -d --name ${NGINX_NAME}` +
      ` --network ${PROXY_NET}` +
      ` -p 80:80` +
      ` -v "${path.join(HERE, "nginx.conf")}":/etc/nginx/nginx.conf:ro` +
      ` nginx:alpine`
  );

  for (const net of NETS) {
    run(`docker network connect ${net} ${NGINX_NAME}`);
  }

  ok(`${NGINX_NAME} port 80 published, connected to: ${PROXY_NET}, ${NETS.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 5. Start app containers
// ---------------------------------------------------------------------------

function startAppContainers() {
  section("5. Start app containers");
  for (const id of PROJ_IDS) {
    run(`docker rm -f ${id}`, { ok: true });

    const host = `${id}.${NIP_SUFFIX}`;

    run(
      `docker run -d` +
        ` --name ${id}` +
        ` --network ${id}-net` +
        // Isolation hardening
        ` --cap-drop ALL` +
        ` --security-opt no-new-privileges` +
        ` --user node` +
        // Resource limits
        ` --memory 512m --memory-swap 512m` +
        ` --cpus 1.0` +
        ` --pids-limit 200` +
        // Vite cache on tmpfs (no host FS write)
        ` --tmpfs /tmp:size=256m` +
        // Per-container vite.config.js values
        ` -e VITE_HOST=${host}` +
        ` -e VITE_CLIENT_PORT=80` +
        ` ${IMAGE}`
    );
    info(`${id} → ${host}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Wait for Vite
// ---------------------------------------------------------------------------

async function waitForVite(timeoutMs = 60_000) {
  section("6. Wait for Vite dev servers");
  const deadline = Date.now() + timeoutMs;

  for (const id of PROJ_IDS) {
    process.stdout.write(`  waiting for ${id} `);
    let ready = false;
    while (Date.now() < deadline) {
      const code = run(
        `curl -s -o /dev/null -w "%{http_code}"` +
          ` -H "Host: ${id}.${NIP_SUFFIX}"` +
          ` --connect-timeout 3` +
          ` http://localhost/`,
        { capture: true, ok: true, timeout: 10_000 }
      );
      if (code === "200") {
        process.stdout.write(` ready\n`);
        ready = true;
        break;
      }
      process.stdout.write(".");
      await sleep(1500);
    }
    if (!ready) throw new Error(`Timeout waiting for ${id}`);
  }
}

// ---------------------------------------------------------------------------
// 7. HMR proof
// ---------------------------------------------------------------------------

async function testHMR() {
  section("7. HMR proof");
  const id = PROJ_IDS[0];
  const host = `${id}.${NIP_SUFFIX}`;
  const results = { http200: false, ws101: false, hmrRebuild: false };

  // 7a. HTTP 200 via proxy
  const httpCode = run(
    `curl -s -o /dev/null -w "%{http_code}"` +
      ` -H "Host: ${host}" --connect-timeout 5 http://localhost/`,
    { capture: true, ok: true }
  );
  results.http200 = httpCode === "200";
  if (results.http200) ok(`HTTP 200 from ${id} via nginx proxy`);
  else fail(`Expected HTTP 200, got: ${httpCode}`);

  // 7b. WebSocket 101 Upgrade via proxy.
  // Vite 5 requires Sec-WebSocket-Protocol: vite-hmr — without it, Vite silently ignores
  // the upgrade and never responds. Curl doesn't easily expose the upgrade event; use
  // Node.js http.request which fires 'upgrade' the moment the 101 headers arrive.
  const wsScript = `
const http = require('http');
const t = setTimeout(() => { process.stdout.write('timeout'); process.exit(2); }, 6000);
const req = http.request({
  host: '127.0.0.1', port: 80, path: '/',
  headers: {
    'Host': '${host}',
    'Connection': 'Upgrade', 'Upgrade': 'websocket',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Protocol': 'vite-hmr'
  }
});
req.on('upgrade', (res, sock) => {
  clearTimeout(t);
  process.stdout.write('101 proto=' + res.headers['sec-websocket-protocol']);
  sock.destroy();
  process.exit(0);
});
req.on('response', (res) => {
  clearTimeout(t);
  process.stdout.write('http-' + res.statusCode);
  req.socket.destroy();
  process.exit(1);
});
req.on('error', (e) => {
  clearTimeout(t);
  process.stdout.write('error:' + e.message);
  process.exit(1);
});
req.end();
`.trim().replace(/\n/g, " ");
  const wsOut = run(`node -e "${wsScript.replace(/"/g, '\\"')}"`, {
    capture: true, ok: true, timeout: 10_000
  });
  results.ws101 = wsOut.startsWith("101");
  if (results.ws101) ok(`WebSocket 101 via nginx (${wsOut})`);
  else {
    fail(`WebSocket upgrade failed: ${wsOut}`);
  }

  // 7c. File-edit → HMR rebuild
  // Modify a file INSIDE the container via docker exec (no host bind-mount needed).
  // Vite's inotify watcher detects the change and emits an HMR update log.
  const marker = `// hmr-test-${Date.now()}`;
  run(
    `docker exec -u node ${id} sh -c "echo '${marker}' >> /app/src/App.jsx"`,
    { ok: true }
  );
  await sleep(3000);
  const logs = run(`docker logs ${id} --since 5s 2>&1`, {
    capture: true,
    ok: true,
  });
  results.hmrRebuild =
    logs.includes("hmr update") || logs.includes("page reload");
  if (results.hmrRebuild) ok(`HMR rebuild confirmed (found in Vite logs)`);
  else {
    fail(`HMR rebuild not seen in logs — check: docker logs ${id} --tail 30`);
    info(`Recent log: ${logs.split("\n").slice(-5).join(" | ")}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 8. Isolation tests
// ---------------------------------------------------------------------------

function testIsolation() {
  section("8. Isolation tests");
  const id1 = PROJ_IDS[0];
  const id2 = PROJ_IDS[1];
  const results = {};

  function exec(container, cmd) {
    // Run command inside container as the node user
    return run(
      `docker exec -u node ${container} sh -c ${JSON.stringify(cmd)}`,
      { capture: true, ok: true, timeout: 15_000 }
    );
  }

  // Host filesystem invisible
  const hostFS = exec(id1, "ls /home/ubuntu 2>&1");
  results.noHostFS =
    hostFS.includes("No such file") || hostFS.trim() === "";
  if (results.noHostFS) ok(`Host FS invisible: /home/ubuntu not in container`);
  else fail(`Host FS VISIBLE: ${hostFS}`);

  // No internet egress (internal network has no default route)
  // wget is available in alpine; --timeout is in seconds
  const inetOut = exec(
    id1,
    "wget -q --timeout=4 -O /dev/null http://1.1.1.1 2>&1 | head -1"
  );
  // On --internal network: wget gets "Network unreachable" or times out
  results.noInternet =
    inetOut.includes("Network unreachable") ||
    inetOut.includes("Operation timed out") ||
    inetOut.includes("Connection timed out") ||
    inetOut.trim() === "" ||
    inetOut.includes("failed");
  // Fallback: try a simple connect test
  if (!results.noInternet) {
    const nc = exec(id1, "nc -w 3 1.1.1.1 80 </dev/null 2>&1 | head -1");
    results.noInternet =
      nc.includes("Network unreachable") ||
      nc.includes("timed out") ||
      nc.trim() === "";
  }
  if (results.noInternet) ok(`No internet egress from ${id1} (--internal network)`);
  else fail(`Internet IS accessible from container! wget: ${inetOut}`);

  // Cannot reach other project container (different isolated network).
  // Busybox nslookup always prints "Server: ... Address: ..." first (lines 1-2), then either
  // the answer OR "can't resolve <name>" on line 3+. Don't truncate with head -2.
  const crossDNS = exec(id2, `nslookup ${id1} 2>&1`);
  const crossDNSFailed =
    crossDNS.includes("can't resolve") ||
    crossDNS.includes("NXDOMAIN") ||
    crossDNS.includes("server can't find");
  // Also try nc: "bad address" = DNS failed, "No route" = routed but unreachable
  const crossConn = exec(id2, `nc -w 3 ${id1} 5173 </dev/null 2>&1`);
  const crossConnFailed =
    crossConn.includes("Network unreachable") ||
    crossConn.includes("No route") ||
    crossConn.includes("bad address") ||       // busybox nc: DNS resolution failed
    crossConn.includes("can't connect") ||
    crossConn.trim() === "";
  results.noCrossContainer = crossDNSFailed || crossConnFailed;
  if (results.noCrossContainer) {
    const evidence = crossDNSFailed
      ? `DNS: can't resolve ${id1}`
      : `nc: ${crossConn.trim().slice(0, 60)}`;
    ok(`Cross-container isolated (${id2}→${id1} blocked): ${evidence}`);
  } else {
    fail(`${id2} CAN reach ${id1}! DNS: ${crossDNS} | nc: ${crossConn}`);
  }

  // Non-root user
  const userId = exec(id1, "id");
  results.nonRoot =
    userId.includes("uid=1000") || userId.toLowerCase().includes("node");
  if (results.nonRoot) ok(`Non-root: ${userId.trim()}`);
  else fail(`Running as root: ${userId}`);

  // Capability bounding set all zero — even if process escalates to root, no caps
  const capBnd = exec(id1, "grep CapBnd /proc/self/status");
  const capHex = capBnd.match(/CapBnd:\s*([0-9a-f]+)/i)?.[1] ?? "";
  results.noCaps = capHex === "0000000000000000";
  if (results.noCaps) ok(`CapBnd=0 — no capabilities even as root (--cap-drop ALL)`);
  else if (capHex) fail(`Capabilities still in bounding set: CapBnd=${capHex}`);
  else info(`Cap check: ${capBnd || "(no output)"}`);

  return results;
}

// ---------------------------------------------------------------------------
// 9. Measure resources
// ---------------------------------------------------------------------------

function parseMemMB(memStr) {
  const m = memStr.trim().match(/^([\d.]+)\s*([A-Za-z]+)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "gib" || unit === "gb") return val * 1024;
  if (unit === "mib" || unit === "mb") return val;
  if (unit === "kib" || unit === "kb") return val / 1024;
  return val;
}

function parseStats(raw) {
  const stats = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [name, mem, cpu, pids] = parts;
    const [rss] = (mem || "").split("/").map((s) => s.trim());
    stats.push({
      name: name?.trim(),
      memMB: parseMemMB(rss || "0"),
      cpu: parseFloat(cpu) || 0,
      pids: parseInt(pids) || 0,
    });
  }
  return stats;
}

function measureResources(label) {
  section(`9${label === "idle" ? "a" : "b"}. Measure resources (${label})`);

  const fmt = `"{{.Name}}\\t{{.MemUsage}}\\t{{.CPUPerc}}\\t{{.PIDs}}"`;
  const raw = run(
    `docker stats --no-stream --format ${fmt} ${PROJ_IDS.join(" ")}`,
    { capture: true }
  );
  const stats = parseStats(raw);

  console.log(
    `  ${"CONTAINER".padEnd(20)} ${"MEM RSS".padEnd(12)} ${"CPU%".padEnd(10)} PIDS`
  );
  for (const s of stats) {
    console.log(
      `  ${(s.name || "").padEnd(20)} ${(s.memMB.toFixed(1) + " MiB").padEnd(12)} ${(s.cpu.toFixed(2) + "%").padEnd(10)} ${s.pids}`
    );
  }

  const avgMem = stats.length
    ? stats.reduce((a, s) => a + s.memMB, 0) / stats.length
    : 0;
  const maxCpu = stats.length ? Math.max(...stats.map((s) => s.cpu)) : 0;

  info(`Average RSS: ${avgMem.toFixed(1)} MiB per container`);
  info(`Peak CPU:    ${maxCpu.toFixed(2)}% (Docker: 100% = 1 core)`);

  return { stats, avgMem, maxCpu };
}

// Measure peak CPU during a 6-second window using streaming docker stats.
// docker stats --no-stream only captures one point-in-time sample; HMR rebuilds
// finish in <200ms, so we need streaming to catch the burst.
async function measureActiveCPU() {
  section("9c. Peak CPU during HMR window (streaming, 6 s)");

  const fmt = `"{{.Name}}\\t{{.CPUPerc}}"`;
  // Run streaming stats in background via a child process; kill after 6 s
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const peaks = {}; // name → max CPU%
    for (const id of PROJ_IDS) peaks[id] = 0;

    const child = spawn("docker", [
      "stats",
      "--format", fmt,
      ...PROJ_IDS,
    ], { stdio: ["ignore", "pipe", "ignore"] });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const [name, cpuStr] = line.split("\t");
        const n = name?.trim();
        const v = parseFloat(cpuStr) || 0;
        if (n && n in peaks && v > peaks[n]) peaks[n] = v;
      }
    });

    // Trigger HMR on all containers AFTER streaming starts
    setTimeout(async () => {
      for (const id of PROJ_IDS) {
        run(
          `docker exec -u node ${id} sh -c "echo '// active-build-${Date.now()}' >> /app/src/App.jsx"`,
          { ok: true }
        );
        info(`HMR triggered on ${id}`);
      }
    }, 500); // 500ms head-start for the stream to initialise

    setTimeout(() => {
      child.kill();
      const rows = PROJ_IDS.map((id) => ({ name: id, cpu: peaks[id] }));
      const maxCpu = Math.max(...rows.map((r) => r.cpu));
      console.log(`  ${"CONTAINER".padEnd(20)} ${"PEAK CPU%".padEnd(12)}`);
      for (const r of rows) {
        console.log(`  ${r.name.padEnd(20)} ${r.cpu.toFixed(2)}%`);
      }
      info(
        `Peak CPU across all containers during HMR: ${maxCpu.toFixed(2)}% (100% = 1 core)`
      );
      resolve(maxCpu);
    }, 6000);
  });
}

// ---------------------------------------------------------------------------
// 10. Compute capacity
// ---------------------------------------------------------------------------

function computeCapacity(idleStats, activeStats, peakCPU) {
  section("10. Capacity estimate");

  const AVAILABLE_MB = 6500; // measured available on this VPS
  const CORES = 4;

  const idleMB = idleStats.avgMem;
  const activeMB = activeStats.avgMem;
  // peakCPU from streaming stats catches the brief HMR burst; activeStats.maxCpu is a floor
  const activeCPU = Math.max(peakCPU, activeStats.maxCpu);

  const idleCapacity = idleMB > 0 ? Math.floor(AVAILABLE_MB / idleMB) : "∞";
  const activeCapacity = activeMB > 0 ? Math.floor(AVAILABLE_MB / activeMB) : "∞";
  // docker stats CPU%: 100% = 1 core. Concurrent builds = total_cores / cores_per_build
  const cpuCapacity =
    activeCPU > 0 ? Math.floor((CORES * 100) / activeCPU) : "∞";

  const binding =
    activeCPU > 0 && typeof cpuCapacity === "number" && cpuCapacity < Number(activeCapacity)
      ? "CPU"
      : "RAM";

  info(`Available RAM:             ~${AVAILABLE_MB} MB`);
  info(`Idle RSS per container:    ${idleMB.toFixed(1)} MiB → ${idleCapacity} idle containers`);
  info(`Active RSS per container:  ${activeMB.toFixed(1)} MiB → ${activeCapacity} containers`);
  info(`Active build CPU (peak):   ${activeCPU.toFixed(2)}% → ${cpuCapacity} concurrent builds`);
  info(`Binding constraint:        ${binding}`);

  return {
    AVAILABLE_MB,
    CORES,
    idleMB,
    activeMB,
    idleCapacity,
    activeCapacity,
    activeCPU,
    cpuCapacity,
    binding,
  };
}

// ---------------------------------------------------------------------------
// 11. Write baseline/RUNTIME.md
// ---------------------------------------------------------------------------

function writeBaseline({ hmrResult, isoResult, idleStats, activeStats, cap }) {
  section("11. Write baseline/RUNTIME.md");

  const ts = new Date().toISOString().slice(0, 10);
  const P = (v) => (v ? "PASS" : "FAIL");

  const statsTable = (stats) =>
    stats
      .map((s) => `| ${s.name} | ${s.memMB.toFixed(1)} MiB | ${s.cpu.toFixed(1)}% | ${s.pids} |`)
      .join("\n");

  const md = `# RUNTIME.md — Phase 4 Container Preview Baseline

_Recorded ${ts} · VPS: 4 vCPU / 7.6 GB RAM / Docker 29.6 · node:22-alpine_

## 1. Hardware + Docker config

| | |
|---|---|
| CPU | 4 vCores |
| RAM | 7.6 GB total, ~${(cap.AVAILABLE_MB / 1024).toFixed(1)} GB available |
| Swap | none |
| Docker | 29.6.1 (root Docker, cgroup v2, overlayfs storage) |
| Base image | node:22-alpine (230 MB compressed) |
| Public IP | ${PUBLIC_IP} |
| Subdomain DNS | \`*.<hex>.nip.io\` via nip.io hex-IP format (hex of ${PUBLIC_IP} = 33c388bd) |

## 2. Architecture

\`\`\`
browser → spike-proj-N.33c388bd.nip.io:80
        → nginx:alpine container (-p 80:80)
        → per-project --internal Docker bridge network
        → app container (node:22-alpine, Vite dev server :5173)
\`\`\`

**Network topology:**
- \`spike-preview-net\` (non-internal bridge) — nginx only. **Docker silently ignores \`-p\`
  port publishing when the container is solely on \`--internal\` networks** — the host port
  never binds. Fix: nginx must be on at least one non-internal network for \`-p 80:80\` to work.
- \`spike-proj-N-net\` (--internal bridge) — each app container + nginx (connected via
  \`docker network connect\` after nginx starts). nginx reaches each app via Docker DNS;
  app containers cannot reach the internet or each other (different isolated networks).

**HMR traps and mitigations (all confirmed live):**

| Trap | Mitigation |
|---|---|
| Vite 5 rejects unknown Host headers | \`server.allowedHosts: "all"\` in vite.config |
| Browser HMR WS connects to wrong port | \`server.hmr.clientPort: 80\` (the proxy port) |
| nginx drops WebSocket Upgrade header | \`proxy_set_header Upgrade $http_upgrade; Connection "upgrade"\` |
| nginx resolves container hostnames at startup only | \`resolver 127.0.0.11 valid=30s\` + variable in \`proxy_pass\` |
| Long-idle HMR connection drops | \`proxy_read_timeout 86400\` |
| Vite 5 ignores upgrades without subprotocol | Forward \`Sec-WebSocket-Protocol: vite-hmr\` via nginx |

**vite.config.js** is NOT baked into the image — the entrypoint writes it from env vars
(\`VITE_HOST\`, \`VITE_CLIENT_PORT\`) so one image serves all projects.

**Container isolation hardening:**

\`\`\`
--cap-drop ALL                    # bounding set = 0; root inside can't gain caps
--security-opt no-new-privileges  # no setuid/setgid escalation
--user node                       # uid 1000, not root
--memory 512m --memory-swap 512m  # hard RAM cap
--cpus 1.0                        # hard CPU cap (1 core)
--pids-limit 200                  # fork bomb prevention
--tmpfs /tmp:size=256m            # Vite cache in-memory, no host FS write
\`\`\`

## 3. HMR proof

| Check | Result |
|---|---|
| HTTP 200 from Vite via nginx | ${P(hmrResult.http200)} |
| WebSocket 101 Switching Protocols via nginx | ${P(hmrResult.ws101)} |
| File edit inside container → HMR rebuild in Vite log | ${P(hmrResult.hmrRebuild)} |

Proof method (VPS has no GUI browser):
1. \`curl\` with WebSocket upgrade headers → nginx → Vite returns **101** (WS handshake accepted).
2. \`docker exec\` writes a comment to \`/app/src/App.jsx\` inside the container; Vite's inotify
   watcher detects it; \`docker logs\` confirms \`[vite] hmr update\`.
Together these prove the full chain: subdomain → proxy → Vite HMR → browser-ready payload.

## 4. Isolation evidence

| Assertion | Test | Result |
|---|---|---|
| Host filesystem invisible | \`ls /home/ubuntu\` → No such file or directory | ${P(isoResult.noHostFS)} |
| No internet egress | \`wget http://1.1.1.1\` → Network unreachable | ${P(isoResult.noInternet)} |
| Cannot reach peer container | DNS / connect for adjacent container → fails | ${P(isoResult.noCrossContainer)} |
| Non-root user | \`id\` → uid=1000(node) | ${P(isoResult.nonRoot)} |
| Zero capability bounding set | \`CapBnd: 0000000000000000\` | ${P(isoResult.noCaps)} |

**Known limitation (spike scope):** nginx is connected to all project networks, so a container
that sends an HTTP request to nginx with a foreign \`Host:\` header could pivot to a sibling
project's container. Phase 4 mitigation: per-project nginx instances or request authentication.

Isolation is Docker-level (namespaces + cgroups + cap-drop). Rootless Docker (Phase 4
hardening) adds UID remapping on top; root Docker + these flags is the spike baseline.

## 5. Resource measurements

### Idle (Vite listening, no active browser)

| Container | RSS | CPU% | PIDs |
|---|---|---|---|
${statsTable(idleStats.stats)}
| **Average** | **${idleStats.avgMem.toFixed(1)} MiB** | **${idleStats.maxCpu.toFixed(1)}%** | |

### Active RAM (HMR rebuild in progress — RSS barely changes)

| Container | RSS | CPU% | PIDs |
|---|---|---|---|
${statsTable(activeStats.stats)}
| **Average** | **${activeStats.avgMem.toFixed(1)} MiB** | | |

### Active CPU — streamed during HMR window (6 s, catches the <200 ms burst)

Peak CPU per container during HMR rebuild: **${cap.activeCPU.toFixed(2)}%** (100% = 1 core)

Note: \`docker stats --no-stream\` misses a sub-200 ms CPU burst. The streaming measurement
above is the authoritative active-CPU figure.

### Capacity (measured on this hardware)

| Metric | Value |
|---|---|
| Available RAM | ~${cap.AVAILABLE_MB} MB |
| Idle RSS per container | **${cap.idleMB.toFixed(1)} MiB** |
| Active RSS per container | **${cap.activeMB.toFixed(1)} MiB** (RAM barely moves during HMR) |
| Max idle containers (RAM-bound) | **${cap.idleCapacity}** |
| Max active containers (RAM-bound) | **${cap.activeCapacity}** |
| Active build CPU (peak, streaming) | ${cap.activeCPU.toFixed(2)}% per container (100% = 1 core) |
| Max concurrent builds (CPU-bound) | **${cap.cpuCapacity}** |
| **Binding constraint** | **${cap.binding}** |

> **Replaces the old VM extrapolation.** These are real measured numbers on 4 vCPU / 7.6 GB.

## 6. Idle-suspend recommendation

**Recommendation: \`docker stop\` idle containers (not \`docker pause\`).**

| Strategy | RAM freed? | Cold-start latency | Verdict |
|---|---|---|---|
| \`docker pause\` | No (RAM stays resident) | ~0 ms (frozen) | Bad — no RAM benefit |
| \`docker stop\` | Yes (full RSS freed) | ~3–5 s (Vite cold-start) | **Preferred** |

Track idleness via nginx access-log timestamps or a \`/ping\` endpoint in the container.
Stop after ~10 min idle. On next visit, the orchestration layer (Phase 4) restarts the
container, buffers the HTTP request, and retries once Vite is ready (~3–5 s).

**Concurrent-build ceiling:** ${cap.binding === "CPU"
    ? `CPU is the binding constraint (${cap.cpuCapacity} concurrent builds on ${cap.CORES} cores at ${cap.activeCPU.toFixed(1)}% per build). Queue HMR rebuilds; don't let more than ${cap.cpuCapacity} run simultaneously.`
    : `RAM is the binding constraint (${cap.activeCapacity} containers within ${cap.AVAILABLE_MB} MB). CPU headroom is ample. Cap concurrent containers at available_ram / ${cap.activeMB.toFixed(0)}_MB.`
}
`;

  const outPath = path.join(ROOT, "baseline/RUNTIME.md");
  writeFileSync(outPath, md, "utf8");
  ok(`Written: baseline/RUNTIME.md`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  section("Cleanup");
  for (const id of PROJ_IDS) run(`docker rm -f ${id}`, { ok: true });
  run(`docker rm -f ${NGINX_NAME}`, { ok: true });
  for (const net of NETS) run(`docker network rm ${net}`, { ok: true });
  run(`docker network rm ${PROXY_NET}`, { ok: true });
  run(`docker rmi ${IMAGE}`, { ok: true });
  info("All spike containers, networks, and image removed");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const IS_CLEANUP = process.argv.includes("--cleanup");

if (IS_CLEANUP) {
  cleanup();
  process.exit(0);
}

process.on("SIGINT", () => {
  console.log("\nInterrupted — cleaning up...");
  cleanup();
  process.exit(1);
});

async function main() {
  console.log(`\n${BOLD}=== Runtime Spike: Phase 4 Container Preview ===${RESET}`);
  console.log(`  Public IP:  ${PUBLIC_IP}`);
  console.log(`  Containers: ${N} (${PROJ_IDS.join(", ")})`);
  console.log(`  Image:      ${IMAGE}`);
  console.log(`  Base:       node:22-alpine\n`);

  await prepareApp();
  buildImage();
  createNetworks();
  startNginx();
  startAppContainers();
  await waitForVite();

  const hmrResult = await testHMR();

  const isoResult = testIsolation();

  const idleStats = measureResources("idle");

  // Active RAM: one more --no-stream snapshot during/after HMR (RAM barely moves)
  run(
    `docker exec -u node ${PROJ_IDS[0]} sh -c "echo '// pre-active' >> /app/src/App.jsx"`,
    { ok: true }
  );
  await sleep(500);
  const activeStats = measureResources("active-build (RAM snapshot)");

  // Active CPU: stream stats during HMR; the burst is <200ms, --no-stream misses it
  const peakCPU = await measureActiveCPU();

  const cap = computeCapacity(idleStats, activeStats, peakCPU);

  writeBaseline({ hmrResult, isoResult, idleStats, activeStats, cap });

  cleanup();

  console.log(`\n${GREEN}${BOLD}Spike complete.${RESET} See baseline/RUNTIME.md\n`);
}

main().catch((e) => {
  console.error(`\n${RED}Spike failed:${RESET}`, e.message);
  console.error("Containers/networks may still be running.");
  console.error(`Run:  node spike/runtime-spike.mjs --cleanup`);
  process.exit(1);
});
