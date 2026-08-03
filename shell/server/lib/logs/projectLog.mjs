// Writing project lifecycle logs.
//
// Every call is fire-and-forget by design: logging must never be able to fail the thing it is
// describing. A publish that worked but whose log line did not write is a publish that worked.

import { serviceClient } from "../supabase.mjs";

export const LOG_LEVELS = Object.freeze(["info", "warning", "error", "critical"]);
// LOG_SOURCES was a third copy of this list that nothing imported. The shared one lives in
// shell/shared/logSources.mjs.

const MAX_DETAIL = 8_000;

export async function writeLog({
  owner, projectId, level = "info", source, message, detail = null,
  refType = null, refId = null, durationMs = null, client = serviceClient(), at = new Date(),
}) {
  if (!owner || !projectId || !source || !message) return { written: false };
  if (!LOG_LEVELS.includes(level)) level = "info";
  const { error } = await client.from("project_logs").insert({
    owner,
    project_id: String(projectId),
    logged_at: at.toISOString(),
    level,
    source,
    message: String(message).slice(0, 500),
    detail: detail ? String(detail).slice(0, MAX_DETAIL) : null,
    ref_type: refType,
    ref_id: refId ? String(refId) : null,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
  });
  if (error) {
    console.error(`[project-log] ${error.message || error}`);
    return { written: false };
  }
  return { written: true };
}

// The shape callers actually use. Swallows everything: a caller should be able to log without
// wrapping every call, and without a logging failure changing what their code does.
export function logProject(fields) {
  return writeLog(fields).catch((error) => {
    console.error(`[project-log] ${error?.message || error}`);
    return { written: false };
  });
}
