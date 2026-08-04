// Production-quality regressions.
//
// Each test here corresponds to a defect found by auditing rather than by using the product — the
// kind that ordinary feature tests pass straight over because the feature does work, right up until
// a provider goes quiet, a table grows past a page, or an operator reads a health endpoint.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { applyEvent, emptyConversationView, replayEvents } from "../../shell/web/src/chat/conversationState.js";
import { pagedRows } from "../../shell/server/lib/projectTeardown.mjs";

const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const readCode = async (p) => (await read(p))
  .replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

// ── The ten-minute "Understanding request" ──────────────────────────────────────────────
//
// Two independent causes, either of which alone produced it.

test("a recovered conversation stops the roster spinning", () => {
  // The server's sweeper flipped the stuck conversation back to idle after five minutes and said
  // so with a `lead_recovered` event. Nothing in the reducer handled it, so it fell through to
  // `default: break` as "future vocabulary" — and the screen kept showing
  // "Lead Agent · Understanding request…" indefinitely. The recovery worked; the UI never learned.
  const view = replayEvents([
    { sequence: 1, type: "message", payload: { role: "user", text: "build me a CRM" } },
    { sequence: 2, type: "agent_spawned", payload: { agent: "Lead Agent", status: "Understanding request…" } },
    { sequence: 3, type: "agent_spawned", payload: { agent: "Builder", status: "Writing the schema…" } },
  ]);
  assert.equal(view.thinking, true, "precondition: it is working");
  assert.ok(view.roster.every((a) => a.state === "working"));

  const after = applyEvent(view, {
    sequence: 4, type: "lead_recovered",
    payload: { message: "I lost my train of thought during a restart — everything above is saved." },
  });
  assert.equal(after.thinking, false, "the spinner must stop");
  assert.equal(after.waiting, false);
  assert.ok(after.roster.every((a) => a.state !== "working"),
    "every agent stops, not just the Lead Agent — a specialist would otherwise spin on alone");
  const last = after.items[after.items.length - 1];
  assert.equal(last.kind, "failure");
  assert.match(last.text, /train of thought/, "and it says what happened, in words");
});

test("a recovered conversation can be continued, not just abandoned", () => {
  const view = applyEvent(emptyConversationView(), {
    sequence: 1, type: "lead_recovered", payload: {},
  });
  // The default sentence has to tell the customer what to DO, because the conversation is usable.
  assert.match(view.items[0].text, /continue/i);
});

test("the Anthropic call is bounded, like every other provider's", async () => {
  const provider = await readCode("../../src/providers/anthropicProvider.mjs");
  // This had no timeout and no abort signal of ANY kind, while OpenAI, Gemini and xAI all had one.
  // A connection that opened and then went silent hung forever: the turn neither threw nor
  // returned, so no error path ran and nothing recovered it.
  assert.match(provider, /AbortController/, "the request must be abortable");
  assert.match(provider, /signal: controller\.signal/, "and the signal must actually be passed");
  assert.match(provider, /anthropic_timeout/, "a stall must be reported as a stall");

  // A stall timeout rather than a deadline: a long generation is healthy, silence is not.
  assert.match(provider, /armStall\(\)/);
  const streamAt = provider.indexOf("for await (const chunk of res.body)");
  const rearmAt = provider.indexOf("armStall()", streamAt);
  assert.ok(rearmAt > streamAt && rearmAt < streamAt + 400,
    "each chunk must reset the timer, or a slow-but-healthy stream would be killed mid-answer");
});

test("the stall timeout cannot be configured away", async () => {
  const provider = await readCode("../../src/providers/anthropicProvider.mjs");
  assert.match(provider, /function boundedMs\(value, fallback\)/);
  // A typo or a stray 0 must not restore the unbounded state this is here to fix.
  const { boundedMs } = await import(`data:text/javascript,${encodeURIComponent(
    provider.slice(provider.indexOf("function boundedMs")).match(/function boundedMs[\s\S]*?\n}/)[0]
    + "\nexport { boundedMs };",
  )}`);
  assert.equal(boundedMs("0", 120_000), 120_000);
  assert.equal(boundedMs("", 120_000), 120_000);
  assert.equal(boundedMs("not a number", 120_000), 120_000);
  assert.equal(boundedMs("10", 120_000), 120_000, "an absurdly small value is a mistake, not a choice");
  assert.equal(boundedMs("30000", 120_000), 30_000, "a real value is honoured");
});

// ── Silent truncation ───────────────────────────────────────────────────────────────────

