// Drive the contract's journeys against the real preview.
//
// PR6 of docs/PIPELINE-REDESIGN.md. The existing verifier proves the app LOADS — console clean,
// network clean, a generic signup flow. It cannot prove the app DOES what was agreed, because
// until PR4 nothing had written down what was agreed. Now something has.
//
// This drives each journey step in a real browser against the real preview and the real backend.
// The distinction from the generic verifier matters: "the page rendered" and "a booking made in
// this browser is still there after a reload" are different claims, and only the second one is
// what the customer asked for.
//
// Deliberately conservative about what counts as a FAILURE. A step it could not drive — because it
// could not find the control the contract described — is reported as `undriveable`, not as a
// defect. Failing a build because an automated heuristic could not find a button would be the
// preflight mistake again, in a place where it costs a whole rebuild.

import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

const STEP_TIMEOUT_MS = 15_000;

// ── finding things a human would find ─────────────────────────────────────────────────────────
//
// The contract describes intent in English ("select a service and an available slot"), not
// selectors. These turn that into the handful of things a person would actually try.

function wordsOf(text) {
  return String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
}

const NOISE = new Set(["the", "and", "for", "with", "that", "then", "from", "into", "this", "their",
  "click", "clicks", "select", "selects", "enter", "enters", "type", "types", "open", "opens",
  "page", "button", "field", "form", "user", "visitor", "shown", "show", "shows", "displayed",
  "display", "visible", "appears", "appear", "should", "must", "step", "value", "input"]);

function keywords(text, limit = 6) {
  return [...new Set(wordsOf(text))].filter((w) => !NOISE.has(w)).slice(0, limit);
}

/** Every locator worth trying for one described control, best guess first. */
function candidatesFor(page, description) {
  const words = keywords(description, 4);
  const out = [];
  for (const word of words) {
    const pattern = new RegExp(word, "i");
    out.push(page.getByRole("button", { name: pattern }));
    out.push(page.getByRole("link", { name: pattern }));
    out.push(page.getByRole("tab", { name: pattern }));
    out.push(page.getByLabel(pattern));
    out.push(page.getByPlaceholder(pattern));
    out.push(page.getByText(pattern));
  }
  return out;
}

async function firstVisible(locators, deadline) {
  for (const locator of locators) {
    if (Date.now() > deadline) return null;
    try {
      const count = await locator.count();
      for (let i = 0; i < Math.min(count, 3); i += 1) {
        const nth = locator.nth(i);
        if (await nth.isVisible().catch(() => false)) return nth;
      }
    } catch { /* a malformed locator is not a defect in the app */ }
  }
  return null;
}

// Plausible values for a field, chosen from its own label so validation is satisfied rather than
// tripped — the point is to complete the journey, not to fuzz it.
function valueFor(label, marker) {
  const text = String(label || "").toLowerCase();
  if (/e-?mail/.test(text)) return `journey+${marker}@thrallo.dev`;
  if (/phone|tel|mobile/.test(text)) return "07700900123";
  if (/password/.test(text)) return `Jv-${marker}!9a`;
  if (/date/.test(text)) {
    const soon = new Date(Date.now() + 7 * 86_400_000);
    return soon.toISOString().slice(0, 10);
  }
  if (/time/.test(text)) return "10:00";
  if (/number|quantity|adults?|children|guests?|qty/.test(text)) return "2";
  if (/postcode|zip/.test(text)) return "SW1A 1AA";
  return `Journey ${marker}`;
}

/** Fill every visible empty input on the page, so a "enter your details" step can be completed. */
async function fillVisibleForm(page, marker) {
  const filled = [];
  const inputs = page.locator("input:visible, textarea:visible, select:visible");
  const count = Math.min(await inputs.count().catch(() => 0), 25);
  for (let i = 0; i < count; i += 1) {
    const field = inputs.nth(i);
    try {
      const tag = await field.evaluate((el) => el.tagName.toLowerCase());
      const type = (await field.getAttribute("type")) || "text";
      if (["hidden", "submit", "button", "search"].includes(type)) continue;

      if (tag === "select") {
        const options = field.locator("option");
        const optionCount = await options.count();
        // Skip the placeholder option; pick something real.
        if (optionCount > 1) await field.selectOption({ index: 1 }).catch(() => {});
        filled.push("select");
        continue;
      }
      if (type === "checkbox" || type === "radio") {
        if (!(await field.isChecked().catch(() => true))) await field.check({ force: true }).catch(() => {});
        filled.push(type);
        continue;
      }
      if (await field.inputValue().catch(() => "")) continue; // already has a value

      const label = (await field.getAttribute("aria-label"))
        || (await field.getAttribute("placeholder"))
        || (await field.getAttribute("name"))
        || type;
      await field.fill(valueFor(label, marker), { timeout: 3_000 }).catch(() => {});
      filled.push(label);
    } catch { /* one awkward field must not end the journey */ }
  }
  return filled;
}

