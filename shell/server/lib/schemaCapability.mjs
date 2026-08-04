// Features whose table was never provisioned on this deployment.
//
// Thrallo's backend is derived from Buildr101's, and it inherited code for tables that its own
// database never received: `project_integrations` and `connector_actions` exist in
// supabase/migrations but not in the Thrallo project. The result was a scary line on EVERY build —
//
//   connectors: unavailable — Could not find the table 'public.project_integrations' in the schema cache
//
// — that read like a fault and was in fact a permanently absent optional feature.
//
// A missing table is not a transient error and not something a retry improves. It is a capability
// this deployment does not have. Recognise it, say so once, and let the caller carry on without it.
// Anything else (a network blip, a permissions error, a genuine bug) still propagates.

const PGRST_UNDEFINED_TABLE = "PGRST205"; // PostgREST: table not found in the schema cache
const UNDEFINED_TABLE = "42P01";          // Postgres: relation does not exist

const announced = new Set();

/**
 * True when this error means "that table does not exist here", rather than "that query failed".
 */
export function isMissingTable(error) {
  if (!error) return false;
  const code = error.code || error.details?.code || "";
  if (code === PGRST_UNDEFINED_TABLE || code === UNDEFINED_TABLE) return true;
  const message = String(error.message || error);
  return /Could not find the table|relation ".+" does not exist|schema cache/i.test(message);
}

/**
 * Log the absence once per process, then stay quiet.
 *
 * Every build logging the same permanent condition is noise that trains operators to skim, which is
 * how a real failure gets missed. Once is informative; four hundred times is wallpaper.
 */
export function noteMissingCapability(feature, error) {
  if (announced.has(feature)) return false;
  announced.add(feature);
  console.warn(`[capability] ${feature} is not available on this deployment: its table has not been provisioned. ` +
    `Apply the migration that creates it to enable the feature. (${String(error?.message || error).slice(0, 160)})`);
  return true;
}

/**
 * Run a query that depends on an optional table; fall back if the table is not there.
 *
 * The fallback is only ever reached for a genuinely absent table — every other error is rethrown,
 * so this can never hide a real fault behind a default value.
 */
export async function withOptionalTable(feature, run, fallback) {
  try {
    return await run();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    noteMissingCapability(feature, error);
    return typeof fallback === "function" ? fallback() : fallback;
  }
}

// Test seam: the once-per-process memory is process state, and a test that asserts the first call
// logs must be able to start from a known point.
export function resetCapabilityNotices() {
  announced.clear();
}
