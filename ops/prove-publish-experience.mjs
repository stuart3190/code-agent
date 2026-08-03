// Live proof for the publish experience. Runs a REAL publish in production.
//
// Everything the success panel shows is read from publish state rather than assembled from the
// publish event, so this asserts on `publishStates` — the exact function the panel's data comes
// from — and on the event the conversation receives.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { publishApp, unpublishApp } from "../shell/server/lib/appBuild/appPublishService.mjs";
import { publishStates } from "../shell/server/lib/publishState.mjs";
import { resolvePublishState } from "../shell/shared/publishResolution.mjs";
import { isDeploymentSettled, isDeploymentMoving } from "../shell/shared/deploymentState.mjs";
import { readLogs } from "../shell/server/lib/logs/logReader.mjs";
import { purgeProjectResources } from "../shell/server/lib/projectTeardown.mjs";

const db = serviceClient();
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const MARKER = "PUBLISH-EXPERIENCE-PROOF";

const appTree = (marker) => ({
  "package.json": JSON.stringify({
    name: "publish-proof", private: true, type: "module",
    scripts: { build: "vite build" },
    dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
    devDependencies: { vite: "^5.0.0", "@vitejs/plugin-react": "^4.0.0" },
  }, null, 2),
  "vite.config.js": "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n",
  "index.html": `<!doctype html><html><head><title>Publish Proof</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
  "src/main.jsx": "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  "src/App.jsx": `export default function App() { return <h1>${marker}</h1>; }\n`,
});

const email = `phase2-publish-proof-${Date.now()}@thrallo.invalid`;
const { data: created, error: userError } = await db.auth.admin.createUser({
  email, password: `P2!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
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

async function cleanup() {
  await unpublishApp(OWNER, PROJECT).catch(() => {});
  await purgeProjectResources(OWNER, PROJECT, { client: db, provisiond: null }).catch(() => {});
  await db.from("deployments").delete().eq("owner", OWNER);
  await db.from("published_sites").delete().eq("owner", OWNER);
  await db.from("projects").delete().eq("owner", OWNER);
  await db.from("ca_conversations").delete().eq("owner", OWNER);
  await db.from("ca_products").delete().eq("owner", OWNER);
  await db.from("ca_subscriptions").delete().eq("owner", OWNER);
  await db.auth.admin.deleteUser(OWNER).catch(() => {});
}

try {
  await db.from("ca_products").insert({ id: PRODUCT, owner: OWNER, name: "PublishProof" });
  await db.from("ca_conversations").insert({
    id: CONVERSATION, owner: OWNER, title: "PublishProof", product_id: PRODUCT, state: "idle",
    last_activity_at: new Date().toISOString(),
  });
  await db.from("projects").insert({
    id: PROJECT, owner: OWNER, name: "PublishProof", product_id: PRODUCT, tree: appTree(MARKER),
  });
  await db.from("ca_subscriptions").upsert({ owner: OWNER, plan: "pro", status: "active" }, { onConflict: "owner" });

  // A real build run, so View Logs has an exact log to open.
  const RUN = crypto.randomUUID();
  await db.from("diag_runs").insert({
    id: RUN, owner: OWNER, project_id: PROJECT, conversation_id: CONVERSATION,
    kind: "app_build", status: "passed", prompt: "build",
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  });
  await db.from("diag_steps").insert({
    id: crypto.randomUUID(), run_id: RUN, seq: 1, agent: "Builder", kind: "log",
    label: "compile", status: "ok", output: MARKER, started_at: new Date().toISOString(),
  });

  // ── A real publish ────────────────────────────────────────────────────────────────────
  console.log("[proof] publishing (a real production build)…");
  const result = await publishApp(ctx, {});
  check(result.deploymentNumber === 1, "the publish reports its version", `#${result.deploymentNumber}`);

  // ── The event the conversation receives ───────────────────────────────────────────────
  const published = emitted.find((e) => e.type === "published");
  check(!!published, "a published event is emitted");
  check(published?.payload?.deploymentNumber === 1,
    "carrying the version, so the receipt can name it rather than repeat the URL",
    `#${published?.payload?.deploymentNumber}`);
  check(!!published?.payload?.url && !!published?.payload?.projectId,
    "and the project it belongs to, so the celebration cannot leak to another",
    published?.payload?.projectId);

  // ── What the panel reads ──────────────────────────────────────────────────────────────
  const [state] = await publishStates(OWNER, db);
  check(!!state.deployment, "publish state carries the live deployment");
  check(state.deployment.number === 1, "with its version", `#${state.deployment.number}`);
  check(Number.isFinite(state.deployment.buildDurationMs) && state.deployment.buildDurationMs > 0,
    "the build duration is a real measurement", `${state.deployment.buildDurationMs}ms`);
  check(Number.isFinite(state.deployment.deployDurationMs) && state.deployment.deployDurationMs >= 0,
    "and the deploy duration is measured separately", `${state.deployment.deployDurationMs}ms`);
  check(state.deployment.buildDurationMs !== state.deployment.deployDurationMs,
    "they are genuinely two measurements, not one number shown twice");
  check(state.deployment.buildRunId === RUN,
    "the build run is named, so View Logs opens the exact build", state.deployment.buildRunId);
  check(state.lastAttempt?.number === 1, "and the newest attempt is the one serving");

  check(!("sourceAvailable" in state.deployment),
    "source_tree is not fetched for the panel — it is the entire app");

  // The deep link the version and View Logs produce must actually resolve.
  const logs = await readLogs(OWNER, PROJECT, { client: db, ref: state.deployment.buildRunId, limit: 50 });
  check(logs.entries.some((e) => (e.detail || "").includes(MARKER)),
    "and that build log opens on this build, not the whole stream",
    logs.entries.map((e) => e.message).join(", "));

  // ── Surfaces agree ────────────────────────────────────────────────────────────────────
  const resolved = resolvePublishState(await publishStates(OWNER, db));
  check(resolved.forProduct(PRODUCT).deployment.number === state.deployment.number,
    "the resolver every surface uses carries the same version");

  // ── A failed publish is reported beside what is still serving ─────────────────────────
  await db.from("projects")
    .update({ tree: { ...appTree(MARKER), "src/App.jsx": "export default function App() { return <h1>unclosed" } })
    .eq("id", PROJECT);
  let publishError = null;
  await publishApp(ctx, {}).catch((error) => { publishError = error; });
  check(!!publishError, "a broken app fails to publish", publishError?.code || "IT SUCCEEDED");

  const [afterFailure] = await publishStates(OWNER, db);
  check(afterFailure.deployment.number === 1,
    "what is SERVING is unchanged by the failure", `#${afterFailure.deployment.number}`);
  check(afterFailure.lastAttempt.number === 2 && afterFailure.lastAttempt.status === "failed",
    "and the newest attempt is named separately as failed",
    `#${afterFailure.lastAttempt.number} ${afterFailure.lastAttempt.status}`);
  check(!!afterFailure.lastAttempt.failureReason,
    "with a reason the panel can show", String(afterFailure.lastAttempt.failureReason).slice(0, 50));
  check(afterFailure.status === "published",
    "and the project still reads as live everywhere", afterFailure.status);

  // ── Terminal statuses stop the poll ───────────────────────────────────────────────────
  check(isDeploymentSettled(afterFailure.lastAttempt.status),
    "a failed deployment is terminal, so the panel stops polling for it");
  check(!isDeploymentMoving(afterFailure.deployment.status),
    "as is a live one");

  // ── Unpublish ─────────────────────────────────────────────────────────────────────────
  await unpublishApp(OWNER, PROJECT);
  const [offline] = await publishStates(OWNER, db);
  check(offline.status === "unpublished", "unpublishing reads as unpublished", offline.status);
  check(offline.deployment?.number === 1,
    "and the version that was last live is still known, so republishing is not a mystery",
    `#${offline.deployment?.number}`);
} catch (error) {
  check(false, "the proof ran to completion", error?.message || String(error));
  console.error(error);
} finally {
  await cleanup();
  const { count: left } = await db.from("deployments")
    .select("id", { count: "exact", head: true }).eq("owner", OWNER);
  check(!left, "throwaway deployment history cleaned up", `${left || 0} row(s) left`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
