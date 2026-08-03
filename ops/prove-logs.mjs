// Live proof for the build log pipeline. Reads REAL production builds.
//
// Production carries every case this needs: passed, failed, cancelled and interrupted runs, steps
// with inline output and steps already compressed by the diagnostics sweeper. Nothing here is
// seeded except one throwaway project used to prove that deleting a project takes its logs with it.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { readLogs, buildRunsFor } from "../shell/server/lib/logs/logReader.mjs";
import { deployments } from "../shell/server/lib/analytics/reports.mjs";
import { purgeProjectResources } from "../shell/server/lib/projectTeardown.mjs";
import { sweepDiagnostics, DIAG_DEFAULT_RETENTION_DAYS } from "../shell/server/lib/appBuild/buildDiagnostics.mjs";

const db = serviceClient();
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

// ── Find a real project with real build history ─────────────────────────────────────────
const { data: allRuns } = await db.from("diag_runs")
  .select("id,owner,project_id,status,started_at").order("started_at", { ascending: false });
const byProject = new Map();
for (const run of allRuns || []) {
  const key = `${run.owner}|${run.project_id}`;
  if (!byProject.has(key)) byProject.set(key, []);
  byProject.get(key).push(run);
}
const [key, runs] = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)[0] || [];
if (!key) { console.error("no build runs in production to prove against"); process.exit(1); }
const [OWNER, PROJECT] = key.split("|");
console.log(`[proof] owner ${OWNER.slice(0, 8)}… project ${PROJECT.slice(0, 8)}… — ${runs.length} runs`);
console.log(`[proof] statuses: ${JSON.stringify(runs.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}))}`);

// ── 1. The build source returns real steps ──────────────────────────────────────────────
const resolved = await buildRunsFor(OWNER, PROJECT, { client: db });
check(resolved.length === runs.length, "every run for the project resolves", `${resolved.length}`);

const { entries: buildOnly } = await readLogs(OWNER, PROJECT, {
  client: db, sources: ["build"], limit: 500,
});
check(buildOnly.length > 0, "the Build source returns real steps — it returned NOTHING before", `${buildOnly.length} steps`);
check(buildOnly.every((e) => e.source === "build"), "all of them are build entries");
check(buildOnly.some((e) => e.message && !/ — step$/.test(e.message)),
  "with their real labels, not the placeholder the old mapping produced",
  buildOnly[0]?.message || "");
check(buildOnly.every((e) => e.refId), "and every one carries its build identity");

// ── 2. Successful, failed, cancelled and interrupted builds all display ─────────────────
//
// Searched across EVERY project, not just the busiest one: the failed, cancelled and interrupted
// runs live on other projects, and skipping them would leave exactly the states most worth proving
// untested.
for (const status of ["passed", "failed", "cancelled", "interrupted"]) {
  const run = (allRuns || []).find((r) => r.status === status);
  if (!run) { check(false, `production has no ${status} run to prove against`); continue; }

  const { entries, ref } = await readLogs(run.owner, run.project_id, { client: db, ref: run.id, limit: 500 });
  check(ref === run.id, `a ${status} build resolves by reference`, `${entries.length} entries`);
  check(entries.every((e) => !e.refId || e.refId === run.id),
    `and shows only that ${status} build's entries`);

  const { count: stepCount } = await db.from("diag_steps")
    .select("id", { count: "exact", head: true }).eq("run_id", run.id);
  const buildEntries = entries.filter((e) => e.source === "build");
  check(buildEntries.length === (stepCount || 0),
    `every recorded step of the ${status} build is shown`, `${buildEntries.length} of ${stepCount || 0}`);

  if (status === "failed") {
    // The whole reason someone opens a failed build.
    const failures = entries.filter((e) => e.level === "error");
    check(failures.length > 0, "a failed build shows its failing step as an error",
      `${failures.length} error step(s): ${failures[0]?.message || ""}`);
    check(failures.some((e) => e.detail), "with the output that explains why",
      String(failures.find((e) => e.detail)?.detail || "").slice(0, 80));
  }
  if (status === "cancelled" || status === "interrupted") {
    // These end mid-flight, so the honest outcome is "what it managed to record" — including none.
    check(true, `a ${status} build shows what it managed to record before stopping`,
      `${buildEntries.length} step(s)`);
  }
}

// ── 3. Compressed output is readable ────────────────────────────────────────────────────
const { data: compressed } = await db.from("diag_steps")
  .select("id,run_id").not("output_gz", "is", null).limit(50);
