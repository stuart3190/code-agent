// Managing projects: favourites, sorting, the archive, and acting on several at once.
//
// The stub here is stateful on purpose. Bulk actions are only interesting if the list afterwards
// reflects them, and a stub that always answered with the same rows would let a broken reload pass:
// the very failure this phase is meant to remove is a screen that agrees with itself while
// disagreeing with the server.
//
// It also mirrors the server's ordering contract exactly — favourites lead whatever sort is chosen,
// with a stable id tiebreak — so a spec cannot pass against a client that reorders things locally.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function supabaseRef() {
  try {
    const env = readFileSync(fileURLToPath(new URL("../shell/web/.env", import.meta.url)), "utf8");
    const url = env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/)?.[1] || "";
    return new URL(url).hostname.split(".")[0] || null;
  } catch { return null; }
}
const REF = supabaseRef();

const SESSION = {
  access_token: "e2e-fake-token", refresh_token: "e2e-fake-refresh", token_type: "bearer",
  expires_in: 86_400, expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated",
    email: "e2e@thrallo.com", user_metadata: { full_name: "Enid Tester" },
    app_metadata: { provider: "email" }, created_at: "2026-01-01T00:00:00Z",
  },
};

const TAB_STATUSES = {
  drafts: ["draft", "unpublished"], published: ["published"], updates: ["update_available"],
};

// Twelve, named so alphabetical order and activity order disagree: activity runs Alpha..Lima while
// the names sort the other way round. A client that sorted locally would produce the same answer
// for both, so the two orders must be distinguishable.
const NAMES = ["Zephyr", "Yarrow", "Xenon", "Willow", "Vesper", "Umber",
  "Tamarisk", "Sorrel", "Rowan", "Quince", "Poplar", "Olive"];

function seed() {
  return NAMES.map((title, i) => ({
    id: `c${String(i).padStart(2, "0")}`,
    title, state: "idle", productId: `prod-${i}`,
    publishStatus: i % 3 === 0 ? "published" : "draft",
    favourite: false, archivedAt: null,
    last_activity_at: new Date(Date.now() - i * 60_000).toISOString(),
    site: i % 3 === 0 ? {
      projectId: `p${String(i).padStart(2, "0")}`, currentProjectId: `p${String(i).padStart(2, "0")}`,
      productId: `prod-${i}`, name: title, slug: `proj-${i}`,
      url: `https://proj-${i}.app.thrallo.com`, environment: "production",
      publishedAt: new Date(Date.now() - i * 60_000).toISOString(),
      firstPublishedAt: "2026-07-01T00:00:00.000Z", unpublishedAt: null,
      live: true, updateAvailable: false, status: "published", domains: [],
    } : null,
  }));
}