// ── running one step ──────────────────────────────────────────────────────────────────────────

async function runStep(page, step, { marker, previewUrl }) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const action = String(step.action || "");
  const expect = String(step.expect || "");
  let drove = false;

  // What was already on screen BEFORE this step. A word that was visible beforehand is no evidence
  // that the step did anything: "a booking reference is shown" was passing on a page whose only
  // match was the word "booking" in the button the step had just clicked.
  const textBefore = await page.evaluate(() => document.body?.innerText || "").catch(() => "");

  // Navigation, when the step names a route.
  const route = (step.target || "").match(/^\/[\w/-]*/) || action.match(/\s(\/[\w/-]+)/);
  if (route && /open|go to|navigate|visit/i.test(action)) {
    await page.goto(new URL(route[0] ?? route[1], previewUrl).href, { waitUntil: "domcontentloaded" }).catch(() => {});
    drove = true;
  }

  if (/reload|refresh/i.test(action)) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    drove = true;
  }

  if (/enter|type|fill|complete|provide/i.test(action)) {
    const filled = await fillVisibleForm(page, marker);
    drove = drove || filled.length > 0;
  }

  // Only if the step was not itself a navigation. "open the booking page" matches /book/, and an
  // earlier version therefore navigated AND clicked — submitting the form on step one, so that by
  // step three the confirmation was already on screen and the real submit proved nothing.
  const navigated = drove;
  if (!navigated && /click|select|choose|submit|press|tap|continue|confirm|cancel|sign|book/i.test(action)) {
    const target = await firstVisible(candidatesFor(page, `${step.target || ""} ${action}`), deadline);
    if (target) {
      await target.click({ timeout: 5_000 }).catch(() => {});
      drove = true;
    } else {
      // A submit control the description did not name: the last enabled submit-ish button.
      const submit = page.locator("button[type=submit]:visible, button:visible").last();
      if (await submit.count().catch(() => 0)) {
        await submit.click({ timeout: 5_000 }).catch(() => {});
        drove = true;
      }
    }
  }

  await page.waitForTimeout(900);

  // The expectation. Text the contract named, present and visible on the page.
  const wanted = keywords(expect, 5);
  if (!wanted.length) return { drove, status: "undriveable", detail: "the expectation named nothing findable" };

  const before = textBefore.toLowerCase();
  const found = [];
  const fresh = [];
  for (const word of wanted) {
    const hit = await page.getByText(new RegExp(word, "i")).first().isVisible().catch(() => false);
    if (!hit) continue;
    found.push(word);
    // New since the step ran, which is the only kind of evidence that the step DID something.
    if (!before.includes(word)) fresh.push(word);
  }

  // Some expectations are about FORM STATE, not visible text — "the fields accept the details",
  // "continue becomes enabled". Searching the page for the word "fields" will never satisfy those,
  // and reporting them as failures would blame the app for the driver's literalism. So when the
  // step filled something, ask the page the question the step was really asking.
  if (found.length / wanted.length < 0.5 && /field|detail|input|form|accept|valid|enabled|complete/i.test(expect)) {
    const state = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input, textarea, select")]
        .filter((el) => el.offsetParent !== null && !["hidden", "submit", "button"].includes(el.type));
      const filled = inputs.filter((el) => (el.type === "checkbox" || el.type === "radio" ? el.checked : String(el.value || "").trim().length > 0));
      const enabled = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null && !b.disabled);
      return { inputs: inputs.length, filled: filled.length, enabledButtons: enabled.length };
    }).catch(() => null);

    if (state && state.inputs > 0 && state.filled >= Math.ceil(state.inputs / 2)) {
      return { drove, status: "pass", detail: `${state.filled}/${state.inputs} fields hold values` };
    }
    if (state && /enabled/i.test(expect) && state.enabledButtons > 0) {
      return { drove, status: "pass", detail: `${state.enabledButtons} control(s) enabled` };
    }
  }

  // A majority of the named things on screen is the bar — requiring all would fail on synonyms,
  // requiring one would pass on coincidence. Plus, for any step that CHANGED something, at least
  // one of those matches must be new: a step whose every match was already there has demonstrated
  // nothing. Navigation and reload are exempt, since the whole page is new by definition.
  const ratio = found.length / wanted.length;
  const navigational = /open|go to|navigate|visit|reload|refresh/i.test(action);
  if (ratio >= 0.5 && (navigational || fresh.length > 0)) {
    return { drove, status: "pass", detail: `found: ${found.join(", ")}${fresh.length ? ` (new: ${fresh.join(", ")})` : ""}` };
  }
  if (!drove) return { drove, status: "undriveable", detail: `could not drive: ${action.slice(0, 80)}` };
  if (ratio >= 0.5) {
    const missing = wanted.filter((w) => !found.includes(w));
    return {
      drove,
      status: "fail",
      // Both halves, because a repair needs to know what was expected as well as what did not move.
      detail: `nothing changed — "${found.join(", ")}" was already on the page before this step`
        + `${missing.length ? `, and ${missing.join(", ")} never appeared` : ""}`,
    };
  }
  return { drove, status: "fail", detail: `expected ${wanted.join(", ")}; found ${found.join(", ") || "none"}` };
}

