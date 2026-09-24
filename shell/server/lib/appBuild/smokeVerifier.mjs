// The minimal browser smoke test that gates a Builder V2 preview (replaces the contracted
// journey verifier in the mandatory gate, 2026-09-24).
//
// It proves exactly three things about a compiled application: the preview opens, something
// renders without a fatal runtime error, and the visible interactive controls can be clicked or
// activated without crashing the page. It reads no text, compares no numbers, checks no labels
// and has no opinion about what a click should do. Anything it cannot activate is recorded as
// skipped, never as a failure. Console errors and failed requests are advisory evidence only.
//
// Verdict classes:
//   pass        - loaded, rendered, controls activated, app still standing
//   fail        - FATAL_RUNTIME_FAILURE: nothing rendered, or a control activation blanked/crashed
//                 the page (a genuine crash; repair is not briefed with expectations)
//   undriveable - PLATFORM_INCONCLUSIVE: the preview itself was unreachable (`unavailable: true`)
//
// Runs INSIDE the sandbox image (build-worker/sandbox.mjs) so it is part of the sandbox identity.

import { SMOKE_VERIFIER_POLICY, VERIFICATION_RESULT_CLASS } from "./verifierPolicy.mjs";

export const DEFAULT_CONTROL_LIMIT = 40;
const CLICK_TIMEOUT_MS = 1_500;
const SETTLE_MS = 250;
const MAX_CONSECUTIVE_STUCK = 6;

export const CONTROL_SELECTOR = [
  "button", "[role=button]", "a[href]", "input:not([type=hidden]):not([type=file])", "select",
  "textarea", "[role=tab]", "[role=checkbox]", "[role=switch]", "[role=menuitem]", "[role=option]",
  "summary",
].join(", ");

// Failures of the preview transport, not of the application: connection refused/reset, DNS,
// navigation timeouts, an HTTP 4xx/5xx from the preview host before any application code ran.
const INFRASTRUCTURE_FAILURE = /net::ERR_|ECONNREFUSED|ENOTFOUND|ECONNRESET|Timeout \d+ms exceeded|Navigation timeout|Target page, context or browser has been closed/i;

function renderedState(page) {
  return page.evaluate(() => {
    const root = document.getElementById("root") || document.body;
    if (!root) return { rendered: false, text: 0, controls: 0 };
    const text = String(root.innerText || "").trim().length;
    const controls = root.querySelectorAll("button, input, select, textarea, a[href], canvas, svg, img, video, [role=button]").length;
    return { rendered: text > 0 || controls > 0, text, controls };
  }).catch(() => null); // navigation in flight: not a verdict, poll again
}

async function waitForRender(page, deadline) {
  let last = null;
  while (Date.now() < deadline) {
    last = await renderedState(page);
    if (last?.rendered) return last;
    await page.waitForTimeout(250);
  }
  return last || { rendered: false, text: 0, controls: 0 };
}

function describeControl(info) {
  const label = String(info.text || info.ariaLabel || info.placeholder || info.value || "").trim().slice(0, 60);
  return `${info.tag}${info.type ? `[${info.type}]` : ""}${label ? ` "${label}"` : ""}`;
}

function skipReason(info, origin) {
  if (info.disabled) return "disabled";
  if (info.tag === "a") {
    const href = String(info.href || "");
    if (info.target === "_blank" || info.download) return "leaves_the_page";
    if (/^(mailto|tel|sms|javascript):/i.test(href)) return "external_scheme";
    try { if (new URL(href, origin).origin !== origin) return "external_link"; } catch { return "unparseable_href"; }
  }
  if (info.tag === "input" && ["file", "hidden", "image"].includes(info.type)) return "not_a_click_target";
  return null;
}

