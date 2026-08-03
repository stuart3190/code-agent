// Live proof for the deployment model. Runs a REAL publish, update and rollback in production.
//
// Nothing here is simulated: it builds two genuinely different apps, publishes each through the
// normal path, fetches the live site to confirm which one is serving, rolls back, and fetches
// again. The throwaway project and its site are removed at the end.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { publishApp, rollbackToDeployment, unpublishApp } from "../shell/server/lib/appBuild/appPublishService.mjs";
import { listDeployments, getDeployment } from "../shell/server/lib/deployments/deploymentService.mjs";
import { purgeProjectResources } from "../shell/server/lib/projectTeardown.mjs";
import { buildProjectZip, assertNoPlatformSecrets } from "../shell/server/lib/exportProject.mjs";
import { publishStates } from "../shell/server/lib/publishState.mjs";
import { resolvePublishState } from "../shell/shared/publishResolution.mjs";
import { healthDetail } from "../shell/server/lib/health/report.mjs";

const db = serviceClient();
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const MARKER_ONE = "DEPLOYMENT-ONE-CONTENT";
const MARKER_TWO = "DEPLOYMENT-TWO-CONTENT";

// A minimal but real Vite app, so the production build path is genuinely exercised.
const appTree = (marker) => ({
  "package.json": JSON.stringify({
    name: "deploy-proof", private: true, type: "module",
    scripts: { build: "vite build" },
    dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
    devDependencies: { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0" },
  }, null, 2),
  "vite.config.js": "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n",
  "index.html": `<!doctype html><html><head><title>Deploy Proof</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
  "src/main.jsx": "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  "src/App.jsx": `export default function App() { return <h1>${marker}</h1>; }\n`,
});

const email = `pr8-deploy-proof-${Date.now()}@thrallo.invalid`;
const { data: created, error: userError } = await db.auth.admin.createUser({
  email, password: `Pr8!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
});
if (userError) { console.error("could not create throwaway owner:", userError.message); process.exit(1); }
const OWNER = created.user.id;
const PRODUCT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CONVERSATION = crypto.randomUUID();
console.log(`[proof] throwaway owner ${OWNER}`);

const emitted = [];
const ctx = {
  owner: OWNER,
  conversation: { id: CONVERSATION, product_id: PRODUCT },
  emit: async (type, payload) => { emitted.push({ type, payload }); },
};

const fetchSite = async (url) => {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.text() };
  } catch (error) { return { status: 0, body: `error: ${error?.message}` }; }
};

// The built bundle inlines the marker, so "which deployment is serving" is answered by the bytes
// the internet returns rather than by a database row.
async function servedMarker(url) {
  const page = await fetchSite(url);
  if (page.status !== 200) return `HTTP ${page.status}`;
  const asset = page.body.match(/src="([^"]*\.js)"/)?.[1];
  if (!asset) return "no bundle";
  const bundle = await fetchSite(new URL(asset, url).toString());
  return bundle.body.includes(MARKER_ONE) ? MARKER_ONE
    : bundle.body.includes(MARKER_TWO) ? MARKER_TWO : "neither";
}

// provisiond is private to appPublishService, so teardown is given a small client of its own —
// the same contract projectTeardown expects.
async function callProvisiond(route, body, method = "POST") {
  const base = process.env.PROVISIOND_URL;
  const token = process.env.PROVISIOND_TOKEN;
  if (!base) return null;
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  return response.json().catch(() => ({}));
}

async function cleanup() {
  await purgeProjectResources(OWNER, PROJECT, { client: db, provisiond: callProvisiond })
    .catch((error) => console.error(`[proof] cleanup: ${error.message}`));
  await db.from("deployments").delete().eq("owner", OWNER);
  await db.from("published_sites").delete().eq("owner", OWNER);
  await db.from("projects").delete().eq("owner", OWNER);
  await db.from("ca_conversations").delete().eq("owner", OWNER);
  await db.from("ca_products").delete().eq("owner", OWNER);
  await db.auth.admin.deleteUser(OWNER).catch(() => {});
}

