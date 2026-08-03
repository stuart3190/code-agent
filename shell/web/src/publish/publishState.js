// Published state, shared by the dashboard cards and the in-conversation panel.
//
// One fetch for the whole account: the list is small (one row per published project) and both
// surfaces need the same answer, so a single source stops the card badge and the panel disagreeing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { publishState } from "../lib/codeAgentApi.js";
// The SAME resolver the server uses. This file used to pick with `.find()` — first wins — while
// the conversations route built a Map — last wins. For a product with two published rows the card
// and the panel above it could disagree, from one fetch, in the same second.
import { resolvePublishState } from "../../../shared/publishResolution.mjs";
import { isDeploymentSettled } from "../../../shared/deploymentState.mjs";

// Fast enough that a publish feels live, slow enough not to hammer the API. Matches the poll
// DeploymentsView already uses, so the two surfaces settle together.
const PUBLISH_POLL_MS = 5_000;

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

  // While a publish is going out, publish state is stale the moment it renders. Polling stops the
  // instant every deployment reaches a terminal status — a surface that keeps asking after one has
  // failed would ask forever, and `isDeploymentSettled` is the shared answer to "will this change
  // again".
  const moving = useMemo(
    () => sites.some((s) => s.lastAttempt && !isDeploymentSettled(s.lastAttempt.status)),
    [sites],
  );
  useEffect(() => {
    if (!moving) return undefined;
    const timer = setInterval(refresh, PUBLISH_POLL_MS);
    return () => clearInterval(timer);
  }, [moving, refresh]);

  const resolved = useMemo(() => resolvePublishState(sites), [sites]);

  const byProduct = useCallback((productId) => resolved.forProduct(productId), [resolved]);
  // A published project whose product link is missing is still genuinely published, and is
  // reachable by its own id.
  const byProject = useCallback((projectId) => resolved.forProject(projectId), [resolved]);

  return { sites, loaded, refresh, byProduct, byProject, conflicts: resolved.conflicts };
}

// relativeTime and displayUrl used to be defined here as well as in publishLifecycle.js —
// logically identical, cosmetically different, with components importing whichever they happened
// to reach for. One definition now lives in publishLifecycle.js.
export { relativeTime, displayUrl } from "./publishLifecycle.js";