async function activate(el, info) {
  if (info.tag === "select") {
    const optionCount = Number(info.optionCount || 0);
    if (optionCount > 1) return el.selectOption({ index: 1 }, { timeout: CLICK_TIMEOUT_MS });
    return el.click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true });
  }
  if (info.tag === "input" && ["checkbox", "radio"].includes(info.type)) {
    return el.click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true });
  }
  if (info.tag === "textarea" || (info.tag === "input" && !["button", "submit", "reset", "range", "color"].includes(info.type))) {
    const value = info.type === "number" ? "1" : info.type === "email" ? "smoke@thrallo.dev"
      : info.type === "date" ? "2026-01-01" : info.type === "time" ? "10:00" : info.type === "password" ? "Smoke-1!" : "smoke";
    return el.fill(value, { timeout: CLICK_TIMEOUT_MS });
  }
  return el.click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true });
}

/**
 * @returns {Promise<{
 *   pass: boolean|null, unavailable: boolean, error: string|null, verifierPolicy: string,
 *   journeys: Array<object>, fatalErrors: string[], consoleErrors: string[], failedRequests: string[],
 *   advisories: Array<object>, verifierDefects: Array<object>, mechanics: null, smoke: object,
 * }>}
 */
export async function smokeVerifyJourneys({
  previewUrl, contract = {}, timeoutMs = 120_000, browser, controlLimit = DEFAULT_CONTROL_LIMIT,
  log = () => {},
}) {
  if (!browser) throw new Error("smokeVerifyJourneys needs a launched Playwright browser");
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(10_000, Number(timeoutMs) || 120_000);
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const crashes = [];
  const skipped = [];
  let crashed = false;
  let load = { ok: false, status: null, detail: null };
  let render = null;
  let discovered = 0;
  let activated = 0;
  let unavailable = false;
  let error = null;

  const context = await browser.newContext();
  const page = await context.newPage();
  // Popups opened by the app are closed; the listener is attached AFTER the smoke's own page exists.
  context.on("page", (popup) => { if (popup !== page) popup.close().catch(() => {}); });
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("dialog", (d) => { d.dismiss().catch(() => {}); });
  page.on("crash", () => { crashed = true; });
  page.on("response", (r) => {
    const s = r.status();
    if (s >= 400 && !r.url().includes("favicon")) failedRequests.push(`${s} ${r.request().method()} ${r.url().slice(0, 140)}`);
  });
  page.on("requestfailed", (r) => {
    const reason = r.failure()?.errorText || "failed";
    if (!/net::ERR_ABORTED/.test(reason)) failedRequests.push(`${reason} ${r.url().slice(0, 140)}`);
  });

  try {
    // 1. The preview opens.
    const navTimeout = Math.max(5_000, Math.min(60_000, deadline - Date.now()));
    let response = null;
    try {
      response = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
    } catch (navError) {
      const detail = String(navError?.message || navError).slice(0, 300);
      load = { ok: false, status: null, detail };
      unavailable = true; // the preview never answered: platform, not application
      error = `preview unreachable: ${detail}`;
    }
    if (response) {
      const status = response.status();
      load = { ok: status < 400, status, detail: status < 400 ? previewUrl : `HTTP ${status} from the preview host` };
      if (!load.ok) { unavailable = true; error = `preview unavailable: ${load.detail}`; }
    }

    // 2. Something renders without a fatal error.
    if (load.ok) {
      const renderDeadline = Math.min(deadline - 5_000, Date.now() + 45_000);
      render = await waitForRender(page, renderDeadline);
      if (crashed) {
        crashes.push({ phase: "load", control: null, error: "the page crashed while loading" });
      } else if (!render.rendered) {
        crashes.push({ phase: "load", control: null,
          error: pageErrors[0] ? `fatal runtime error during load: ${pageErrors[0]}` : "nothing rendered in the preview" });
      }
    }

    // 3. Visible controls can be activated without crashing the app.
    if (load.ok && !crashes.length) {
      const origin = new URL(previewUrl).origin;
      const controls = page.locator(CONTROL_SELECTOR);
      let index = 0;
      let stuck = 0;
      while (index < controlLimit && Date.now() < deadline - 3_000 && stuck < MAX_CONSECUTIVE_STUCK) {
        const count = await controls.count().catch(() => 0);
        if (index >= count) break;
        const el = controls.nth(index);
        index += 1;
        const info = await el.evaluate((node) => ({
          tag: node.tagName.toLowerCase(), type: (node.getAttribute("type") || "").toLowerCase(),
          href: node.getAttribute("href"), target: node.getAttribute("target"), download: node.hasAttribute("download"),
          disabled: node.disabled === true || node.getAttribute("aria-disabled") === "true",
          text: (node.innerText || node.textContent || "").trim().slice(0, 80),
          ariaLabel: node.getAttribute("aria-label"), placeholder: node.getAttribute("placeholder"),
          value: node.tagName === "INPUT" ? node.value : "", optionCount: node.tagName === "SELECT" ? node.options.length : 0,
        })).catch(() => null);
        if (!info) continue; // detached between enumeration and inspection
        discovered += 1;
        const reason = skipReason(info, origin);
        if (reason) { skipped.push({ control: describeControl(info), reason }); continue; }
        if (!(await el.isVisible().catch(() => false))) { skipped.push({ control: describeControl(info), reason: "not_visible" }); continue; }
        try {
          await activate(el, info);
          activated += 1;
          stuck = 0;
        } catch (activationError) {
          // Covered, detached or animating: not activatable right now is not a crash.
          skipped.push({ control: describeControl(info), reason: "not_activatable",
            detail: String(activationError?.message || activationError).split("\n")[0].slice(0, 160) });
          stuck += 1;
          if (stuck >= 3) await page.keyboard.press("Escape").catch(() => {});
          continue;
        }
        await page.waitForTimeout(SETTLE_MS);
        // A link or form that left the preview origin is not part of this app; come back.
        let current = null;
        try { current = new URL(page.url()); } catch { current = null; }
        if (current && current.origin !== origin) {
          await page.goBack({ timeout: 5_000, waitUntil: "domcontentloaded" }).catch(() => (
            page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {})
          ));
          await page.waitForTimeout(SETTLE_MS);
        }
        const state = crashed ? { rendered: false } : await waitForRender(page, Date.now() + 3_000);
        if (crashed || !state?.rendered) {
          crashes.push({ phase: "activate", control: describeControl(info),
            error: crashed ? "the page crashed" : pageErrors.at(-1)
              ? `fatal runtime error after activation: ${pageErrors.at(-1)}` : "the application went blank after activation" });
          break;
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  const fatal = crashes.length > 0;
  const status = unavailable ? "undriveable" : fatal ? "fail" : "pass";
  const classification = unavailable ? VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE
    : fatal ? VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE : VERIFICATION_RESULT_CLASS.PASS;
  const detail = unavailable ? error
    : fatal ? crashes.map((row) => `${row.control ? `${row.control}: ` : ""}${row.error}`).join("; ")
      : `smoke passed: rendered, ${activated} of ${discovered} visible controls activated without a crash`;
  const fatalErrors = crashes.map((row) => `${row.control ? `${row.control}: ` : ""}${row.error}`);
  const journeys = (contract?.journeys || []).map((journey) => ({
    id: journey.id, title: journey.title, priority: journey.priority,
    status, classification, detail,
    // The smoke drives no contracted steps; it has nothing to say about any of them.
    steps: [], failedSteps: fatal ? 1 : 0, verifiedBy: SMOKE_VERIFIER_POLICY,
  }));
  const durationMs = Date.now() - startedAt;
  log(`[smoke] ${status} in ${durationMs}ms: ${detail}`);
  return {
    pass: unavailable ? null : !fatal,
    unavailable,
    error,
    verifierPolicy: SMOKE_VERIFIER_POLICY,
    journeys,
    fatalErrors,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
    failedRequests: [...new Set(failedRequests)].slice(0, 10),
    advisories: [
      ...[...new Set(pageErrors)].map((detail) => ({ code: "non_blocking_page_error", detail })),
      ...[...new Set(consoleErrors)].map((detail) => ({ code: "non_blocking_console", detail })),
      ...[...new Set(failedRequests)].map((detail) => ({ code: "non_blocking_network", detail })),
    ].slice(0, 20),
    verifierDefects: [],
    mechanics: null,
    smoke: { load, render, controls: { discovered, activated, skipped }, crashes, durationMs },
  };
}
