export const browserPages = Object.freeze({
  "thrallo://home": Object.freeze({ title: "Workspace overview", eyebrow: "Fixture page", heading: "Welcome back to My Workspace", body: "Everything in this browser stays inside the deterministic C1 demo.", rows: Object.freeze(["Four active projects", "Two recent downloads", "Workspace backup complete"]) }),
  "thrallo://projects": Object.freeze({ title: "Projects", eyebrow: "Fixture workspace", heading: "Your cloud projects", body: "Review the bundled projects in this safe, offline browser.", rows: Object.freeze(["Customer portal", "Launch campaign", "Operations dashboard"]) }),
  "thrallo://activity": Object.freeze({ title: "Activity", eyebrow: "Fixture history", heading: "Recent workspace activity", body: "A deterministic record of changes made in this prototype.", rows: Object.freeze(["Brand brief uploaded", "Workspace backup created", "Project folder renamed"]) }),
});

export const initialFiles = Object.freeze([
  Object.freeze({ id: "starter-project", name: "Starter Project", type: "folder", location: "Cloud drive", size: "8.2 GB", modified: "Today, 9:41 AM" }),
  Object.freeze({ id: "design-system", name: "Design System", type: "folder", location: "Cloud drive", size: "3.6 GB", modified: "Today, 8:15 AM" }),
  Object.freeze({ id: "marketing-site", name: "Marketing Site", type: "folder", location: "Cloud drive", size: "2.9 GB", modified: "Yesterday" }),
  Object.freeze({ id: "brand-guide", name: "brand-guidelines.pdf", type: "file", location: "Cloud drive", size: "4.3 MB", modified: "Yesterday" }),
  Object.freeze({ id: "launch-notes", name: "launch-notes.txt", type: "file", location: "Cloud drive", size: "18 KB", modified: "2 days ago" }),
]);

export const githubFixture = Object.freeze({
  account: "taylor-morgan",
  status: "Connected fixture",
  repositories: Object.freeze([
    Object.freeze({ name: "customer-portal", branch: "main", visibility: "Private", status: "Up to date", updated: "2h ago" }),
    Object.freeze({ name: "launch-campaign", branch: "design-refresh", visibility: "Private", status: "3 changes", updated: "5h ago" }),
    Object.freeze({ name: "ops-dashboard", branch: "main", visibility: "Private", status: "Up to date", updated: "Yesterday" }),
  ]),
  pullRequests: Object.freeze([
    Object.freeze({ id: 48, title: "Refine onboarding layout", repo: "customer-portal", status: "Ready for review" }),
    Object.freeze({ id: 31, title: "Update launch assets", repo: "launch-campaign", status: "Checks passing" }),
  ]),
  activity: Object.freeze(["Merged pull request #46", "Created branch design-refresh", "Reviewed pull request #29"]),
});

export const storageFixtures = Object.freeze({
  normal: Object.freeze({ total: 200, used: 68, label: "Storage is healthy", tone: "positive", projects: 41, downloads: 9, backups: 18 }),
  warning: Object.freeze({ total: 200, used: 166, label: "Storage is getting full", tone: "warning", projects: 112, downloads: 24, backups: 30 }),
  "near-full": Object.freeze({ total: 200, used: 193, label: "Almost out of storage", tone: "critical", projects: 127, downloads: 26, backups: 40 }),
});
