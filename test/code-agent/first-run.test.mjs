// First run, starters and history.
//
// The rules that matter here are the ones that are easy to get backwards: an absent onboarding
// record means "show it", a narrowed empty view is not a first-time experience, and reusing a
// prompt is a NEW build rather than a rollback.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { STARTER_CATEGORIES, STARTER_MODEL_PREF, starterById } from "../../shell/shared/starters.mjs";
import { MemoryConversationStore } from "../../shell/server/lib/conversationStore.mjs";

const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const readCode = async (p) => (await read(p))
  .replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

const OWNER = "77777777-7777-4777-8777-777777777777";

// ── Onboarding defaults the safe way ────────────────────────────────────────────────────

test("an account that has never onboarded is pending", async () => {
  const store = new MemoryConversationStore();
  const state = await store.getOnboarding(OWNER);
  assert.deepEqual(state, {}, "no record at all");
  // The route derives `pending` from the ABSENCE of completedAt, so a missing row can only ever
  // mean "show it". Defaulting the other way would hide the tour from every genuinely new account,
  // which is the failure nobody would notice until a customer said so.
  const route = await readCode("../../shell/server/routes/onboarding.mjs");
  assert.match(route, /pending: !state\.completedAt/);
});

test("completing and skipping both stop it returning, and are told apart", async () => {
  const store = new MemoryConversationStore();
  await store.setOnboarding(OWNER, { completedAt: "2026-08-06T00:00:00Z", skipped: true });
  const state = await store.getOnboarding(OWNER);
  assert.equal(state.skipped, true, "a skip is recorded as a skip, not as a completion");
  assert.ok(state.completedAt, "and still stops it reappearing");
});

test("reopening clears completion without pretending this is a new account", async () => {
  const route = await readCode("../../shell/server/routes/onboarding.mjs");
  assert.match(route, /completedAt: null, skipped: false, step: 0, reopenedAt: now/);
});

test("progress is stored so a closed tab resumes rather than restarts", async () => {
  const store = new MemoryConversationStore();
  await store.setOnboarding(OWNER, { step: 3 });
  assert.equal((await store.getOnboarding(OWNER)).step, 3);
  // Merged, not replaced: recording a step must not wipe a completion written a moment earlier.
  await store.setOnboarding(OWNER, { completedAt: "2026-08-06T00:00:00Z" });
  const state = await store.getOnboarding(OWNER);
  assert.equal(state.step, 3);
  assert.ok(state.completedAt);
});

test("onboarding state is kept out of the agent's memory blob", async () => {
  const store = await readCode("../../shell/server/lib/conversationStore.mjs");
  // profile_encrypted is decrypted into the Lead Agent system prompt as owner memory. Whether
  // someone dismissed a tour is interface state and would be context spent on nothing, every turn.
  assert.match(store, /from\("ca_owner_profile"\)\.select\("onboarding"\)/);
  assert.doesNotMatch(store, /profile_encrypted[^\n]*onboarding/);
  const migration = await read("../../supabase/migrations/20260806090000_onboarding_state.sql");
  assert.match(migration, /add column if not exists onboarding jsonb/);
});

// ── Starters are prompts, not templates ─────────────────────────────────────────────────

test("every required category exists and is complete", () => {
  const required = ["saas", "landing", "dashboard", "crm", "booking", "ecommerce", "portfolio", "blog", "ai-chat", "docs"];
  assert.deepEqual(STARTER_CATEGORIES.map((s) => s.id).sort(), [...required].sort());
  for (const starter of STARTER_CATEGORIES) {
    for (const field of ["title", "description", "icon", "outcome", "prompt"]) {
      assert.ok(starter[field], `${starter.id} is missing ${field}`);
    }
    assert.equal(starterById(starter.id).title, starter.title);
  }
  assert.equal(starterById("nope"), null);
});