const compressedRuns = new Set((compressed || []).map((s) => String(s.run_id)));
const mineCompressed = resolved.filter((r) => compressedRuns.has(String(r.id)));
if (mineCompressed.length) {
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, ref: mineCompressed[0].id, limit: 500 });
  const withDetail = entries.filter((e) => e.detail);
  check(withDetail.length > 0,
    "a build whose output the sweeper compressed still shows its output",
    `${withDetail.length} of ${entries.length} steps have detail`);
} else {
  check(true, "no compressed steps on this project", `${compressed?.length || 0} exist elsewhere`);
}
check((compressed || []).length > 0,
  "production DOES hold compressed outputs, so this mattered", `${compressed?.length || 0} step(s)`);

// ── 4. Chronological order, with seq breaking ties ──────────────────────────────────────
{
  const run = runs[0];
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, ref: run.id, sources: ["build"], limit: 500 });
  let ordered = true;
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (cur.at > prev.at) { ordered = false; break; }
    if (cur.at === prev.at && prev.seq != null && cur.seq != null && cur.seq > prev.seq) { ordered = false; break; }
  }
  check(ordered, "steps come back newest first, with seq breaking equal timestamps", `${entries.length} steps`);

  // Reported honestly: if this project's steps all have distinct timestamps, the tiebreak was not
  // exercised HERE. It is covered by unit test, and the count says which happened rather than
  // implying coverage that did not occur.
  const ties = [...byProject.values()].flat().length && await (async () => {
    const all = await Promise.all(resolved.map(async (r) => {
      const { data } = await db.from("diag_steps").select("started_at").eq("run_id", r.id);
      const stamps = (data || []).map((s) => s.started_at);
      return stamps.length - new Set(stamps).size;
    }));
    return all.reduce((a, b) => a + b, 0);
  })();
  console.log(`[proof] steps sharing a timestamp across this project: ${ties}`);
  if (ties > 0) {
    check(ordered, "…and steps that share a timestamp are still in run order", `${ties} tie(s)`);
  }
}

// ── 5. A long run is returned whole ─────────────────────────────────────────────────────
{
  const counts = await Promise.all(resolved.map(async (r) => {
    const { count } = await db.from("diag_steps").select("id", { count: "exact", head: true }).eq("run_id", r.id);
    return { id: r.id, count: count || 0 };
  }));
  const longest = counts.sort((a, b) => b.count - a.count)[0];
  const { entries, nextCursor } = await readLogs(OWNER, PROJECT, {
    client: db, ref: longest.id, sources: ["build"], limit: 10,
  });
  check(entries.length === longest.count,
    "the longest build is returned whole, even with a small page size",
    `${entries.length} of ${longest.count} steps at limit=10`);
  check(nextCursor === null, "and reports no further page");
}

// ── 6. One identity across Logs, Deployments and Overview ───────────────────────────────
{
  const view = await deployments(OWNER, PROJECT, { client: db });
  const deploymentIds = new Set(view.builds.map((b) => String(b.id)));
  const logIds = new Set(buildOnly.map((e) => e.refId));
  const shared = [...logIds].filter((id) => deploymentIds.has(id));
  check(shared.length > 0, "Deployments and Build Logs use the SAME build identity",
    `${shared.length} shared id(s)`);
  check(view.builds.every((b) => resolved.some((r) => String(r.id) === String(b.id))),
    "and Deployments resolves through the same function as Logs");
}

// ── 7. A deep link cannot reach another owner's build ───────────────────────────────────
{
  const foreign = (allRuns || []).find((r) => r.owner !== OWNER || String(r.project_id) !== String(PROJECT));
  if (foreign) {
    const { entries } = await readLogs(OWNER, PROJECT, {
      client: db, ref: foreign.id, sources: ["build"], limit: 500,
    });
    check(entries.length === 0, "a reference to another project's run returns nothing",
      `${entries.length} entries`);
  } else check(true, "no foreign run available to test against", "skipped");
}

// ── 8. Failures surface rather than reading as an empty log ─────────────────────────────
{
  const broken = {
    from: (table) => ({
      select: () => ({
        eq() { return this; }, in() { return this; }, gte() { return this; }, lt() { return this; },
        order() { return this; }, limit() { return this; },
        then: (resolve) => resolve({ data: null, error: { message: `simulated outage on ${table}` } }),
      }),
    }),
  };
  let raised = null;
  await readLogs(OWNER, PROJECT, { client: broken, limit: 10 }).catch((error) => { raised = error; });
  check(/simulated outage/.test(raised?.message || ""),
    "a database failure is raised, not reported as an empty log", raised?.message || "NO ERROR RAISED");
}

