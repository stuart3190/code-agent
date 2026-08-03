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

// LIVE, not "Published", for a site that is currently serving. It is the fact people scan for, and
// it reads at a glance in a way a past-tense word does not. Update Available still says LIVE
// alongside it, because the site IS live — it is simply not the newest build.
export const STATUS_LABEL = Object.freeze({
  draft: "Draft",
  published: "LIVE",
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

// Custom domain states, in one place so the conversation, the Domains panel, the Overview tile and
// the project card cannot describe the same domain differently. Only `active` may ever be said to
// be live or secured — a domain still proving itself has no certificate, and claiming otherwise
// would send people to a hostname that does not answer.
export const DOMAIN_STATUS_LABEL = Object.freeze({
  pending_dns: "Pending DNS",
  verifying: "Verifying",
  active: "Active",
  failed: "Failed",
});

export const DOMAIN_STATUS_HINT = Object.freeze({
  pending_dns: "Add the records below at your DNS provider. We check every minute.",
  verifying: "Ownership confirmed. Waiting for the domain to point at Thrallo.",
  active: "Live and secured with HTTPS.",
  failed: "We stopped checking. Fix the records and retry.",
});

export const isDomainLive = (status) => status === "active";

/**
 * The badges for a project card. A set, not one value — a project can be LIVE and BUILDING at the
 * same time, and a site serving an older build is genuinely both LIVE and UPDATE AVAILABLE. A
 * coloured dot could only ever say one of those things, which is why it is gone.
 *
 * Order matters: what is true of the deployment comes first, then what is happening right now.
 */
export function badgesFor(conversation) {
  const badges = [];
  const status = statusOf(conversation);

  if (status === STATUS.published || status === STATUS.updateAvailable) {
    badges.push({ id: "live", label: "LIVE", tone: "live" });
  }
  if (status === STATUS.updateAvailable) {
    badges.push({ id: "update", label: "UPDATE AVAILABLE", tone: "update" });
  }
  if (status === STATUS.unpublished) {
    badges.push({ id: "unpublished", label: "UNPUBLISHED", tone: "muted" });
  }
  if (status === STATUS.draft) {
    badges.push({ id: "draft", label: "DRAFT", tone: "muted" });
  }

  // Health outranks activity on a live site: "is it up" beats "what is it doing".
  //
  // Only PROBLEMS are badged. "Not yet checked" is a real state and is shown on the Health page
  // and the Overview tile, but putting it on every card for the five minutes before the first
  // sweep would be permanent chrome saying nothing is wrong (Principle 3).
  const health = conversation?.health;
  if (isLive(status) && health) {
    if (health.status === "offline") badges.push({ id: "offline", label: "OFFLINE", tone: "failed" });
    else if (health.status === "warning") badges.push({ id: "degraded", label: "DEGRADED", tone: "update" });
  }

  if (conversation?.activity) {
    badges.push({ id: "building", label: "BUILDING", tone: "building" });
  } else if (conversation?.state === "waiting_user") {
    badges.push({ id: "waiting", label: "NEEDS INPUT", tone: "update" });
  } else if (conversation?.failed && !conversation?.verified && !conversation?.hasPreview) {
    // Only a build that produced nothing usable is a failure worth flagging on the card; a failed
    // attempt on a project that is still live would be alarming and untrue.
    badges.push({ id: "failed", label: "FAILED", tone: "failed" });
  }

  return badges;
}

// Which section of the dashboard a project belongs in.
export const GROUPS = Object.freeze([
  { id: "live", label: "Live apps", matches: (c) => isLive(statusOf(c)) },
  { id: "progress", label: "In progress", matches: (c) => !!c.activity || c.state === "waiting_user" },
  { id: "drafts", label: "Drafts", matches: () => true },
]);

// Each project appears exactly once, in the first group that claims it — a project that is live
// AND building belongs under Live apps, because that is what it IS rather than what it is doing.
export function groupProjects(conversations) {
  const seen = new Set();
  return GROUPS.map((group) => ({
    ...group,
    items: conversations.filter((c) => {
      if (seen.has(c.id) || !group.matches(c)) return false;
      seen.add(c.id);
      return true;
    }),
  })).filter((group) => group.items.length > 0);
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