test("no starter is a placeholder", () => {
  for (const starter of STARTER_CATEGORIES) {
    // Length alone is a weak signal, so this checks for the properties that make a prompt expert:
    // it names the audience, states entities or screens, and says what NOT to build.
    assert.ok(starter.prompt.length > 400, `${starter.id}: too short to be an expert prompt`);
    assert.match(starter.prompt, /Do not build/i, `${starter.id}: must say what to leave out`);
    assert.match(starter.prompt, /first/i, `${starter.id}: must name what to get right first`);
    assert.doesNotMatch(starter.prompt, /TODO|lorem|placeholder|example\.com/i, `${starter.id}: placeholder text`);
    assert.ok(starter.outcome.length > 30, `${starter.id}: outcome must say what appears`);
  }
});

test("starters name an audience rather than a generic noun", () => {
  // "a CRM" produces a generic CRM. Each prompt has to say who it is for, which is the single
  // biggest difference between a first build that is usable and one that is a demo.
  for (const starter of STARTER_CATEGORIES) {
    assert.match(starter.prompt, /\bfor\b/i, `${starter.id}: no audience named`);
  }
});

test("the gallery does not claim a model the router may not honour", async () => {
  // A per-starter "recommended model" would be a promise the router is free to ignore — and on a
  // Free plan, or with a BYOK key, it frequently would be.
  assert.equal(STARTER_MODEL_PREF, "auto");
  const starters = await readCode("../../shell/shared/starters.mjs");
  assert.doesNotMatch(starters, /recommendedModel|model: "(claude|gpt|gemini)/i);
});

test("choosing a starter seeds the composer and never sends on the user's behalf", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  const gallery = await readCode("../../shell/web/src/start/StarterGallery.jsx");
  // The whole value of an expert prompt is being an editable first draft.
  assert.match(gallery, /textarea/, "the prompt is presented as editable text");
  assert.match(shell, /setComposerSeed\(\(current\) => \(\{ text, nonce: current\.nonce \+ 1 \}\)\)/,
    "a nonce, so picking the same starter twice re-seeds the box");
  assert.doesNotMatch(gallery, /onSend\(/, "the gallery never sends anything itself");
});

test("there is one build pipeline, not a template engine", async () => {
  const gallery = await readCode("../../shell/web/src/start/StarterGallery.jsx");
  // A starter must reach the builder by the same road a typed sentence does.
  assert.doesNotMatch(gallery, /scaffold|template_id|applyTemplate|createFromTemplate/i);
  // routes/templates.mjs exists as retired Buildr101 code and is deliberately unmounted — the
  // route manifest records that decision. What matters is that nothing MOUNTS it, so a starter
  // cannot reach the builder by any road but the ordinary one.
  const index = await readCode("../../shell/server/index.mjs");
  assert.doesNotMatch(index, /routes\/templates\.mjs/, "no template route is mounted");
  const manifest = await readCode("../../test/code-agent/route-manifest.test.mjs");
  assert.match(manifest, /"templates\.mjs":/, "and its retirement stays recorded");
});

// ── History is the existing record, exposed ─────────────────────────────────────────────

test("history reads the tables builds already write", async () => {
  const route = await readCode("../../shell/server/routes/history.mjs");
  for (const table of ["diag_runs", "deployments", "build_checkpoints", "ca_conversations"]) {
    assert.ok(route.includes(table), `${table} must be a source`);
  }
  // A second history model would be two records of one event, and the one that drifted would be
  // the one the customer is shown.
  assert.doesNotMatch(route, /prompt_history|create table/i);
});

test("history is owner-scoped on every query", async () => {
  const route = await readCode("../../shell/server/routes/history.mjs");
  const queries = route.match(/\.from\("[a-z_]+"\)/g) || [];
  const scoped = route.match(/\.eq\("owner", owner(\.id)?\)/g) || [];
  assert.ok(queries.length >= 4, `expected several queries, found ${queries.length}`);
  assert.ok(scoped.length >= queries.length,
    `every query must carry the owner filter — ${queries.length} queries, ${scoped.length} owner filters`);
});

test("history paginates and bounds what a caller can ask for", async () => {
  const route = await readCode("../../shell/server/routes/history.mjs");
  assert.match(route, /const MAX_PAGE = 50/);
  assert.match(route, /Math\.min\(MAX_PAGE/, "an unbounded limit is not accepted");
  assert.match(route, /nextOffset/, "and the client is told where the next page starts");
});

test("history search cannot be turned into a wildcard scan", async () => {
  const route = await readCode("../../shell/server/routes/history.mjs");
  // % and _ are ILIKE metacharacters; unescaped, a search for "%" matches every row a customer has.
  assert.match(route, /replace\(\/\[%_\]\/g/, "search input must be escaped");
});

test("history does not expose the system prompt or agent reasoning", async () => {
  const route = await readCode("../../shell/server/routes/history.mjs");
  const selected = route.match(/\.select\("([^"]+)"/g) || [];
  const columns = selected.join(",");
  // The audit trail lives behind the diagnostics routes. History is what the CUSTOMER did and what
  // came back — not the plan text, the agent roster, or token accounting.
  for (const banned of ["instructions", "system_prompt", "plan", "agents", "totals"]) {
    assert.ok(!columns.includes(banned), `${banned} must not be selected into history`);
  }
});

// ── Reuse is a new build, never a rollback ──────────────────────────────────────────────

test("Use again is named for what it does", async () => {
  const view = await readCode("../../shell/web/src/history/HistoryView.jsx");
  assert.match(view, /Use again/);
  assert.match(view, /Edit &amp; rebuild/);
  // Calling a new build a rollback would be a lie about what happened to the live site.
  assert.doesNotMatch(view, /Rollback|Roll back/i);
});

test("reuse starts a draft rather than mutating the record", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  assert.match(shell, /this starts a new build/,
    "the customer is told it is new work, not a restoration");
  const view = await readCode("../../shell/web/src/history/HistoryView.jsx");
  assert.doesNotMatch(view, /PATCH|DELETE|updateHistory/, "history rows are never written from here");
});

// ── A narrowed empty view is not a first run ────────────────────────────────────────────

test("the first-run gallery is gated on the account, not the current view", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  // counts.all describes the ACCOUNT. Gating on the rendered list would show "your first build" to
  // someone with forty projects who filtered to Updates.
  assert.match(shell, /\(counts\.all \?\? 0\) === 0 && !search && !archived && !favouritesOnly/);
});

test("each narrowed empty view explains itself instead of saying nothing here", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  for (const phrase of ["Nothing is archived", "No favourites yet", "Nothing is live yet", "Every published project is up to date"]) {
    assert.ok(shell.includes(phrase), `missing empty-state copy: ${phrase}`);
  }
  assert.doesNotMatch(shell, /"Nothing here\."/, "generic wording is what this replaces");
});

