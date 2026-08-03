// The publish lifecycle as the dashboard shows it.
//
// draft → published → update_available → unpublished → published again. Every project sits in
// exactly one of these, and the tabs are views over the same field rather than separate queries.

// Re-exported, never redefined. The vocabulary lives in one module that the server imports too,
// so a status string cannot mean one thing on the client and another on the server.
import { PUBLISH_STATUS, TAB_STATUSES, tabMatches, isLiveStatus } from "../../../shared/publishResolution.mjs";
import { HEALTH_LABEL, HEALTH_TONE, healthStateOf, isHealthProblem } from "../../../shared/operationalState.mjs";

export const STATUS = PUBLISH_STATUS;
export { TAB_STATUSES };

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
  { id: "all", label: "All" },
  { id: "drafts", label: "Drafts" },
  { id: "published", label: "Published" },
  { id: "updates", label: "Update Available" },
  // The membership test comes from the shared map the SERVER filters pages by, so a tab cannot
  // show a count its page could not produce.
].map((tab) => ({ ...tab, matches: (status) => tabMatches(tab.id, status) })));

export function statusOf(conversation) {
  return conversation?.publishStatus || STATUS.draft;
}

// Domain vocabulary lives in the shared operational module, which the SERVER imports too — a
// notification about a domain becoming Active should use the same word the panel does.
export {
  DOMAIN_LABEL as DOMAIN_STATUS_LABEL, domainExplanation as domainHint, isDomainLive,
} from "../../../shared/operationalState.mjs";

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
    const state = healthStateOf(health);
    if (isHealthProblem(state)) {
      badges.push({ id: state === "offline" ? "offline" : "degraded", label: HEALTH_LABEL[state].toUpperCase(), tone: HEALTH_TONE[state] });
    }
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

// A const, not a bare re-export: `export { x as y }` creates no local binding, and `badgesFor`
// and GROUPS above both call this by name.
export const isLive = isLiveStatus;

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
