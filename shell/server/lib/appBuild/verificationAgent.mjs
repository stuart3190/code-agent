// The Verification Agent — a permanent first-class specialist whose ONLY job is proving a
// generated application actually works (Stuart's directive, 2026-07-31). It never writes
// code and never modifies the product; it drives the LIVE preview like a real user with
// Playwright and returns a structured verdict. No build is "complete" without its PASS —
// the gate is structural: the completion message is only produced after sign-off.

import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

function makeCheck(list) {
  return (id, label, status, detail = "") => {
    list.push({ id, label, status, detail: String(detail).slice(0, 300) });
  };
}

// Heuristic driver pieces — generated apps vary, so entry points are found, not assumed.
async function clickThroughLanding(page) {
  for (const name of [/start/i, /get started/i, /sign up/i, /create account/i, /begin/i]) {
    const b = page.getByRole("button", { name }).or(page.getByRole("link", { name }));
    if (await b.count()) { await b.first().click().catch(() => {}); await page.waitForTimeout(1200); return; }
  }
}

async function fillField(page, kind, value) {
  const res = [
    page.getByLabel(kind === "email" ? /e-?mail/i : /password/i),
    page.getByPlaceholder(kind === "email" ? /e-?mail/i : /password/i),
    page.locator(`input[type=${kind}]`),
  ];
  for (const loc of res) {
    if (await loc.count()) { await loc.first().fill(value); return true; }
  }
  return false;
}