test("empty states across the product say what the section is and what to do", async () => {
  const checks = [
    ["../../shell/web/src/publish/AnalyticsView.jsx", /No visits recorded in this period/],
    ["../../shell/web/src/publish/AnalyticsView.jsx", /Nothing is being measured yet/],
    ["../../shell/web/src/publish/DomainsSection.jsx", /No custom domain connected/],
    ["../../shell/web/src/publish/DeploymentsView.jsx", /Nothing has been deployed yet/],
    ["../../shell/web/src/settings/TokensTab.jsx", /No active keys/],
    ["../../shell/web/src/settings/NotificationsTab.jsx", /Nothing yet/],
    ["../../shell/web/src/history/HistoryView.jsx", /Nothing here yet/],
  ];
  for (const [file, pattern] of checks) {
    assert.match(await readCode(file), pattern, `${file}: empty state copy missing`);
  }
});

test("a published site with zero visits is told apart from an unpublished one", async () => {
  const view = await readCode("../../shell/web/src/publish/AnalyticsView.jsx");
  // Same screen, different situations, different next actions — and zero visits is a real
  // measurement rather than missing data.
  assert.match(view, /this is a real zero, not missing data/);
});

test("an empty archive can actually show its empty state", async () => {
  const { groupProjects } = await import("../../shell/web/src/publish/publishLifecycle.js");
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  // The archived branch built its group unconditionally, so an empty archive produced ONE group
  // containing nothing. `groups.length === 0` was never true there, so the "Nothing is archived"
  // copy could not render and the archive showed a heading with a void under it.
  assert.match(shell, /\.filter\(\(g\) => g\.items\.length\)/,
    "an empty group must not count as a group");
  // The non-archived path already dropped empty groups; this is the rule the archive missed.
  assert.deepEqual(groupProjects([]), [], "grouping nothing yields no groups");
});
