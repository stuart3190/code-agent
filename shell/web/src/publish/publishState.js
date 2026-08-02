// Published state, shared by the dashboard cards and the in-conversation panel.
//
// One fetch for the whole account: the list is small (one row per published project) and both
// surfaces need the same answer, so a single source stops the card badge and the panel disagreeing.

import { useCallback, useEffect, useState } from "react";
import { publishState } from "../lib/codeAgentApi.js";

export function usePublishState() {
  const [sites, setSites] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await publishState();
      setSites(result.sites || []);
    } catch {
      // Decoration on top of the real work — never surfaced as an error.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const byProduct = useCallback(
    (productId) => (productId ? sites.find((s) => s.productId === String(productId)) || null : null),
    [sites],
  );

  return { sites, loaded, refresh, byProduct };
}

// "2 minutes ago" / "3 days ago". Publish recency is what people actually want to know; an
// absolute timestamp makes them do the subtraction.
export function relativeTime(iso) {
  if (!iso) return null;
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 60) return "just now";
  const units = [
    ["minute", 60], ["hour", 60], ["day", 24], ["month", 30.44], ["year", 12],
  ];
  let value = seconds / 60;
  let name = "minute";
  for (let i = 0; i < units.length - 1; i += 1) {
    if (value < units[i + 1][1]) { name = units[i][0]; break; }
    value /= units[i + 1][1];
    name = units[i + 1][0];
  }
  const rounded = Math.floor(value);
  return `${rounded} ${name}${rounded === 1 ? "" : "s"} ago`;
}

export function displayUrl(url) {
  return String(url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}
