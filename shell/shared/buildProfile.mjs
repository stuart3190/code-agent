// Canonical product-intent context for Builder V2. This is deliberately distinct from the
// Builder V2 complexity/budget profile: it describes WHAT is being built, not how much work the
// build may spend. Browser input is normalized here again on the server before it becomes
// authoritative conversation, contract, graph, or build-spec data.

import { functionalOutputEffect } from "./implementationContract.mjs";

export const BUILD_PROFILE_VERSION = 1;

export const BUILD_TYPES = Object.freeze(["auto", "website", "application"]);
export const APPLICATION_SUBTYPES = Object.freeze([
  "auto", "saas", "internal_tool", "ecommerce", "general_application", "other",
]);
export const REQUIREMENT_SIGNALS = Object.freeze([
  "user_accounts",
  "saved_data",
  "payments",
  "file_uploads",
  "custom_logic",
  "interactive_workspace",
  "realtime",
  "admin",
  "export",
]);
export const INFERENCE_SOURCES = Object.freeze(["auto", "explicit", "adjusted", "legacy_auto"]);

export const BUILD_TYPE_OPTIONS = Object.freeze([
  { id: "auto", label: "Auto" },
  { id: "website", label: "Website" },
  { id: "application", label: "Application" },
]);
export const APPLICATION_SUBTYPE_OPTIONS = Object.freeze([
  { id: "auto", label: "Auto" },
  { id: "saas", label: "SaaS" },
  { id: "internal_tool", label: "Internal tool / dashboard" },
  { id: "ecommerce", label: "E-commerce" },
  { id: "general_application", label: "General application" },
  { id: "other", label: "Other" },
]);
export const REQUIREMENT_SIGNAL_OPTIONS = Object.freeze([
  { id: "user_accounts", label: "User accounts" },
  { id: "saved_data", label: "Saved data / database" },
  { id: "payments", label: "Payments / subscriptions" },
  { id: "file_uploads", label: "File uploads" },
  { id: "custom_logic", label: "Custom calculations / logic" },
  { id: "interactive_workspace", label: "Interactive workspace / canvas" },
  { id: "realtime", label: "Real-time features" },
  { id: "admin", label: "Admin area" },
  { id: "export", label: "Export / download" },
]);

const PROFILE_KEYS = new Set([
  "version", "requestedBuildType", "resolvedBuildType", "applicationSubtype",
  "requirementSignals", "inferenceSource", "confidence",
]);
const TYPE_LABELS = new Map(BUILD_TYPE_OPTIONS.map((option) => [option.id, option.label]));
const SUBTYPE_LABELS = new Map(APPLICATION_SUBTYPE_OPTIONS.map((option) => [option.id, option.label]));
const SIGNAL_LABELS = new Map(REQUIREMENT_SIGNAL_OPTIONS.map((option) => [option.id, option.label]));
const SIGNAL_GUIDANCE = Object.freeze({
  user_accounts: "declare authentication and user-owned data boundaries where the request needs them",
  saved_data: "declare durable entities, persistence operations, and the state owner",
  payments: "declare the requested payment journey without assuming a subscription model",
  file_uploads: "declare file ownership, upload interaction, storage result, and failure state",
  custom_logic: "declare each transformation as a functional responsibility with explicit reads and writes",
  interactive_workspace: "declare structured interactions, state transitions, and state ownership",
  realtime: "declare the live event, participants, authoritative state, and observable update",
  admin: "declare admin ownership, permissions, actions, and observable outcomes",
  export: "declare an output journey, source state, format, and observable downloadable result",
});

