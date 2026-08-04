// How much of a live log stream the view keeps.
//
// A plain module, not part of LogsView.jsx, for the same reason usageWarnings.js is one: the node
// suite can then verify the bound directly, without a renderer.
//
// Both the rendered list and the dedupe Set grew without limit while Live was on, so a busy site
// left on the Logs tab rendered an ever-longer list and held every id it had ever seen.

// Far more than anyone reads in a sitting, far less than a busy site emits in an hour.
export const LIVE_LIMIT = 1_000;

/**
 * Keep the newest entries and forget the rest.
 *
 * The dedupe Set is trimmed WITH the list rather than separately: an id that has scrolled off
 * cannot arrive again from the live stream — the stream only moves forward — and keeping it would
 * mean the Set grows for as long as the tab is open. "Load older" is how you reach what fell off.
 */
export function trimEntries(entries, seen, limit = LIVE_LIMIT) {
  if (entries.length <= limit) return entries;
  const kept = entries.slice(0, limit);
  if (seen) {
    for (const entry of entries.slice(limit)) seen.delete(entry.id);
  }
  return kept;
}
