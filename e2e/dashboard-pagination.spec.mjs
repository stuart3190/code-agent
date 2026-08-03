// The Home dashboard past twenty projects.
//
// Two ceilings used to hide work with nothing on screen admitting it: the server returned the
// first 20 conversations, and the client then showed the in-progress ones plus SIX of the rest. A
// customer with thirty projects could see nine of them and no indication the others existed.
//
// Filtering and searching are now server-side for the same reason: filtering one page and calling
// it a filter hides everything after it, and a tab count computed from a page describes the page.

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

// 45 projects: more than the old server cap of 20 and far more than the old client cap of 6.
// Every third is published, so paging cannot accidentally group them all onto one page.
const ALL = Array.from({ length: 45 }, (_, i) => {
  const published = i % 3 === 0;
  const projectId = `p${String(i).padStart(2, "0")}`;
  return {
    id: `c${String(i).padStart(2, "0")}`,
    title: `Project ${String(i).padStart(2, "0")}`,
    state: "idle",
    productId: `prod-${i}`,
    publishStatus: published ? "published" : "draft",
    // Ordered oldest-last so page order is assertable.
    last_activity_at: new Date(Date.now() - i * 60_000).toISOString(),
    site: published ? {
      projectId, currentProjectId: projectId, productId: `prod-${i}`,
      name: `Project ${String(i).padStart(2, "0")}`, slug: `project-${i}`,
      url: `https://project-${i}.app.thrallo.com`, environment: "production",
      publishedAt: new Date(Date.now() - i * 60_000).toISOString(),
      firstPublishedAt: "2026-07-01T00:00:00.000Z", unpublishedAt: null,
      live: true, updateAvailable: false, status: "published", domains: [],
    } : null,
  };
});

async function stub(page, rows = ALL) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
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
    const statuses = TAB_STATUSES[tab] || null;

    // The store partitions on archived_at before anything else does, so the stub must too —
    // otherwise a spec would pass against a server that treated archive as a client-side filter.
    const visible = rows.filter((c) => !!c.archivedAt === archived);
    const counts = { all: visible.length, favourites: visible.filter((c) => c.favourite).length };
    for (const [id, list] of Object.entries(TAB_STATUSES)) {
      counts[id] = visible.filter((c) => list.includes(c.publishStatus || "draft")).length;
    }
    const matching = visible.filter((c) => {
      if (statuses && !statuses.includes(c.publishStatus || "draft")) return false;
      if (favouritesOnly && !c.favourite) return false;
      return !search || String(c.title || "").toLowerCase().includes(search);
    });
    // Favourites lead whatever the ordering is, with a stable id tiebreak — the server's contract.
    matching.sort((a, b) => {
      if (!!a.favourite !== !!b.favourite) return a.favourite ? -1 : 1;
      const by = sort === "name" ? String(a.title || "").localeCompare(String(b.title || ""))
        : Date.parse(b.last_activity_at || 0) - Date.parse(a.last_activity_at || 0);
      return by || String(a.id).localeCompare(String(b.id));
    });
    const slice = matching.slice(offset, offset + limit);
    return r.fulfill({ json: {
      conversations: slice,
      counts,
      page: {
        offset, limit, total: matching.length,
        nextOffset: offset + slice.length < matching.length ? offset + slice.length : null,
        tab, search: search || null, sort, favourites: favouritesOnly, archived,
      },
      sorts: [
        { id: "activity", label: "Last activity" }, { id: "created", label: "Newest" },
        { id: "name", label: "Name" }, { id: "deployed", label: "Last deployed" },
      ],
    } });
  };
  await page.route("**/api/v1/conversations", listRoute);
  await page.route("**/api/v1/conversations?**", listRoute);
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  // Opening a card fetches the conversation itself; without this it falls through to the real
  // server and the panel never renders.
  await page.route(/\/api\/v1\/conversations\/c\d+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop();
    const row = rows.find((c) => c.id === id) || rows[0];
    return r.fulfill({ json: { conversation: row, turns: [] } });
  });
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: {
    sites: rows.map((c) => c.site).filter(Boolean),
  } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const cards = (page) => page.locator(".ct-project").filter({ hasText: /^Project \d\d/ });