test("a purge reads every row, not the first page", async () => {
  // PostgREST caps an unbounded select and the cap is SILENT — a short list, not an error. The
  // end-user purge used a bare .select(), so a popular app's users beyond the cap were never
  // deleted, leaving live auth identities for an app that no longer existed.
  const rows = Array.from({ length: 1250 }, (_, i) => ({ auth_user_id: `u${i}` }));
  const client = {
    from: () => {
      const f = {};
      let range = null;
      const api = {
        select: () => api,
        eq: (c, v) => { f[c] = v; return api; },
        range: (from, to) => { range = [from, to]; return api; },
        then: (resolve) => resolve({ data: rows.slice(range[0], range[1] + 1), error: null }),
      };
      return api;
    },
  };
  const seen = [];
  for await (const page of pagedRows(client, "app_users", "auth_user_id", { app_id: "p1" })) {
    seen.push(...page);
  }
  assert.equal(seen.length, 1250, "every row, across pages");
  assert.equal(new Set(seen.map((r) => r.auth_user_id)).size, 1250, "and none twice");
});

test("paging stops rather than looping forever on an empty table", async () => {
  const client = {
    from: () => {
      const api = {
        select: () => api, eq: () => api, range: () => api,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return api;
    },
  };
  let pages = 0;
  for await (const _ of pagedRows(client, "app_users", "id")) pages += 1;
  assert.equal(pages, 0);
});

test("a paging error is raised, never mistaken for the end of the data", async () => {
  const client = {
    from: () => {
      const api = {
        select: () => api, eq: () => api, range: () => api,
        then: (resolve) => resolve({ data: null, error: { message: "connection reset" } }),
      };
      return api;
    },
  };
  await assert.rejects(async () => {
    for await (const _ of pagedRows(client, "app_users", "id")) { /* consume */ }
  }, /connection reset/, "silently treating a failure as 'no more rows' is how a purge half-runs");
});

test("the project purge pages every table whose completeness matters", async () => {
  const teardown = await readCode("../../shell/server/lib/projectTeardown.mjs");
  assert.doesNotMatch(teardown, /from\("app_users"\)\s*\.select\([^)]*\)\s*\.eq\([^)]*\);/,
    "the bare select is what silently skipped end users past the cap");
  for (const table of ["app_users", "diag_runs"]) {
    assert.ok(teardown.includes(`pagedRows(client, "${table}"`), `${table} must be paged`);
  }
});

// ── Health tells the truth about THIS product ───────────────────────────────────────────

test("/api/health reports Thrallo's Stripe, not Buildr101's", async () => {
  const index = await readCode("../../shell/server/index.mjs");
  // It read haveStripeEnv(), which checks STRIPE_SECRET_KEY / STRIPE_PRICE_STARTER — the LEGACY
  // Buildr101 variables. Thrallo reads THRALLO_STRIPE_* by design, so production served
  // `"stripe": false` while Thrallo billing was fully configured and live: the one signal an
  // operator checks to answer "can customers pay?", answering about a different product.
  assert.match(index, /stripe: thralloStripeConfigured\(\)/);
  assert.match(index, /stripeWebhook: thralloWebhookConfigured\(\)/,
    "checkout working and webhooks arriving are different failures with different fixes");
  assert.doesNotMatch(index, /haveStripeEnv/,
    "and the legacy check must be gone, not merely unused");
});

test("no mounted code imports the legacy Buildr101 billing services", async () => {
  const index = await readCode("../../shell/server/index.mjs");
  assert.doesNotMatch(index, /lib\/services\.mjs/,
    "services.mjs is the Buildr101 credit-ledger stack; nothing on Thrallo's live path may reach it");
});

// ── The Settings counts that were quietly unavailable ───────────────────────────────────

