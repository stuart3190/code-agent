import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function supabaseRef() {
  try {
    const configured = process.env.VITE_SUPABASE_URL;
    if (configured) return new URL(configured).hostname.split(".")[0] || null;
    const env = readFileSync(fileURLToPath(new URL("../shell/web/.env", import.meta.url)), "utf8");
    const url = env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/)?.[1] || "";
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}
const REF = supabaseRef();

const SESSION = {
  access_token: "e2e-build-profile-token",
  refresh_token: "e2e-build-profile-refresh",
  token_type: "bearer",
  expires_in: 86_400,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "00000000-0000-4000-8000-000000000009",
    aud: "authenticated", role: "authenticated", email: "profile@thrallo.test",
    user_metadata: { full_name: "Profile Tester" }, app_metadata: { provider: "email" },
    created_at: "2026-08-22T00:00:00Z",
  },
};

async function stubComposer(page, onCreate) {
  await page.addInitScript(({ ref, session }) => {
    window.__THRALLO_DESKTOP__ = { server: "", token: session.access_token, email: session.user.email };
    if (ref) window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session));
  }, { ref: REF, session: SESSION });

  let created = false;
  await page.route("**/api/v1/conversations/deleted", (route) =>
    route.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/conversations/profile-conversation/events**", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/conversations", async (route) => {
    if (route.request().method() === "POST") {
      created = true;
      onCreate(JSON.parse(route.request().postData() || "{}"));
      return route.fulfill({ json: { conversation: { id: "profile-conversation", title: "Profile fixture", state: "thinking" } } });
    }
    return route.fulfill({ json: { conversations: created ? [{ id: "profile-conversation", title: "Profile fixture", state: "thinking" }] : [] } });
  });
  if (REF) {
    await page.route(`https://${REF}.supabase.co/**`, (route) => route.fulfill({ json: {} }));
    await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (route) => route.fulfill({ json: SESSION.user }));
  }
}

test("responsive new-project composer infers and submits an adjustable canonical build profile without overflow", async ({ page }) => {
  let submitted = null;
  await stubComposer(page, (body) => { submitted = body; });
  await page.goto("/");

  const composer = page.locator(".ct-build-composer");
  await expect(composer).toBeVisible();
  await expect(page.getByText("What are you building?", { exact: true })).toBeVisible();
  for (const name of ["Auto", "Website", "Application"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Auto", exact: true })).toHaveAttribute("aria-pressed", "true");

  const prompt = "Build a planning application where I can save projects, calculate results on an interactive canvas, and export downloads.";
  await page.getByPlaceholder(/Describe anything/).fill(prompt);
  await expect(page.getByLabel("Thrallo build interpretation")).toContainText("Application");
  for (const name of ["Saved data / database", "Custom calculations / logic", "Interactive workspace / canvas", "Export / download"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  }

  await page.getByRole("button", { name: "Application", exact: true }).click();
  await page.getByLabel("Application type").selectOption("saas");
  await expect(page.getByRole("button", { name: "User accounts", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Payments / subscriptions", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Payments / subscriptions", exact: true }).click();

  const layout = await composer.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    viewportWidth: window.innerWidth,
    controls: [...element.querySelectorAll(".ct-build-profile button, .ct-build-profile select")]
      .filter((control) => control.getClientRects().length)
      .map((control) => {
        const box = control.getBoundingClientRect();
        return { left: box.left, right: box.right, height: box.height };
      }),
  }));
  assertResponsiveLayout(layout);

  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted.text).toBe(prompt);
  expect(submitted.buildProfile).toMatchObject({
    version: 1,
    requestedBuildType: "application",
    resolvedBuildType: "application",
    applicationSubtype: "saas",
    inferenceSource: "adjusted",
  });
  expect(submitted.buildProfile.requirementSignals).toEqual(expect.arrayContaining([
    "user_accounts", "saved_data", "payments", "custom_logic", "interactive_workspace", "export",
  ]));
});

function assertResponsiveLayout(layout) {
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  const minimumTarget = layout.viewportWidth <= 560 ? 44 : 32;
  for (const control of layout.controls) {
    expect(control.left).toBeGreaterThanOrEqual(-1);
    expect(control.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(control.height).toBeGreaterThanOrEqual(minimumTarget);
  }
}