async function stub(page, { onBulk = null } = {}) {
  const rows = seed();
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
    // A returning customer, so the dashboard renders its list rather than the first-run greeting.
    window.localStorage.setItem("thrallo-returning", "1");
  }, [`sb-${REF}-auth-token`, SESSION]);

  const listRoute = (r) => {
    const params = new URL(r.request().url()).searchParams;
    const tab = params.get("tab") || "all";
    const search = (params.get("q") || "").trim().toLowerCase();
    const offset = Number(params.get("offset") || 0);
    const limit = Number(params.get("limit") || 20);
    const sort = params.get("sort") || "activity";
    const favouritesOnly = params.get("favourites") === "1";
    const archived = params.get("archived") === "1";

    // Archived is a partition, not a filter over the visible page.
    const visible = rows.filter((c) => !!c.archivedAt === archived);
    const counts = { all: visible.length, favourites: visible.filter((c) => c.favourite).length };
    for (const [id, list] of Object.entries(TAB_STATUSES)) {
      counts[id] = visible.filter((c) => list.includes(c.publishStatus || "draft")).length;
    }
    const statuses = TAB_STATUSES[tab] || null;
    const matching = visible.filter((c) => {
      if (statuses && !statuses.includes(c.publishStatus || "draft")) return false;
      if (favouritesOnly && !c.favourite) return false;
      return !search || String(c.title || "").toLowerCase().includes(search);
    });
    matching.sort((a, b) => {
      if (!!a.favourite !== !!b.favourite) return a.favourite ? -1 : 1;
      const by = sort === "name" ? String(a.title || "").localeCompare(String(b.title || ""))
        : Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0);
      return by || String(a.id).localeCompare(String(b.id));
    });
    const slice = matching.slice(offset, offset + limit);
    return r.fulfill({ json: {
      conversations: slice, counts,
      page: {
        offset, limit, total: matching.length,
        nextOffset: offset + slice.length < matching.length ? offset + slice.length : null,
        tab, search: search || null, sort, favourites: favouritesOnly, archived,
      },
      sorts: [{ id: "activity", label: "Last activity" }, { id: "name", label: "Name" }],
    } });
  };

  await page.route("**/api/v1/conversations/bulk", async (r) => {
    if (onBulk) return onBulk(r);
    const { ids, action } = JSON.parse(r.request().postData() || "{}");
    const targets = rows.filter((c) => ids.includes(c.id));
    for (const row of targets) {
      if (action === "favourite") row.favourite = true;
      if (action === "unfavourite") row.favourite = false;
      if (action === "archive") row.archivedAt = new Date().toISOString();
      if (action === "restore") row.archivedAt = null;
      // Delete is the SAME soft delete a single project gets: it leaves the list and joins
      // Recently Deleted. Nothing here removes it from existence.
      if (action === "delete") row.deleted = true;
    }
    if (action === "delete") for (const row of targets) rows.splice(rows.indexOf(row), 1);
    return r.fulfill({ json: { action, changed: targets.length } });
  });
  await page.route("**/api/v1/conversations", listRoute);
  await page.route("**/api/v1/conversations?**", listRoute);
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route(/\/api\/v1\/conversations\/c\d+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop();
    return r.fulfill({ json: { conversation: rows.find((c) => c.id === id) || rows[0], turns: [] } });
  });
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: rows.map((c) => c.site).filter(Boolean) } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  return rows;
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const bulk = (page) => page.locator(".ct-bulkbar");
const cards = (page) => page.locator(".ct-project").filter({ hasText: new RegExp(`^(${NAMES.join("|")})`) });
// The name cell also carries status badges and the star, so pull the project name back out.
const titles = async (page) => (await cards(page).locator(".ct-pname").allInnerTexts())
  .map((t) => t.match(new RegExp(NAMES.join("|")))?.[0] || t.trim());

// ── Favourites ──────────────────────────────────────────────────────────────────────────

test("starring a project pins it above everything, whatever the sort", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(12);
  await expect.poll(async () => (await titles(page))[0]).toBe("Zephyr");

  // Olive is last by activity AND last alphabetically — so if it leads either order afterwards,
  // that can only be because the pin was honoured.
  const olive = cards(page).filter({ hasText: "Olive" });
  await olive.locator(".ct-pfav").click();
  await expect(page.locator(".ct-toast.show")).toContainText("1 project added to favourites");
  await expect.poll(async () => (await titles(page))[0]).toBe("Olive");

  await page.getByLabel("Sort projects").selectOption("name");
  await expect.poll(async () => (await titles(page))[0]).toBe("Olive");
  // And the rest really did re-sort rather than the list being frozen. Zephyr led under activity;
  // under Name the first live app is Quince — grouping still applies beneath the pin.
  await expect.poll(async () => (await titles(page))[1]).toBe("Quince");
  await expect(page.locator(".ct-ws-label").first()).toHaveText("Favourites");
});

test("the favourites filter is served by the server and can be turned back off", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await cards(page).filter({ hasText: "Rowan" }).locator(".ct-pfav").click();

  const chip = page.getByRole("button", { name: /Favourites/ });
  await expect(chip).toContainText("(1)");
  await chip.click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText("Rowan");

  await chip.click();
  await expect(cards(page)).toHaveCount(12);
});

test("a filter that matches nothing still offers a way out", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  // Nothing is starred, so this empties the list. The controls must survive: a filter that hides
  // the control that clears it is a dead end, and this render guard used to have exactly that bug.
  await page.getByRole("button", { name: /Favourites/ }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator(".ct-ws-empty")).toContainText("No favourites yet");

  const chip = page.getByRole("button", { name: /Favourites/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(cards(page)).toHaveCount(12);
});

test("an empty view does not make a returning customer look new", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await expect(page.locator(".ct-hello")).toContainText("Welcome back");
  await page.getByRole("button", { name: /^Archived/ }).click();
  await expect(cards(page)).toHaveCount(0);
  // The account has twelve projects. Only the view is empty.
  await expect(page.locator(".ct-hello")).toContainText("Welcome back");
});