test("Settings counts filter on a column published_sites actually has", async () => {
  const route = await readCode("../../shell/server/routes/settings.mjs");
  // `published_sites.live` does not exist. The filter threw, the catch turned it into
  // `counts: null`, and every customer's Usage tab read "These counts are temporarily
  // unavailable" from the moment Phase 6 shipped. Production logged it — with a blank reason.
  assert.doesNotMatch(route, /count\("published_sites", \{ live:/);
  assert.match(route, /count\("published_sites", \{ unpublished_at: null \}\)/,
    "being live IS having no unpublished_at — the same rule resolvePublishState applies");
});

test("a swallowed failure still says why", async () => {
  const route = await readCode("../../shell/server/routes/settings.mjs");
  assert.match(route, /function describe\(error\)/);
  assert.doesNotMatch(route, /unavailable: \$\{error\.message\}/,
    "PostgREST puts the useful part in details or hint for exactly this failure, so .message alone "
    + "logged an empty reason — visible and useless at the same time");
});

// ── Legacy that is NOT dead ─────────────────────────────────────────────────────────────

test("the buildr101 preview origin stays in the CSP, because production still serves it", async () => {
  const security = await readCode("../../shell/server/lib/httpSecurity.mjs");
  const withComments = await read("../../shell/server/lib/httpSecurity.mjs");
  // Proven, not assumed: provisiond on the VPS runs with PREVIEW_PUBLIC_SUFFIX=preview.buildr101.com,
  // so every live preview iframe is on that origin. Removing it from frame-src would break every
  // preview in the product. It is documented rather than deleted.
  assert.match(security, /frame-src[^;]*\*\.preview\.buildr101\.com/,
    "removing this breaks every live preview until the suffix is migrated");
  assert.match(withComments, /PREVIEW_PUBLIC_SUFFIX/,
    "and the reason it is still here must be written down where someone would delete it");
});

// ── No new dead code ────────────────────────────────────────────────────────────────────

test("every settings component is reachable from the Settings view", async () => {
  const dir = fileURLToPath(new URL("../../shell/web/src/settings", import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsx"));
  const sources = await Promise.all(files.map((f) => readCode(`../../shell/web/src/settings/${f}`)));
  const all = sources.join("\n");
  for (const file of files) {
    if (file === "SettingsView.jsx") continue;
    const name = file.replace(/\.jsx$/, "");
    assert.ok(all.includes(`./${name}.jsx`) || all.includes(`"./${file}"`),
      `${file} is not imported by anything — an abandoned component`);
  }
});

// ── CORS: another product's domain was permanently trusted ──────────────────────────────

test("the CORS allowlist is derived from APP_URL, not another product's domain", async () => {
  const { allowedOrigins } = await import("../../shell/server/lib/httpSecurity.mjs");
  const production = allowedOrigins("https://app.thrallo.com");
  assert.ok(production.has("https://app.thrallo.com"));
  // Production was verified answering `Access-Control-Allow-Origin: https://buildr101.com` to a
  // request that asked for it. Thrallo's API trusted a different product's front end, permanently.
  assert.ok(!production.has("https://buildr101.com"), "buildr101 must not be trusted by Thrallo");
  assert.ok(!production.has("https://www.buildr101.com"));
  // And a page on a developer's laptop must not be able to call production either.
  assert.ok(!production.has("http://localhost:5173"), "dev origins do not belong in production");
});

test("local development still works", async () => {
  const { allowedOrigins } = await import("../../shell/server/lib/httpSecurity.mjs");
  const dev = allowedOrigins("http://localhost:5173");
  assert.ok(dev.has("http://localhost:5173"));
  assert.ok(dev.has("http://127.0.0.1:5173"), "either spelling of loopback");
  // A malformed or missing APP_URL must fail toward dev, never toward trusting everything.
  const broken = allowedOrigins("not a url");
  assert.ok(broken.has("http://localhost:5173"));
  assert.ok(!broken.has("https://buildr101.com"));
});

// ── Builds that never reach a terminal state ────────────────────────────────────────────

test("the job sweeps run in production, not only when the legacy surface is mounted", async () => {
  const index = await readCode("../../shell/server/index.mjs");
  // These sat inside `if (!CODE_AGENT_STANDALONE)`, and production runs with it ON. Thrallo's own
  // app_build path calls createJob() and writes build_jobs regardless of that flag, so the sweep
  // whose entire purpose is "no build shows building forever" never ran: five jobs were found in
  // production stuck in queued/running for eleven and thirteen hours.
  const guard = index.indexOf("if (!CODE_AGENT_STANDALONE && haveSupabaseEnv()) startActionWorker();");
  for (const call of ["sweepInterrupted()", "sweepStaleJobs()", "sweepQaRuns()", "startCheckpointSweeper()"]) {
    const at = index.indexOf(call);
    assert.ok(at > 0, `${call} must still be called`);
    assert.ok(at < guard || guard === -1,
      `${call} must not sit behind the standalone flag — Thrallo builds exist either way`);
  }
  // The action worker genuinely is a Buildr101 surface and stays behind it.
  assert.match(index, /if \(!CODE_AGENT_STANDALONE && haveSupabaseEnv\(\)\) startActionWorker\(\);/);
});

test("stale builds are swept while the server is up, not only at boot", async () => {
  const jobs = await readCode("../../shell/server/lib/buildJobs.mjs");
  assert.match(jobs, /export function startStaleJobSweeper/,
    "a build that wedges on a server that stays up was never swept until the next deploy");
  assert.match(jobs, /export function stopStaleJobSweeper/, "and it must be stoppable");
  const index = await readCode("../../shell/server/index.mjs");
  // Guarded on Supabase: without a database there are no job rows to sweep, and the call would
  // only produce noise — or, before startCheckpointSweeper caught its own synchronous throw, kill
  // the server at boot from inside the `listening` handler.
  assert.match(index, /if \(haveSupabaseEnv\(\)\) startStaleJobSweeper\(\);/);
  assert.match(index, /  stopStaleJobSweeper\(\);/, "started and stopped, like every other sweeper");
});

test("the sweeper cannot be configured into a busy loop", async () => {
  const { startStaleJobSweeper, stopStaleJobSweeper } = await import("../../shell/server/lib/buildJobs.mjs");
  // A one-second interval would hammer the database; the floor is a minute.
  assert.doesNotThrow(() => startStaleJobSweeper({ intervalMs: 1 }));
  stopStaleJobSweeper();
  const jobs = await readCode("../../shell/server/lib/buildJobs.mjs");
  assert.match(jobs, /Math\.max\(intervalMs, 60_000\)/);
});

test("the interruption message a customer reads is not mojibake", async () => {
  const jobs = await read("../../shell/server/lib/buildJobs.mjs");
  // These read "interrupted â€” please rebuild" — a UTF-8 em dash mangled through cp1252, in a
  // string that goes straight to the customer as the reason their build stopped.
  assert.ok(!jobs.includes("â€"), "no mangled UTF-8 in user-facing copy");
  assert.match(jobs, /Build was interrupted before it could finish — please rebuild\./);
  assert.match(jobs, /Build was interrupted by a server restart — please rebuild\./);
});

// ── Claims that must match behaviour ────────────────────────────────────────────────────

test("no plan promises faster builds, because no plan delivers them", async () => {
  const banner = await readCode("../../shell/web/src/billing/PlanBanner.jsx");
  // Every plan runs at MAX_CONCURRENT_BUILDS_PER_USER = 1 with no priority and no queue jumping.
  assert.doesNotMatch(banner, /faster build/i,
    "this was a sentence a customer could pay for and never receive");
  const jobs = await readCode("../../shell/server/lib/buildJobs.mjs");
  assert.match(jobs, /MAX_CONCURRENT_BUILDS_PER_USER = 1/,
    "if this ever becomes plan-dependent, the copy may change back");
  // What it says instead has to be true of the real catalogue.
  assert.match(banner, /more builds/);
  assert.match(banner, /analytics history|error reporting/);
});

test("a sweeper that cannot reach the database logs, it does not kill the server", async () => {
  const recovery = await readCode("../../shell/server/lib/appBuild/checkpointRecovery.mjs");
  // serviceClient() throws SYNCHRONOUSLY when Supabase is unconfigured, and this runs from the
  // server's `listening` handler — so the throw escaped the promise chain and took the whole
  // process down at boot. Maintenance failing is not a reason the server cannot serve.
  assert.match(recovery, /try \{[\s\S]{0,200}sweepCheckpoints\(/,
    "the synchronous construction must be inside the try, not just the promise");
  assert.match(recovery, /sweep unavailable/);
});

// ── Unbounded growth in a long-lived view ───────────────────────────────────────────────

test("a live log stream does not grow without limit", async () => {
  const { trimEntries } = await import("../../shell/web/src/publish/logWindow.js");
  const seen = new Set();
  let entries = [];
  // Ten thousand lines is an hour on a busy site. Before this, every one stayed rendered and
  // every id stayed in the dedupe Set for as long as the tab was open.
  for (let i = 0; i < 10_000; i += 1) {
    seen.add(`e${i}`);
    entries = trimEntries([{ id: `e${i}` }, ...entries], seen, 1_000);
  }
  assert.equal(entries.length, 1_000, "the rendered list is capped");
  assert.equal(seen.size, 1_000, "and the dedupe Set is trimmed with it, not left to grow");
  assert.equal(entries[0].id, "e9999", "the newest entry is still first");
});

test("trimming keeps the newest and drops the oldest", async () => {
  const { trimEntries } = await import("../../shell/web/src/publish/logWindow.js");
  const seen = new Set(["a", "b", "c"]);
  const kept = trimEntries([{ id: "a" }, { id: "b" }, { id: "c" }], seen, 2);
  assert.deepEqual(kept.map((e) => e.id), ["a", "b"]);
  assert.ok(!seen.has("c"), "an id that has scrolled off cannot arrive again — the stream only moves forward");
  // Under the limit, nothing is touched.
  const small = trimEntries([{ id: "x" }], new Set(["x"]), 10);
  assert.deepEqual(small.map((e) => e.id), ["x"]);
});

// ── Cross-engine defects ────────────────────────────────────────────────────────────────

test("focus returns even on an engine that does not focus a clicked button", async () => {
  // WebKit: Safari deliberately does not focus a button when it is clicked, so
  // document.activeElement is <body> by the time an overlay mounts. Both overlays now prefer the
  // element that actually triggered them.
  for (const file of ["../../shell/web/src/settings/SettingsView.jsx", "../../shell/web/src/publish/ProjectDashboard.jsx"]) {
    const source = await readCode(file);
    assert.match(source, /const active = document\.activeElement;/, `${file}: active element read`);
    assert.match(source, /active !== document\.body \? active : \(openedBy\?\.current \|\| null\)/,
      `${file}: falls back to what opened it`);
  }
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  assert.match(shell, /overlayOpener\.current = e\.currentTarget/,
    "and the shell captures the trigger from the click itself");
  assert.match(shell, /openedBy=\{overlayOpener\}/);
});

test("the address is re-read when a page comes back from the bfcache", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  // Firefox restores a page from its back/forward cache WITHOUT firing popstate, so the URL and
  // the rendered tab disagreed after Back-from-a-reload.
  assert.match(shell, /window\.addEventListener\("pageshow", onPop\)/);
  assert.match(shell, /window\.removeEventListener\("pageshow", onPop\)/, "and it is cleaned up");
});

test("the browser matrix covers more than one engine", async () => {
  const config = await readCode("../../playwright.config.mjs");
  // Every project was Chromium, so "the full matrix passes" proved four viewports of one engine.
  assert.match(config, /name: "firefox"/);
  assert.match(config, /name: "webkit"/);
  assert.match(config, /devices\["Desktop Firefox"\]/);
  assert.match(config, /devices\["Desktop Safari"\]/);
  // What those two do NOT cover has to be written down, not implied by a green tick.
  const platforms = await read("../../docs/PLATFORMS.md");
  assert.match(platforms, /NOT covered/);
  assert.match(platforms, /Real iOS/);
  assert.match(platforms, /Screen readers/);
});

// ── The post-checkout return ────────────────────────────────────────────────────────────

test("a paid customer returning without a session is not shown the marketing page", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  // The return was handled INSIDE the workspace, below `if (!user) return <Landing />`. Someone
  // who completed checkout in another browser — a phone, a second machine, a private window —
  // had just paid real money and was shown a marketing page with the payment unmentioned.
  const gateAt = shell.indexOf("if (!user) return <Landing");
  const readAt = shell.indexOf("const billingReturn = readBillingReturn()");
  assert.ok(readAt > 0 && readAt < gateAt, "the return must be read ABOVE the auth gate");
  assert.match(shell, /<Landing billingReturn=\{billingReturn\} \/>/,
    "and handed to the screen that actually renders");

  const landing = await readCode("../../shell/web/src/landing/Landing.jsx");
  assert.match(landing, /Payment received/, "which states the outcome");
  assert.match(landing, /billingReturn === "success" \? "signin" : "signup"/,
    "and offers sign-in rather than sign-up to someone who already has an account");
});

test("the return survives the sign-in it may require", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");
  assert.match(shell, /readBillingReturn\(\) \|\| takeRememberedBillingReturn\(\)/,
    "the workspace seeds from the URL or from what was remembered through a sign-in");
  const helper = await readCode("../../shell/web/src/billing/billingReturn.js");
  assert.match(helper, /sessionStorage/, "remembered for the browser session, not forever");
});

test("/billing-success is a real destination, not a 404 that renders the landing page", async () => {
  const { readBillingReturn } = await import("../../shell/web/src/billing/billingReturn.js");
  // The SPA serves index.html for any path, so an unhandled /billing-success rendered the app,
  // which had no session, which rendered the landing page. It was a route that existed nowhere.
  assert.equal(readBillingReturn({ pathname: "/billing-success", search: "" }), "success");
  assert.equal(readBillingReturn({ pathname: "/billing-success/", search: "" }), "success");
  assert.equal(readBillingReturn({ pathname: "/billing-cancelled", search: "" }), "cancelled");
  // The form checkout is actually configured with.
  assert.equal(readBillingReturn({ pathname: "/", search: "?billing=success" }), "success");
  assert.equal(readBillingReturn({ pathname: "/", search: "?billing=cancelled" }), "cancelled");
  // And nothing else is mistaken for one.
  assert.equal(readBillingReturn({ pathname: "/", search: "" }), null);
  assert.equal(readBillingReturn({ pathname: "/projects/p1/logs", search: "" }), null);
  assert.equal(readBillingReturn({ pathname: "/", search: "?billing=maybe" }), null);
});
