// The publish lifecycle as the dashboard shows it.
//
// draft → published → update_available → unpublished → published again. Every project sits in
// exactly one of these, and the tabs are views over the same field rather than separate queries.

export const STATUS = Object.freeze({
  draft: "draft",
  published: "published",
  updateAvailable: "update_available",
  unpublished: "unpublished",
});

export const STATUS_LABEL = Object.freeze({
  draft: "Draft",
  published: "Published",
  update_available: "Update Available",
  unpublished: "Unpublished",
});

// Drafts and unpublished projects share a tab: both describe a project with nothing live, which is
// the question the tab answers. The badge still distinguishes them, because "never published" and
// "taken offline" are different facts about the same project.
export const TABS = Object.freeze([
  { id: "all", label: "All", matches: () => true },
  { id: "drafts", label: "Drafts", matches: (s) => s === STATUS.draft || s === STATUS.unpublished },
  { id: "published", label: "Published", matches: (s) => s === STATUS.published },
  { id: "updates", label: "Update Available", matches: (s) => s === STATUS.updateAvailable },
]);

export function statusOf(conversation) {
  return conversation?.publishStatus || STATUS.draft;
}

export function isLive(status) {
  return status === STATUS.published || status === STATUS.updateAvailable;
}

export function countByTab(conversations) {
  const counts = {};
  for (const tab of TABS) {
    counts[tab.id] = conversations.filter((c) => tab.matches(statusOf(c))).length;
  }
  return counts;
}

export function relativeTime(iso) {
  if (!iso) return null;
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 60) return "just now";
  const steps = [["minute", 60], ["hour", 60], ["day", 24], ["month", 30.44], ["year", 12]];
  let value = seconds / 60;
  let name = "minute";
  for (let i = 0; i < steps.length - 1; i += 1) {
    if (value < steps[i + 1][1]) { name = steps[i][0]; break; }
    value /= steps[i + 1][1];
    name = steps[i + 1][0];
  }
  const rounded = Math.floor(value);
  return `${rounded} ${name}${rounded === 1 ? "" : "s"} ago`;
}

export function displayUrl(url) {
  return String(url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}