// ── Archive ─────────────────────────────────────────────────────────────────────────────

test("archiving takes a project out of the way and restoring brings it back", async ({ page }) => {
  await stub(page);
  await page.goto("/");

  const willow = cards(page).filter({ hasText: "Willow" });
  await willow.locator(".ct-pselect").check();
  await expect(page.locator(".ct-bulkbar")).toContainText("1 project selected");
  await bulk(page).getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.locator(".ct-toast.show")).toContainText("1 project archived");

  await expect(cards(page)).toHaveCount(11);
  await expect(cards(page).filter({ hasText: "Willow" })).toHaveCount(0);

  await page.getByRole("button", { name: /^Archived/ }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText("Willow");
  // Archive is not delete: the published state travels with it untouched.
  await expect(page.locator(".ct-ws-label")).toContainText("Archived");

  await cards(page).first().locator(".ct-pselect").check();
  await bulk(page).getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".ct-toast.show")).toContainText("1 project restored");
  await expect(cards(page)).toHaveCount(0);

  await page.getByRole("button", { name: /^Archived/ }).click();
  await expect(cards(page)).toHaveCount(12);
});

test("the archive offers restore rather than archive again", async ({ page }) => {
  const rows = await stub(page);
  rows[0].archivedAt = new Date().toISOString();
  await page.goto("/");
  await page.getByRole("button", { name: /^Archived/ }).click();
  await cards(page).first().locator(".ct-pselect").check();
  await expect(bulk(page).getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(bulk(page).getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
});

// ── Bulk ────────────────────────────────────────────────────────────────────────────────

test("select all acts on everything loaded, and says how many", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.locator(".ct-bulkbar")).toContainText("12 projects selected");
  await expect(page.getByRole("button", { name: "Clear selection" })).toBeVisible();

  await bulk(page).getByRole("button", { name: "★ Favourite", exact: true }).click();
  await expect(page.locator(".ct-toast.show")).toContainText("12 projects added to favourites");
  await expect(page.getByRole("button", { name: /Favourites/ })).toContainText("(12)");
  // Selection clears once the action lands, so the bar cannot act twice on a stale set.
  await expect(page.locator(".ct-bulkbar")).toHaveCount(0);
});

test("a bulk failure keeps the projects on screen", async ({ page }) => {
  await stub(page, {
    onBulk: (r) => r.fulfill({ status: 500, json: { error: "That did not work. Nothing was changed." } }),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select all" }).click();
  await bulk(page).getByRole("button", { name: "Archive", exact: true }).click();

  await expect(page.locator(".ct-toast.show")).toContainText("Nothing was changed");
  // The list-level error replaces the whole workspace. Losing every card because one archive
  // failed would be a far worse outcome than the failure.
  await expect(cards(page)).toHaveCount(12);
  await expect(page.locator(".mg-error")).toHaveCount(0);
  // And the selection survives, so it can simply be tried again.
  await expect(page.locator(".ct-bulkbar")).toContainText("12 projects selected");
});

test("keyboard alone can select and act", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  const first = cards(page).first();
  await first.focus();
  await page.keyboard.press("x");
  await expect(page.locator(".ct-bulkbar")).toContainText("1 project selected");
  // The card must now announce what a press will do, not the "Open" it announced a moment ago.
  await expect(first).toHaveAttribute("aria-label", /^Deselect Zephyr/);
  await page.keyboard.press("x");
  await expect(page.locator(".ct-bulkbar")).toHaveCount(0);
});

test("the bulk bar stays reachable while a long list scrolls", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Select all" }).click();
  const bar = page.locator(".ct-bulkbar");
  await expect(bar).toBeVisible();
  await cards(page).last().scrollIntoViewIfNeeded();
  // Sticky, so the action does not scroll away from the selection it applies to.
  await expect(bar).toBeInViewport();
});
