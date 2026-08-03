// THE publish status resolver. One implementation, imported by the server and by the web app.
//
// This exists because there were two, and they disagreed. `routes/conversations.mjs` built a Map
// from the publish states — so when a product owned more than one published row, the LAST won.
// `shell/web/src/publish/publishState.js` used `.find()` on the same list — so the FIRST won. A
// product with two rows could therefore show UNPUBLISHED on its dashboard card and LIVE in the
// panel directly above it, from the same fetch, in the same second.
//
// The fix is not to make the two agree by hand. It is to have one function, so there is no second
// place that could drift. Everything here is pure — no database, no imports — precisely so both
// sides can use it.

export const PUBLISH_STATUS = Object.freeze({
  draft: "draft",
  published: "published",
  updateAvailable: "update_available",
  unpublished: "unpublished",
});

const LIVE_STATUSES = new Set([PUBLISH_STATUS.published, PUBLISH_STATUS.updateAvailable]);

export const isLiveStatus = (status) => LIVE_STATUSES.has(status);

/**
 * The dashboard tabs, as a mapping from tab to the statuses it covers.
 *
 * Shared because the server filters pages by it and the client labels by it. Two copies would let
 * a tab claim a count the page could not produce — which is the same class of bug as two status
 * resolvers, one page down.
 *
 * Drafts and unpublished share a tab: both answer "nothing of mine is live here", which is the
 * question the tab is asked. The badge still tells them apart.
 */
export const TAB_STATUSES = Object.freeze({
  all: null,
  drafts: Object.freeze([PUBLISH_STATUS.draft, PUBLISH_STATUS.unpublished]),
  published: Object.freeze([PUBLISH_STATUS.published]),
  updates: Object.freeze([PUBLISH_STATUS.updateAvailable]),
});

export function tabMatches(tabId, status) {
  const statuses = TAB_STATUSES[tabId];
  return !statuses || statuses.includes(status);
}

const time = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Which of several publish records is the CURRENT one for a product.
 *
 * A product can own several project rows — every rebuild can create one — and each can have left a
 * published_sites row behind. Exactly one of them is the truth about what is serving right now.
 *
 * The order is total, so the answer never depends on which row a query happened to return first:
 *
 *   1. A live record beats an unpublished one. If anything is serving, that is the status.
 *   2. Then the most recently published.
 *   3. Then, only to break a genuine tie, the higher projectId — arbitrary but STABLE, which is
 *      the property that matters. A tiebreak that varies by query order is how two surfaces
 *      disagree while both are "correct".
 */
export function pickActiveSite(candidates) {
  const list = (candidates || []).filter(Boolean);
  if (list.length <= 1) return list[0] || null;
  return [...list].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    const byTime = time(b.publishedAt) - time(a.publishedAt);
    if (byTime) return byTime;
    return String(b.projectId).localeCompare(String(a.projectId));
  })[0];
}

/**
 * Build the lookup every surface reads from.
 *
 * `conflicts` is deliberately part of the result rather than swallowed: two live records for one
 * product is a data fault, and the resolver is the only place that can see it. Reporting it is
 * what lets the repair tool find and fix it instead of the platform quietly picking a winner
 * forever.
 */
export function resolvePublishState(states = []) {
  const byProduct = new Map();
  const byProject = new Map();
  const grouped = new Map();

  for (const state of states) {
    if (!state) continue;
    byProject.set(String(state.projectId), state);
    if (!state.productId) continue;             // stands alone; reachable only by projectId
    const key = String(state.productId);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(state);
  }

  const conflicts = [];
  for (const [productId, candidates] of grouped) {
    const winner = pickActiveSite(candidates);
    byProduct.set(productId, winner);
    const liveOnes = candidates.filter((c) => c.live);
    if (liveOnes.length > 1) {
      conflicts.push({
        productId,
        kind: "multiple_live",
        active: winner.projectId,
        superseded: liveOnes.filter((c) => c.projectId !== winner.projectId).map((c) => c.projectId),
      });
    }
  }

  const forProduct = (productId) => (productId ? byProduct.get(String(productId)) || null : null);
  const forProject = (projectId) => (projectId ? byProject.get(String(projectId)) || null : null);

  return {
    byProduct,
    byProject,
    conflicts,
    forProduct,
    forProject,
    /**
     * The status to label something with.
     *
     * A project id is honoured even when there is no product, because a published project whose
     * product link is missing is still genuinely published — filtering those out is what made a
     * live site render as a draft.
     */
    site({ productId = null, projectId = null } = {}) {
      return forProduct(productId) || forProject(projectId) || null;
    },
    statusFor(keys) {
      // Never published is a status, not an absence: the dashboard tabs filter on it.
      return this.site(keys)?.status || PUBLISH_STATUS.draft;
    },
  };
}
