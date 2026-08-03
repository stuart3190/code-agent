// Which builds a project has, and what they are called.
//
// This lives on its own so that the Logs view, the Deployments view and anything else that talks
// about "a build" resolve it through exactly one function. Two callers reading diag_runs their own
// way is how a deployment and its logs end up disagreeing about which run is which.
//
// The other reason this function exists at all: diag_steps has NO `owner` and NO `project_id`. It
// links to its run through `run_id` alone. Ownership therefore has to be established HERE, on the
// table that actually carries it, and steps fetched only for runs that passed that check. The
// previous code filtered diag_steps by owner and project_id directly — columns that do not exist —
// so every build query errored, and a `.catch(() => [])` turned the error into an empty list.

import { serviceClient } from "../supabase.mjs";

/**
 * A project's build runs, newest first.
 *
 * Throws on a read failure. An empty array must mean "this project has never been built", and
 * nothing else — a database problem reported as no history is the bug this replaces.
 */
export async function buildRunsFor(owner, projectId, { client = serviceClient(), limit = 50 } = {}) {
  const { data, error } = await client.from("diag_runs")
    .select("id,status,kind,started_at,finished_at,duration_ms,conversation_id,repair_rounds")
    .eq("owner", owner).eq("project_id", String(projectId))
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`logs: could not resolve build runs: ${error.message}`);
  return data || [];
}