const WEBSITE_PATTERNS = [
  /\b(?:marketing|landing|brochure|portfolio|informational)\s+(?:web)?site\b/i,
  /\b(?:website|web\s*site|blog|content site|company site|business site)\b/i,
  /\b(?:home|about|services|contact)\s+pages?\b/i,
];
const APPLICATION_PATTERNS = [
  /\b(?:app|application|web app|software|saas|dashboard|portal|platform|internal tool)\b/i,
  /\b(?:manage|track|workflow|planner|editor)\b/i,
];
const SIGNAL_PATTERNS = Object.freeze({
  user_accounts: [
    /\b(?:user accounts?|sign[ -]?in|log[ -]?in|register|registered users?|multi[ -]?user|member portal)\b/i,
    /\bteam members?\s+(?:accounts?|access|log[ -]?in|sign[ -]?in)\b/i,
    /\b(?:tenant|workspace)\s+(?:owner|member|access|account)s?\b/i,
  ],
  saved_data: [
    /\b(?:save|saved|reopen|persist|persistent|database|stored records?|history)\b/i,
    /\b(?:save|store|manage|reopen)\s+(?:records?|items?|entries|projects?)\b/i,
    /\b(?:create|edit|update|delete)\s+(?:records?|items?|entries|projects?)\b/i,
  ],
  payments: [/\b(?:payments?|billing|checkout|paid plans?|subscriptions?|stripe)\b/i],
  file_uploads: [/\b(?:file|image|document|asset)s?\s+(?:upload|import)s?\b/i, /\bupload(?:ing|s|ed)?\b/i],
  custom_logic: [
    /\b(?:calculat(?:e|es|ed|ing|ion)|formula|derive|transform|optimise|optimize|algorithm)\b/i,
    /\b(?:custom|business)\s+(?:logic|rules?|calculation)s?\b/i,
    /\b(?:generate|allocate|balance)\s+(?:a |an |the )?(?:result|plan|layout|schedule|route|data)\b/i,
  ],
  interactive_workspace: [
    /\b(?:interactive\s+workspace|canvas|drag[ -]?(?:and[ -]?)?drop|diagram|visual editor)\b/i,
    /\b(?:move|resize|position|select)\s+(?:items?|objects?|nodes?|elements?)\b/i,
  ],
  realtime: [/\b(?:real[ -]?time|live collaboration|presence|websockets?)\b/i],
  admin: [/\b(?:admin(?:istration)?|back[ -]?office|moderation)\s+(?:area|panel|dashboard|tools?)\b/i],
  export: [/\b(?:export|download)(?:ing|s|ed)?\b/i, /\b(?:pdf|csv|xlsx|spreadsheet)\s+(?:export|download|file)\b/i],
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function has(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function withoutNegatedRequirements(value) {
  return String(value || "").replace(
    /\b(?:no|without|not requiring|does not require|do not require|not needed|are not required)\b[^.!?;\n]{0,64}\b(?:user accounts?|auth(?:entication)?|sign[ -]?in|log[ -]?in|saved data|database|persistence|payments?|billing|checkout|subscriptions?|file uploads?|real[ -]?time|admin(?:istration)?|exports?|downloads?)\b/gi,
    "",
  );
}

function profileError(field, value, allowed = null) {
  const error = new TypeError(`Invalid Builder V2 build profile field ${field}${allowed ? `; expected one of ${allowed.join(", ")}` : ""}.`);
  error.code = "invalid_build_profile";
  error.field = field;
  error.value = value;
  return error;
}

/** Strict browser/API boundary validation. It intentionally does not accept capabilities. */
export function validateBuildProfileInput(input) {
  if (input == null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw profileError("buildProfile", input);
  for (const key of Object.keys(input)) {
    if (!PROFILE_KEYS.has(key)) throw profileError(key, input[key]);
  }
  if (input.version != null && Number(input.version) !== BUILD_PROFILE_VERSION) {
    throw profileError("version", input.version, [BUILD_PROFILE_VERSION]);
  }
  const requested = input.requestedBuildType ?? "auto";
  if (!BUILD_TYPES.includes(requested)) throw profileError("requestedBuildType", requested, BUILD_TYPES);
  if (input.resolvedBuildType != null && !BUILD_TYPES.includes(input.resolvedBuildType)) {
    throw profileError("resolvedBuildType", input.resolvedBuildType, BUILD_TYPES);
  }
  const subtype = input.applicationSubtype ?? "auto";
  if (!APPLICATION_SUBTYPES.includes(subtype)) {
    throw profileError("applicationSubtype", subtype, APPLICATION_SUBTYPES);
  }
  if (input.inferenceSource != null && !INFERENCE_SOURCES.includes(input.inferenceSource)) {
    throw profileError("inferenceSource", input.inferenceSource, INFERENCE_SOURCES);
  }
  if (input.confidence != null && (!Number.isFinite(Number(input.confidence))
    || Number(input.confidence) < 0 || Number(input.confidence) > 1)) {
    throw profileError("confidence", input.confidence);
  }
  if (input.requirementSignals != null && !Array.isArray(input.requirementSignals)) {
    throw profileError("requirementSignals", input.requirementSignals, REQUIREMENT_SIGNALS);
  }
  for (const signal of input.requirementSignals || []) {
    if (!REQUIREMENT_SIGNALS.includes(signal)) throw profileError("requirementSignals", signal, REQUIREMENT_SIGNALS);
  }
  return input;
}

export function inferRequirementSignals(prompt = "") {
  const text = withoutNegatedRequirements(prompt);
  return REQUIREMENT_SIGNALS.filter((signal) => has(SIGNAL_PATTERNS[signal] || [], text));
}

export function inferBuildType(prompt = "", signals = inferRequirementSignals(prompt)) {
  const text = String(prompt || "");
  const websiteScore = WEBSITE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const applicationScore = APPLICATION_PATTERNS.filter((pattern) => pattern.test(text)).length
    + signals.filter((signal) => [
      "user_accounts", "saved_data", "custom_logic", "interactive_workspace", "realtime", "admin",
    ].includes(signal)).length;
  if (applicationScore > websiteScore && applicationScore > 0) {
    return { type: "application", confidence: Math.min(0.98, 0.68 + applicationScore * 0.07) };
  }
  if (websiteScore > 0) {
    return { type: "website", confidence: Math.min(0.96, 0.72 + websiteScore * 0.08) };
  }
  return { type: "auto", confidence: 0.45 };
}

/**
 * Adopt a profile that was ALREADY resolved server-side, verbatim.
 *
 * A resolved profile is a planning fact the contract was generated and validated against, so a
 * later stage reads it rather than inferring a second one. Re-resolving from the model's own
 * summary produced obligations the contract agent never saw: a request with no signal words whose
 * summary happened to say "staff log in" acquired `user_accounts` at the build gate and blocked
 * the build before generation, with nothing the model could have done to satisfy it.
 *
 * Returns null when the value is not a complete server-resolved DTO, so the caller falls back to
 * inference rather than trusting a malformed profile.
 */
export function adoptBuildProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  try { validateBuildProfileInput(profile); } catch { return null; }
  if (!BUILD_TYPES.includes(profile.resolvedBuildType)) return null;
  if (!INFERENCE_SOURCES.includes(profile.inferenceSource)) return null;
  const confidence = Number(profile.confidence);
  return Object.freeze({
    version: BUILD_PROFILE_VERSION,
    requestedBuildType: profile.requestedBuildType || "auto",
    resolvedBuildType: profile.resolvedBuildType,
    applicationSubtype: profile.resolvedBuildType === "application"
      ? (profile.applicationSubtype || "auto") : "auto",
    requirementSignals: unique(profile.requirementSignals || []),
    inferenceSource: profile.inferenceSource,
    confidence: Number((Number.isFinite(confidence) ? confidence : 1).toFixed(2)),
  });
}

/**
 * Resolve browser choices and generic prompt inference into the one persisted DTO. Server callers
 * must call this even when the browser already did: resolved type, confidence, and inferred
 * requirements are server-owned planning facts.
 */
export function resolveBuildProfile({ prompt = "", input = null, legacy = false } = {}) {
  const supplied = validateBuildProfileInput(input) || {};
  const requestedBuildType = supplied.requestedBuildType || "auto";
  const inferredSignals = inferRequirementSignals(prompt);
  const inference = inferBuildType(prompt, inferredSignals);
  const resolvedBuildType = requestedBuildType === "auto" ? inference.type : requestedBuildType;
  const applicationSubtype = resolvedBuildType === "application"
    ? (supplied.applicationSubtype || "auto")
    : "auto";
  const adjusted = supplied.inferenceSource === "adjusted";
  const subtypeSignals = applicationSubtype === "saas" ? ["user_accounts", "saved_data"] : [];
  const requirementSignals = unique(adjusted
    ? (supplied.requirementSignals || [])
    : [...inferredSignals, ...subtypeSignals, ...(supplied.requirementSignals || [])]);
  const inferenceSource = legacy ? "legacy_auto"
    : adjusted ? "adjusted"
      : requestedBuildType === "auto" ? "auto" : "explicit";
  const confidence = requestedBuildType === "auto" ? inference.confidence : 1;
  return Object.freeze({
    version: BUILD_PROFILE_VERSION,
    requestedBuildType,
    resolvedBuildType,
    applicationSubtype,
    requirementSignals,
    inferenceSource,
    confidence: Number(confidence.toFixed(2)),
  });
}

export function buildProfileInterpretation(profile) {
  if (!profile) return [];
  const labels = [TYPE_LABELS.get(profile.resolvedBuildType) || "Auto"];
  if (profile.resolvedBuildType === "application" && profile.applicationSubtype !== "auto") {
    labels.push(SUBTYPE_LABELS.get(profile.applicationSubtype));
  }
  labels.push(...(profile.requirementSignals || []).map((signal) => SIGNAL_LABELS.get(signal)).filter(Boolean));
  return labels;
}

export function buildProfileBrief(profile) {
  if (!profile) return "";
  const requirements = (profile.requirementSignals || []).map((signal) => SIGNAL_LABELS.get(signal) || signal);
  const typeGuidance = profile.resolvedBuildType === "website"
    ? "Website means content and presentation are likely dominant, while all explicitly requested forms, persistence, and integrations remain allowed."
    : profile.resolvedBuildType === "application"
      ? "Application means behavior, state, data flow, ownership, persistence, and functional journeys are first-class contract requirements."
      : "Auto means derive the product shape from the request without forcing website or application behavior.";
  const subtypeGuidance = profile.applicationSubtype === "saas"
    ? "SaaS may require account, tenant, or workspace ownership boundaries; do not invent payments or subscriptions unless separately requested or confidently supported."
    : profile.applicationSubtype !== "auto"
      ? `${SUBTYPE_LABELS.get(profile.applicationSubtype)} is context only, never a fixed scaffold or template.`
      : null;
  return [
    "AUTHORITATIVE BUILDER V2 PRODUCT PROFILE (user-adjustable intake context):",
    `- Requested build type: ${TYPE_LABELS.get(profile.requestedBuildType) || profile.requestedBuildType}`,
    `- Resolved build type: ${TYPE_LABELS.get(profile.resolvedBuildType) || profile.resolvedBuildType}`,
    `- Application subtype: ${SUBTYPE_LABELS.get(profile.applicationSubtype) || profile.applicationSubtype}`,
    `- Requirement signals: ${requirements.length ? requirements.join(", ") : "none declared"}`,
    `- Resolution source: ${profile.inferenceSource}; confidence: ${profile.confidence}`,
    typeGuidance,
    subtypeGuidance,
    ...profile.requirementSignals.map((signal) => `- ${SIGNAL_LABELS.get(signal)}: ${SIGNAL_GUIDANCE[signal]}`),
    "Use this as planning context, not as a template or permission to invent unrequested features.",
    "For an application, make behavior, state ownership, data flow, and functional journeys explicit.",
    "A requirement signal must be represented only where the request supports it. Existing capabilities do not hide novel transformations.",
  ].join("\n");
}

export function latestBuildProfile(turns = []) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const stored = turns[index]?.payload?.build_profile;
    if (!stored) continue;
    try {
      return resolveBuildProfile({ prompt: turns[index]?.content || "", input: stored });
    } catch {
      return null;
    }
  }
  return null;
}

function functionalResponsibilities(contract) {
  return (contract?.operations || []).flatMap((operation) => operation?.responsibilities || [])
    .filter((responsibility) => ["functional", "custom_functional", "capability_functional"].includes(responsibility?.type));
}

function persistenceResponsibilities(contract) {
  return (contract?.operations || []).flatMap((operation) => operation?.responsibilities || [])
    .filter((responsibility) => responsibility?.type === "persistence");
}

/** Exact deterministic contract obligations added by the authoritative intake profile. */
export function validateBuildProfileContract(contract, profile = contract?.buildProfile) {
  if (!profile || profile.inferenceSource === "legacy_auto") return { ok: true, problems: [] };
  const problems = [];
  const functions = functionalResponsibilities(contract);
  const persistence = persistenceResponsibilities(contract);
  const statefulSteps = (contract?.journeys || []).flatMap((journey) => journey?.steps || [])
    .filter((step) => (step?.operates || []).length || (step?.reads || []).length);
  if (profile.resolvedBuildType === "application" && !statefulSteps.length && !(contract?.operations || []).length) {
    problems.push("build_profile_contract_incomplete signal=application missing=behavior_or_stateful_journey");
  }
  for (const signal of profile.requirementSignals || []) {
    if (signal === "custom_logic" && !(contract?.operations || []).some((operation) =>
      (operation?.responsibilities || []).some((responsibility) => functions.includes(responsibility)
        && (responsibility.reads || []).length
        && ((responsibility.writes || []).length || functionalOutputEffect(operation, responsibility))))) {
      problems.push("build_profile_contract_incomplete signal=custom_logic missing=functional_responsibility_reads_writes");
    }
    if (signal === "saved_data" && (!persistence.length || !(contract?.entities || []).length)) {
      problems.push("build_profile_contract_incomplete signal=saved_data missing=entity_and_persistence_responsibility");
    }
    if (signal === "interactive_workspace" && !statefulSteps.length) {
      problems.push("build_profile_contract_incomplete signal=interactive_workspace missing=structured_interaction_state");
    }
    if (signal === "user_accounts" && contract?.auth?.required !== true) {
      problems.push("build_profile_contract_incomplete signal=user_accounts missing=required_auth_semantics");
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Graph-side agreement check. It does not add capabilities; it proves the semantic graph owns it. */
export function validateBuildProfileGraph(graph, profile = graph?.buildProfile) {
  if (!profile || profile.inferenceSource === "legacy_auto") return { ok: true, problems: [] };
  const problems = [];
  const responsibilities = (graph?.operationResponsibilities || [])
    .flatMap((operation) => operation?.responsibilities || []);
  const statefulFlows = (graph?.journeys || []).flatMap((journey) => journey?.dataFlows || [])
    .filter((flow) => (flow?.reads || []).length || (flow?.writes || []).length);
  if (profile.resolvedBuildType === "application" && !responsibilities.length && !statefulFlows.length) {
    problems.push("build_profile_graph_incomplete signal=application missing=semantic_responsibility_or_state_flow");
  }
  for (const signal of profile.requirementSignals || []) {
    if (signal === "custom_logic" && !responsibilities.some((item) =>
      ["custom_functional", "capability_functional"].includes(item?.type))) {
      problems.push("build_profile_graph_incomplete signal=custom_logic missing=functional_semantic_owner");
    }
    if (signal === "saved_data" && !responsibilities.some((item) => item?.type === "persistence")) {
      problems.push("build_profile_graph_incomplete signal=saved_data missing=persistence_owner");
    }
    if (signal === "interactive_workspace" && !statefulFlows.length) {
      problems.push("build_profile_graph_incomplete signal=interactive_workspace missing=interaction_state_flow");
    }
  }
  return { ok: problems.length === 0, problems };
}
