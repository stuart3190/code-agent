// The sources a project log entry can come from.
//
// This list existed three times: `LOG_SOURCES` in projectLog.mjs (which nothing imported),
// `SOURCES` in logReader.mjs, and a labelled copy in LogsView.jsx in a different order. Adding a
// source meant editing three files and noticing the third.
//
// Order here is display order — what someone scanning the filter chips reads left to right, which
// is roughly "what Thrallo did" then "what visitors hit". The server only cares about the ids.

export const LOG_SOURCES = Object.freeze([
  { id: "publish", label: "Publish" },
  { id: "deploy", label: "Deploy" },
  { id: "build", label: "Build" },
  { id: "runtime", label: "Runtime" },
  { id: "visitor", label: "Visitor" },
  { id: "domain", label: "Domain" },
  { id: "system", label: "System" },
]);

export const LOG_SOURCE_IDS = Object.freeze(LOG_SOURCES.map((s) => s.id));

export const LOG_LEVELS = Object.freeze([
  { id: "info", label: "Info" },
  { id: "warning", label: "Warning" },
  { id: "error", label: "Error" },
  { id: "critical", label: "Critical" },
]);

export const LOG_LEVEL_IDS = Object.freeze(LOG_LEVELS.map((l) => l.id));

// The two sources that come from real visitors rather than from Thrallo. They are read from
// analytics_events rather than project_logs, which is why several places need to tell them apart.
export const VISITOR_SOURCES = Object.freeze(["runtime", "visitor"]);