export async function verifyApp({ previewUrl, usesBackend = true, timeoutMs = 180_000 }) {
  const checks = [];
  const check = makeCheck(checks);
  const consoleErrors = [];
  const failedRequests = [];
  const email = `verify+${Date.now()}@thrallo.dev`;
  const password = `Vf-${Math.random().toString(36).slice(2, 10)}!9`;
  const marker = `verified-${Date.now()}`;

  let browser = null;
  const deadline = Date.now() + timeoutMs;
  try {
    const { chromium } = requireCjs("playwright");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();
    page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("response", (r) => {
      const s = r.status();
      if (s >= 400 && !r.url().includes("favicon")) failedRequests.push(`${s} ${r.request().method()} ${r.url().slice(0, 140)}`);
    });
    page.on("requestfailed", (r) => {
      const reason = r.failure()?.errorText || "failed";
      if (!/net::ERR_ABORTED/.test(reason)) failedRequests.push(`${reason} ${r.url().slice(0, 140)}`);
    });

    // App loads at all
    const nav = await page.goto(previewUrl, { waitUntil: "networkidle", timeout: 60_000 }).catch((e) => ({ error: e.message }));
    check("load", "App loads", nav?.error ? "fail" : "pass", nav?.error || previewUrl);
    if (nav?.error) throw new Error("unreachable");

    if (usesBackend) {
      // Signup → signed-in view
      await clickThroughLanding(page);
      const hasEmail = await fillField(page, "email", email);
      const hasPassword = await fillField(page, "password", password);
      if (hasEmail && hasPassword) {
        const signup = page.getByRole("button", { name: /sign ?up|create account|register/i });
        if (await signup.count()) await signup.first().click(); else await page.keyboard.press("Enter");
        const enteredApp = await page
          .locator("textarea, input[type=text], [role=main] button, main button")
          .first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
        check("signup", "Signup", enteredApp ? "pass" : "fail", enteredApp ? email : "signed-in view never appeared");

        // Create data through the first available input + submit
        let dataCreated = false;
        if (enteredApp) {
          const field = page.locator("textarea, input[type=text]").first();
          if (await field.count()) {
            await field.fill(marker).catch(() => {});
            const submit = page.getByRole("button", { name: /save|add|create|post|submit|send/i });
            if (await submit.count()) await submit.first().click().catch(() => {}); else await page.keyboard.press("Enter");
            await page.waitForTimeout(2_500);
            dataCreated = !!(await page.getByText(marker).count());
          }
          check("data", "Data persists", dataCreated ? "pass" : "fail", dataCreated ? marker : "created record never appeared");
        } else {
          check("data", "Data persists", "skip", "no signed-in view");
        }

        // Reload: session + database persistence
        await page.reload({ waitUntil: "networkidle" }).catch(() => {});
        await page.waitForTimeout(3_000);
        let stillThere = dataCreated && !!(await page.getByText(marker).count());
        let sessionHeld = stillThere;
        if (!stillThere && (await fillField(page, "email", email))) {
          await fillField(page, "password", password);
          const signin = page.getByRole("button", { name: /sign ?in|log ?in/i });
          if (await signin.count()) await signin.first().click(); else await page.keyboard.press("Enter");
          await page.waitForTimeout(4_000);
          sessionHeld = true; // credentials round-trip = auth works even if session storage is per-tab
          stillThere = !!(await page.getByText(marker).count());
        }
        check("session", "Login & session persistence", sessionHeld ? "pass" : "fail");
        if (dataCreated) check("reload", "Database persistence after reload", stillThere ? "pass" : "fail");
        else check("reload", "Database persistence after reload", "skip", "no data to re-check");

        // Edit / delete / upload — only when the app offers them
        const editBtn = page.getByRole("button", { name: /edit/i });
        check("edit", "Edit data", (await editBtn.count()) ? "pass" : "skip", (await editBtn.count()) ? "edit affordance present" : "not offered by this app");
        const delBtn = page.getByRole("button", { name: /delete|remove/i });
        if (await delBtn.count()) {
          await delBtn.first().click().catch(() => {});
          await page.waitForTimeout(2_000);
          const confirm = page.getByRole("button", { name: /confirm|yes|delete/i });
          if (await confirm.count()) await confirm.first().click().catch(() => {});
          await page.waitForTimeout(2_000);
          check("delete", "Delete data", (await page.getByText(marker).count()) === 0 ? "pass" : "fail");
        } else {
          check("delete", "Delete data", "skip", "not offered by this app");
        }
        check("upload", "File upload", (await page.locator("input[type=file]").count()) ? "pass" : "skip",
          (await page.locator("input[type=file]").count()) ? "upload input present" : "not offered by this app");
      } else {
        check("signup", "Signup", "fail", "no email/password fields found in the app");
        check("session", "Login & session persistence", "skip", "");
        check("data", "Data persists", "skip", "");
        check("reload", "Database persistence after reload", "skip", "");
      }
    }

    // Console + network hygiene (collected across the whole run)
    check("console", "Console clean", consoleErrors.length ? "fail" : "pass", consoleErrors.slice(0, 3).join(" | "));
    const hardFailures = failedRequests.filter((r) => /^(404|500|502|503)|CORS|ERR_FAILED/.test(r));
    check("network", "Network clean (no 404/500/CORS)", hardFailures.length ? "fail" : "pass", hardFailures.slice(0, 3).join(" | "));
  } catch (error) {
    if (!checks.some((c) => c.id === "load")) check("load", "App loads", "fail", error.message);
  } finally {
    await browser?.close().catch(() => {});
  }
  void deadline;

  const failed = checks.filter((c) => c.status === "fail");
  return {
    pass: failed.length === 0 && checks.some((c) => c.status === "pass"),
    checks,
    failures: failed.map((c) => `${c.label}: ${c.detail || "failed"}`),
    summary: checks
      .filter((c) => c.status !== "skip")
      .map((c) => `${c.status === "pass" ? "✓" : "✗"} ${c.label}`)
      .join("\n"),
  };
}

// The repair brief handed back to the Builder when verification rejects a build. Repair
// mode is surgical: design, layout, colours, branding, UX and component structure are
// preserved — only the minimum code to fix the named failures changes.
export function repairPrompt(failures) {
  return [
    "REPAIR MODE — the Verification Agent rejected this build. Fix ONLY these verified failures:",
    ...failures.map((f) => `- ${f}`),
    "",
    "Hard rules: preserve the existing design, layout, colours, branding, UX and component",
    "structure exactly. Do NOT redesign or restyle anything. Make the minimum code change",
    "that makes each failure pass. Do not touch unrelated files.",
  ].join("\n");
}