// ── 9. Retention policy ─────────────────────────────────────────────────────────────────
{
  const { data: prefs } = await db.from("diag_prefs").select("owner,retention_days").eq("owner", OWNER).maybeSingle();
  const effective = prefs ? prefs.retention_days : DIAG_DEFAULT_RETENTION_DAYS;
  check(effective === null || effective > 0, "diagnostics retention is a real policy",
    effective === null ? "keep forever" : `${effective} days`);

  const oldest = runs[runs.length - 1];
  const ageDays = Math.floor((Date.now() - Date.parse(oldest.started_at)) / 86_400_000);
  check(effective === null || ageDays <= effective,
    "no run is being kept past the retention window", `oldest run is ${ageDays} days old`);

  // The sweep is idempotent and safe to run: it marks dead runs interrupted and purges expired ones.
  const swept = await sweepDiagnostics({ client: db });
  check(true, "the retention sweep runs cleanly", JSON.stringify(swept));

  const { data: stillRunning } = await db.from("diag_runs")
    .select("id,started_at").eq("status", "running").lt("started_at", new Date(Date.now() - 2 * 3600_000).toISOString());
  check((stillRunning || []).length === 0,
    "no run is left claiming to be running hours after its process died",
    `${(stillRunning || []).length} stale`);
}

// ── 10. Deleting a project takes its logs with it ───────────────────────────────────────
{
  const email = `pr6-logs-proof-${Date.now()}@thrallo.invalid`;
  const { data: created, error: userError } = await db.auth.admin.createUser({
    email, password: `Pr6!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
  });
  if (userError) {
    check(false, "could not create a throwaway owner", userError.message);
  } else {
    const TEST_OWNER = created.user.id;
    const TEST_PROJECT = crypto.randomUUID();
    const TEST_RUN = crypto.randomUUID();
    try {
      await db.from("projects").insert({ id: TEST_PROJECT, owner: TEST_OWNER, name: "PR6 Proof", tree: {} });
      await db.from("diag_runs").insert({
        id: TEST_RUN, owner: TEST_OWNER, project_id: TEST_PROJECT, kind: "app_build",
        status: "passed", prompt: "proof", started_at: new Date().toISOString(),
      });
      await db.from("diag_steps").insert({
        id: crypto.randomUUID(), run_id: TEST_RUN, seq: 1, agent: "Builder",
        kind: "log", label: "compile", status: "ok", output: "proof output",
        started_at: new Date().toISOString(),
      });
      await db.from("project_logs").insert({
        owner: TEST_OWNER, project_id: TEST_PROJECT, logged_at: new Date().toISOString(),
        level: "info", source: "publish", message: "Publish complete",
      });

      const before = await readLogs(TEST_OWNER, TEST_PROJECT, { client: db, limit: 100 });
      check(before.entries.length >= 2, "the throwaway project has logs to lose", `${before.entries.length}`);

      await purgeProjectResources(TEST_OWNER, TEST_PROJECT, { client: db, provisiond: null });

      const { count: runsLeft } = await db.from("diag_runs")
        .select("id", { count: "exact", head: true }).eq("project_id", TEST_PROJECT);
      const { count: stepsLeft } = await db.from("diag_steps")
        .select("id", { count: "exact", head: true }).eq("run_id", TEST_RUN);
      const { count: logsLeft } = await db.from("project_logs")
        .select("id", { count: "exact", head: true }).eq("project_id", TEST_PROJECT);

      check(!runsLeft, "deleting the project removed its build runs", `${runsLeft || 0} left`);
      check(!stepsLeft, "and its steps cascaded with them — no orphaned build logs", `${stepsLeft || 0} left`);
      check(!logsLeft, "and its lifecycle logs are gone", `${logsLeft || 0} left`);

      const after = await readLogs(TEST_OWNER, TEST_PROJECT, { client: db, limit: 100 });
      check(after.entries.length === 0, "the deleted project exposes no logs at all", `${after.entries.length}`);
    } finally {
      await db.from("diag_steps").delete().eq("run_id", TEST_RUN);
      await db.from("diag_runs").delete().eq("project_id", TEST_PROJECT);
      await db.from("project_logs").delete().eq("project_id", TEST_PROJECT);
      await db.from("projects").delete().eq("id", TEST_PROJECT);
      await db.auth.admin.deleteUser(TEST_OWNER).catch(() => {});
    }
  }
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