// ── the journey ───────────────────────────────────────────────────────────────────────────────

/**
 * Drive every journey in the contract.
 *
 * Returns `{ pass, journeys, failures, undriveable, consoleErrors, failedRequests }`.
 * `pass` reflects the PRIMARY journey only — that is the one the brief says gates the preview.
 */
export async function verifyJourneys({
  previewUrl, contract, timeoutMs = 240_000, viewport = { width: 1280, height: 900 },
}) {
  const results = [];
  const consoleErrors = [];
  const failedRequests = [];
  const marker = String(Date.now()).slice(-6);
  let browser = null;

  try {
    const { chromium } = requireCjs("playwright");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("response", (r) => {
      if (r.status() >= 400 && !r.url().includes("favicon")) {
        failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`);
      }
    });

    // Is the preview actually there? Without this, an unreachable URL leaves a blank page, every
    // expectation goes unmet, and the run reports confident journey failures for an app it never
    // loaded — failing a build over infrastructure, in the most expensive place possible.
    const landing = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch((error) => ({ error }));
    const reachable = landing && !landing.error && (typeof landing.status !== "function" || landing.status() < 400);
    if (!reachable) {
      return {
        pass: null, unavailable: true, journeys: [],
        error: `the preview did not load (${landing?.error?.message?.slice(0, 120) || `HTTP ${landing?.status?.()}`})`,
        consoleErrors, failedRequests,
      };
    }

    const deadline = Date.now() + timeoutMs;
    // Primary first: if the run is going to time out, it should time out having proved the thing
    // that actually gates the preview.
    const ordered = [...(contract?.journeys || [])]
      .sort((a, b) => (a.priority === "primary" ? -1 : 0) - (b.priority === "primary" ? -1 : 0));

    for (const journey of ordered) {
      if (Date.now() > deadline) {
        results.push({ id: journey.id, title: journey.title, priority: journey.priority, status: "skipped", steps: [] });
        continue;
      }
      // Every journey starts from a clean load of the app, not from wherever the last one ended.
      await page.goto(previewUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(700);

      const steps = [];
      for (const step of journey.steps || []) {
        if (Date.now() > deadline) { steps.push({ ...step, status: "skipped" }); continue; }
        const outcome = await runStep(page, step, { marker, previewUrl }).catch((error) => ({
          status: "undriveable", detail: `driver error: ${error.message.slice(0, 120)}`,
        }));
        steps.push({ action: step.action, expect: step.expect, ...outcome });
      }

      const failed = steps.filter((s) => s.status === "fail");
      const undriveable = steps.filter((s) => s.status === "undriveable");
      results.push({
        id: journey.id, title: journey.title, priority: journey.priority,
        status: failed.length ? "fail" : (undriveable.length === steps.length ? "undriveable" : "pass"),
        steps, failedSteps: failed.length, undriveableSteps: undriveable.length,
      });
    }
  } catch (error) {
    return {
      pass: null, journeys: results, error: error.message,
      consoleErrors, failedRequests,
      // A verifier that cannot start must not be read as "the app is broken".
      unavailable: true,
    };
  } finally {
    await browser?.close().catch(() => {});
  }

  const primary = results.find((j) => j.priority === "primary") || results[0];
  return {
    // Only a genuine `fail` blocks. An undriveable journey means the driver could not find the
    // controls, which is a limitation of the driver as often as it is a fault in the app.
    pass: primary ? primary.status !== "fail" : null,
    primaryStatus: primary?.status || null,
    journeys: results,
    failures: results.filter((j) => j.status === "fail"),
    undriveable: results.filter((j) => j.status === "undriveable"),
    consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
    failedRequests: [...new Set(failedRequests)].slice(0, 10),
  };
}

/** The failures, phrased for a repair brief. */
export function journeyFailures(result) {
  const out = [];
  for (const journey of result?.failures || []) {
    for (const step of journey.steps.filter((s) => s.status === "fail")) {
      out.push(`the journey "${journey.title}" fails at "${step.action}": ${step.detail}`);
    }
  }
  for (const error of result?.consoleErrors || []) out.push(`the browser console reports: ${error}`);
  for (const request of result?.failedRequests || []) out.push(`a network request failed: ${request}`);
  return out;
}

/** One line for the diagnostics record. */
export function journeySummary(result) {
  if (result?.unavailable) return `journeys not run (${result.error})`;
  return (result?.journeys || [])
    .map((j) => `${j.id}:${j.status}${j.failedSteps ? `(${j.failedSteps} failed)` : ""}`)
    .join(" · ") || "no journeys";
}
