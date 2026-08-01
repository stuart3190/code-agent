// Post-deploy production smoke.
//
// The route-manifest test proves the SOURCE mounts a route. This proves the DEPLOYED server
// actually answers it. PR #53 removed three live routes and nothing noticed for days because no
// test and no check ever asked the running server whether they existed; a 404 from a route that
// should return 401 is the exact signature of that failure.
//
//   node scripts/smoke-production.mjs [--origin https://app.thrallo.com]
//
// Every check is unauthenticated on purpose: an owner-scoped route answering 401 proves it is
// mounted AND gated, without needing a real session or spending anything. The one status this
// script exists to catch is 404.

const origin = (() => {
  const i = process.argv.indexOf("--origin");
  return (i === -1 ? process.env.THRALLO_SMOKE_ORIGIN || "https://app.thrallo.com" : process.argv[i + 1])
    .replace(/\/$/, "");
})();

// `expect` is the set of acceptable statuses. 404 is never acceptable for a mounted route.
const CHECKS = [
  { method: "GET", path: "/", expect: [200], why: "landing page serves" },
  { method: "GET", path: "/api/health", expect: [200, 503], why: "liveness endpoint" },
  { method: "GET", path: "/pricing", expect: [200], why: "public pricing" },
  { method: "GET", path: "/terms", expect: [200], why: "legal pages" },
  { method: "GET", path: "/privacy", expect: [200], why: "legal pages" },

  // Owner-scoped: 401 proves mounted + gated.
  { method: "GET", path: "/api/v1/conversations", expect: [401], why: "conversation list" },
  { method: "GET", path: "/api/v1/usage", expect: [401], why: "usage + budgets" },
  { method: "GET", path: "/api/v1/ai/connections", expect: [401], why: "AI connections" },
  { method: "GET", path: "/api/v1/diagnostics", expect: [401], why: "build diagnostics" },
  { method: "GET", path: "/api/v1/tokens", expect: [401], why: "API tokens" },
  { method: "GET", path: "/api/v1/admin/analytics", expect: [401], why: "admin analytics stays gated" },
  { method: "GET", path: "/api/v1/downloads", expect: [200], why: "desktop release manifest" },

  // QA sweeps — unmounted by the same #53 sweep, restored in PR 3.
  { method: "GET", path: "/api/test-runs?projectId=00000000-0000-4000-8000-000000000001", expect: [401], why: "QA run list" },
  { method: "GET", path: "/api/test-runs/00000000-0000-4000-8000-000000000001", expect: [401], why: "QA run read (regression: unmounted by PR #53)" },

  // Source export — unmounted by the same #53 sweep, restored in PR 4.
  { method: "POST", path: "/api/export", expect: [401], why: "source export (regression: unmounted by PR #53)" },

  // The three routes PR #53 silently deleted. These are why this script exists.
  {
    method: "GET", path: "/api/builds/00000000-0000-4000-8000-000000000001/events",
    expect: [401], why: "build event stream (regression: unmounted by PR #53)",
  },
  {
    method: "POST", path: "/api/builds/00000000-0000-4000-8000-000000000001/cancel",
    expect: [401], why: "build cancel (regression: unmounted by PR #53 — users could not cancel)",
  },
  {
    method: "GET", path: "/api/projects/00000000-0000-4000-8000-000000000001/active-build",
    expect: [401], why: "active-build reattach (regression: unmounted by PR #53)",
  },
];

async function check(entry) {
  const started = Date.now();
  try {
    const response = await fetch(`${origin}${entry.path}`, {
      method: entry.method,
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    const ok = entry.expect.includes(response.status);
    return { ...entry, status: response.status, ok, ms: Date.now() - started };
  } catch (error) {
    return { ...entry, status: 0, ok: false, ms: Date.now() - started, error: error.message };
  }
}

const results = [];
for (const entry of CHECKS) results.push(await check(entry));

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  const detail = r.error ? ` (${r.error})` : "";
  console.log(`${mark}  ${String(r.status).padEnd(3)} ${r.method.padEnd(4)} ${r.path}${detail}`);
}

console.log(`\n${results.length - failures.length}/${results.length} checks passed against ${origin}`);
if (failures.length) {
  console.error("\nFAILED:");
  for (const f of failures) {
    console.error(`  ${f.method} ${f.path} -> ${f.status || "no response"}, expected ${f.expect.join("|")}  — ${f.why}`);
    if (f.status === 404) console.error("    404 means the route is NOT MOUNTED. Check shell/server/index.mjs.");
  }
  process.exit(1);
}