test("more than twenty projects can be reached, and the count says how many remain", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(20);
  // The old dashboard showed six of these and said nothing about the other thirty-nine.
  const more = page.getByRole("button", { name: /Load more/ });
  await expect(more).toContainText("25 more");

  await more.click();
  await expect(cards(page)).toHaveCount(40);
  await expect(page.getByRole("button", { name: /Load more/ })).toContainText("5 more");

  await page.getByRole("button", { name: /Load more/ }).click();
  await expect(cards(page)).toHaveCount(45);
  await expect(page.getByRole("button", { name: /Load more/ })).toHaveCount(0);
  await expect(page.locator(".ct-workspace")).toContainText("All 45 projects shown");
});

test("tab counts describe the account, not the page on screen", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  // 15 of 45 are published — a number the first page of twenty cannot produce by counting itself.
  await expect(page.getByRole("tab", { name: /Published/ })).toContainText("15");
  await expect(page.getByRole("tab", { name: /^All/ })).toContainText("45");
});

test("filtering by tab spans every page, not just the loaded one", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /Published/ }).click();

  // Published projects are every third, so most of them live beyond the first page. A client-side
  // filter over one page would find at most seven.
  await expect(cards(page)).toHaveCount(15);
  await expect(page.getByRole("button", { name: /Load more/ })).toHaveCount(0);
  for (const card of await cards(page).all()) {
    await expect(card).toContainText("LIVE");
  }
});

test("search reaches projects that are not on the current page", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  // Project 42 is on the third page.
  await page.getByLabel("Search projects").fill("Project 42");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText("Project 42");
});

test("a search that matches nothing says so rather than falling back to everything", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await page.getByLabel("Search projects").fill("nothing matches this");
  await expect(page.locator(".ct-ws-empty")).toContainText("Nothing matches");
  await expect(cards(page)).toHaveCount(0);
});

test("paging keeps its order — page two continues page one", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  const firstPage = await cards(page).allInnerTexts();
  await page.getByRole("button", { name: /Load more/ }).click();
  const both = await cards(page).allInnerTexts();
  expect(both.slice(0, firstPage.length)).toEqual(firstPage);
  // And nothing is repeated across the boundary.
  const titles = both.map((t) => t.match(/Project \d\d/)?.[0]).filter(Boolean);
  expect(new Set(titles).size).toBe(titles.length);
});

test("a deep link still opens its project when that project is on a later page", async ({ page }) => {
  await stub(page);
  // p42's card is on the third page; the dashboard resolves it from publish state, which is not
  // paginated, so the link must work without loading pages first.
  await page.goto("/projects/p42/overview");
  await expect(page.locator(".ct-projdash")).toBeVisible();
  await expect(page.locator(".ct-projdash")).toContainText("project-42.app.thrallo.com");
});

test("a failed list says so instead of showing an empty dashboard", async ({ page }) => {
  await stub(page);
  await page.route("**/api/v1/conversations?**", (r) => r.fulfill({ status: 500, json: { error: "Projects unavailable." } }));
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ status: 500, json: { error: "Projects unavailable." } }));
  await page.goto("/");
  // "You have no projects" would be the most alarming possible way to report a server error.
  await expect(page.locator(".mg-error")).toContainText("Projects unavailable");
  await expect(cards(page)).toHaveCount(0);
});

test("the card and the publish panel never disagree about status", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  const card = cards(page).filter({ hasText: "Project 00" });
  await expect(card).toContainText("LIVE");

  // The project NAME, not the card's centre: the centre lands on the published row, whose link
  // stops the click from reaching the card.
  await card.locator(".ct-pname").click();

  // Same status, from the same resolver, in the panel above the conversation. This is the exact
  // pair that could disagree: the card read the conversation's publishStatus (server, last-wins)
  // and the panel read publish state through `.find()` (client, first-wins).
  await expect(page.locator(".ct-published-head").first()).toContainText("LIVE");
});