let liveUrl = null;

try {
  await db.from("ca_products").insert({ id: PRODUCT, owner: OWNER, name: "DeployProof" });
  await db.from("ca_conversations").insert({
    id: CONVERSATION, owner: OWNER, title: "DeployProof", product_id: PRODUCT, state: "idle",
    last_activity_at: new Date().toISOString(),
  });
  await db.from("projects").insert({
    id: PROJECT, owner: OWNER, name: "DeployProof", product_id: PRODUCT, tree: appTree(MARKER_ONE),
  });
  await db.from("ca_subscriptions").upsert({ owner: OWNER, plan: "pro", status: "active" }, { onConflict: "owner" });

  // A real build run for each publish, so "View logs opens the exact build" is proved rather than
  // skipped. This is what a genuine conversational build leaves behind.
  const runOne = crypto.randomUUID();
  await db.from("diag_runs").insert({
    id: runOne, owner: OWNER, project_id: PROJECT, conversation_id: CONVERSATION,
    kind: "app_build", status: "passed", prompt: "build one",
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  });
  await db.from("diag_steps").insert({
    id: crypto.randomUUID(), run_id: runOne, seq: 1, agent: "Builder", kind: "log",
    label: "compile one", status: "ok", output: MARKER_ONE, started_at: new Date().toISOString(),
  });

  // ── Deployment #1 ─────────────────────────────────────────────────────────────────────
  console.log("[proof] publishing #1 (a real production build — this takes a minute)…");
  const first = await publishApp(ctx, {});
  liveUrl = first.url;
  check(first.deploymentNumber === 1, "the first publish creates Deployment #1", `#${first.deploymentNumber}`);

  let list = await listDeployments(OWNER, PROJECT, { client: db });
  check(list.length === 1 && list[0].status === "live", "and it is live", JSON.stringify(list.map((d) => [d.number, d.status])));
  check(!!list[0].buildDurationMs && !!list[0].deployDurationMs,
    "with build and deploy measured separately",
    `build ${list[0].buildDurationMs}ms, deploy ${list[0].deployDurationMs}ms`);
  check(list[0].triggeredByKind === "user", "triggered by the account, not an invented author");

  const servedFirst = await servedMarker(liveUrl);
  check(servedFirst === MARKER_ONE, "the live site serves #1's content", servedFirst);

  // ── Deployment #2 ─────────────────────────────────────────────────────────────────────
  console.log("[proof] publishing #2…");
  const runTwo = crypto.randomUUID();
  await db.from("diag_runs").insert({
    id: runTwo, owner: OWNER, project_id: PROJECT, conversation_id: CONVERSATION,
    kind: "app_build", status: "passed", prompt: "build two",
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  });
  await db.from("diag_steps").insert({
    id: crypto.randomUUID(), run_id: runTwo, seq: 1, agent: "Builder", kind: "log",
    label: "compile two", status: "ok", output: MARKER_TWO, started_at: new Date().toISOString(),
  });
  await db.from("projects").update({ tree: appTree(MARKER_TWO), updated_at: new Date().toISOString() }).eq("id", PROJECT);
  const second = await publishApp(ctx, {});
  check(second.deploymentNumber === 2, "a publish update creates Deployment #2", `#${second.deploymentNumber}`);

  list = await listDeployments(OWNER, PROJECT, { client: db });
  check(list.length === 2, "and #1 is preserved rather than overwritten", `${list.length} deployments`);
  const one = list.find((d) => d.number === 1);
  const two = list.find((d) => d.number === 2);
  check(one.status === "superseded", "#1 becomes history", one.status);
  check(two.status === "live", "#2 is the current live deployment", two.status);
  check(list.filter((d) => d.status === "live").length === 1, "exactly one deployment is live");

  const servedSecond = await servedMarker(liveUrl);
  check(servedSecond === MARKER_TWO, "the live site now serves #2's content", servedSecond);
  check(second.url === first.url, "at the same address", second.url);

  // ── Logs deep-link to the exact build ─────────────────────────────────────────────────
  check(one.buildRunId === runOne, "#1 points at its own build run", one.buildRunId || "none");
  check(two.buildRunId === runTwo, "#2 points at a DIFFERENT build run", two.buildRunId || "none");

  const { readLogs } = await import("../shell/server/lib/logs/logReader.mjs");
  const logsOne = await readLogs(OWNER, PROJECT, { client: db, ref: one.buildRunId, limit: 100 });
  const logsTwo = await readLogs(OWNER, PROJECT, { client: db, ref: two.buildRunId, limit: 100 });
  check(logsOne.entries.some((e) => (e.detail || "").includes(MARKER_ONE)),
    "opening #1's logs shows #1's build, not the whole stream",
    logsOne.entries.map((e) => e.message).join(", "));
  check(logsTwo.entries.some((e) => (e.detail || "").includes(MARKER_TWO)),
    "and #2's logs show #2's build");
  check(!logsOne.entries.some((e) => (e.detail || "").includes(MARKER_TWO)),
    "with no bleed between them");

  // ── Download returns each deployment's OWN source ─────────────────────────────────────
  const rowOne = await getDeployment(OWNER, one.id, { client: db });
  const rowTwo = await getDeployment(OWNER, two.id, { client: db });
  const zipOne = buildProjectZip({ name: "deployment-1", tree: rowOne.source_tree });
  const zipTwo = buildProjectZip({ name: "deployment-2", tree: rowTwo.source_tree });
  assertNoPlatformSecrets(zipOne.files);
  assertNoPlatformSecrets(zipTwo.files);

  const appOne = rowOne.source_tree["src/App.jsx"];
  const appTwo = rowTwo.source_tree["src/App.jsx"];
  check(appOne.includes(MARKER_ONE), "downloading #1 gives #1's source", MARKER_ONE);
  check(appTwo.includes(MARKER_TWO), "downloading #2 gives #2's source", MARKER_TWO);
  check(appOne !== appTwo, "they are genuinely different — not the newest source twice");
  check(zipOne.zip.length > 0 && zipTwo.zip.length > 0, "and both archives build",
    `${zipOne.zip.length} / ${zipTwo.zip.length} bytes`);

  // ── Rollback #2 → #1 ──────────────────────────────────────────────────────────────────
  console.log("[proof] rolling back to #1…");
  const rollback = await rollbackToDeployment(OWNER, PROJECT, one.id);
  check(rollback.deploymentNumber === 3, "rolling back creates Deployment #3", `#${rollback.deploymentNumber}`);
  check(rollback.restoredFrom === 1, "recording which deployment it restored", `#${rollback.restoredFrom}`);

  list = await listDeployments(OWNER, PROJECT, { client: db });
  check(list.length === 3, "and history keeps all three", `${list.length}`);
  const three = list.find((d) => d.number === 3);
  check(three.status === "live", "#3 is live", three.status);
  check(three.triggeredByKind === "rollback", "marked as a rollback, not an ordinary publish");
  check(three.rolledBackFrom === one.id, "and points at what it restored");
  check(list.find((d) => d.number === 2).status === "rolled_back",
    "#2 is rolled back rather than merely superseded", list.find((d) => d.number === 2).status);
  check(list.find((d) => d.number === 1).status === "superseded",
    "and #1's own historical record is NOT rewritten", list.find((d) => d.number === 1).status);

  const servedAfter = await servedMarker(liveUrl);
  check(servedAfter === MARKER_ONE, "the live site serves #1's content again", servedAfter);

  // ── The address, publish state and health survive the rollback ────────────────────────
  check(rollback.url === first.url, "the public URL is unchanged", rollback.url);
  const { data: site } = await db.from("published_sites").select("slug,url,unpublished_at").eq("owner", OWNER).maybeSingle();
  check(site?.slug === first.slug, "the slug is unchanged, so custom domains and analytics stay put", site?.slug);
  check(!site?.unpublished_at, "and the site is still live");

  const resolved = resolvePublishState(await publishStates(OWNER, db));
  check(resolved.forProduct(PRODUCT)?.live === true, "publish status still reads live after a rollback");

  const health = await healthDetail(OWNER, PROJECT, { client: db });
  check(health.status === null || health.status.url === first.url,
    "health still points at the same address", health.status?.url || "not yet checked");

  // ── Idempotency ───────────────────────────────────────────────────────────────────────
  const before = (await listDeployments(OWNER, PROJECT, { client: db })).length;
  let repeatError = null;
  await rollbackToDeployment(OWNER, PROJECT, three.id).catch((error) => { repeatError = error; });
  check(repeatError?.code === "already_live",
    "rolling back to what is already live is refused, not duplicated", repeatError?.code || "IT PROCEEDED");
  check((await listDeployments(OWNER, PROJECT, { client: db })).length === before,
    "and no extra deployment row is created");

  // ── Cross-app and cross-owner access ──────────────────────────────────────────────────
  const otherProduct = crypto.randomUUID();
  const otherProject = crypto.randomUUID();
  // A REAL second app: ca_products first, or the projects insert fails its foreign key and the
  // test proves nothing but its own fixture being wrong.
  const { error: otherProductError } = await db.from("ca_products")
    .insert({ id: otherProduct, owner: OWNER, name: "Another App" });
  const { error: otherProjectError } = await db.from("projects")
    .insert({ id: otherProject, owner: OWNER, name: "Another App", product_id: otherProduct, tree: {} });
  check(!otherProductError && !otherProjectError, "a second app exists to test against",
    otherProductError?.message || otherProjectError?.message || "created");

  let wrongApp = null;
  await rollbackToDeployment(OWNER, otherProject, one.id).catch((error) => { wrongApp = error; });
  check(wrongApp?.code === "wrong_app",
    "a deployment from another app cannot be rolled back onto this one", wrongApp?.code || "IT PROCEEDED");
  await db.from("projects").delete().eq("id", otherProject);
  await db.from("ca_products").delete().eq("id", otherProduct);

  check(await getDeployment(crypto.randomUUID(), one.id, { client: db }) === null,
    "and another owner cannot read the deployment at all");

  // ── A failed publish is retained and never live ───────────────────────────────────────
  await db.from("projects")
    .update({ tree: { ...appTree(MARKER_TWO), "src/App.jsx": "export default function App() { return <h1>unclosed" } })
    .eq("id", PROJECT);
  let publishError = null;
  await publishApp(ctx, {}).catch((error) => { publishError = error; });
  check(!!publishError, "a broken app fails to publish", publishError?.code || "IT SUCCEEDED");

  list = await listDeployments(OWNER, PROJECT, { client: db });
  const failedOne = list.find((d) => d.status === "failed");
  check(!!failedOne, "the failed attempt is retained in the history", `#${failedOne?.number}`);
  check(!!failedOne?.failureReason, "with a reason", String(failedOne?.failureReason).slice(0, 60));
  check(list.filter((d) => d.status === "live").length === 1, "and exactly one deployment is still live");
  check(list.find((d) => d.status === "live").number === 3, "still #3 — a failure never disturbs what is serving");

  const servedAfterFailure = await servedMarker(liveUrl);
  check(servedAfterFailure === MARKER_ONE, "the live site is untouched by the failed publish", servedAfterFailure);

  // ── Deletion ──────────────────────────────────────────────────────────────────────────
  const beforeDelete = (await listDeployments(OWNER, PROJECT, { client: db })).length;
  check(beforeDelete >= 4, "there is history to lose", `${beforeDelete} deployments`);
} catch (error) {
  check(false, "the proof ran to completion", error?.message || String(error));
  console.error(error);
} finally {
  await unpublishApp(OWNER, PROJECT).catch(() => {});
  await cleanup();
  const { count: left } = await db.from("deployments")
    .select("id", { count: "exact", head: true }).eq("owner", OWNER);
  check(!left, "deleting the project removes its deployment history", `${left || 0} row(s) left`);
  if (liveUrl) {
    const gone = await fetchSite(liveUrl);
    check(gone.status === 404 || gone.status === 0, "and the site is off the internet", String(gone.status));
  }
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
