// Typed operation ownership and platform values (audit §8, §12; WP2).
//
// A contract used to describe platform infrastructure in domain vocabulary: a `session` or
// `authSession` entity holding credentials, a sign-in "created" through CRUD, a role field on a
// generic record standing in for authority. Every one of those was a real product defect in the
// retained corpus. This module gives the contract explicit types instead:
//
//   - every operation carries `owner: "module" | "generated"`, and a module-owned operation names
//     the module and operation that implement it;
//   - every operation carries `output: { type }` from the platform value vocabulary — session,
//     entity, collection, transient_result, artifact, job, external_effect — so a session is never
//     a record and an export is never an entity;
//   - platform infrastructure the contract needs (identity, accounts, payments, uploads, realtime,
//     admin, exports) is declared under `ownership.platformRequirements`, where the compiler can
//     resolve or refuse it, instead of leaking into generation scope;
//   - session-shaped entities and credential-shaped fields are removed from the domain schema.
//
// The normalisation is VERSIONED and REVERSIBLE: `ownership.normalizedFrom` records the contract
// version it started from, every removed entity and every retargeted operation is preserved
// verbatim, and a contract already at the current ownership version is returned unchanged.
// Nothing here consults prose; the rules key on structured kinds, reserved names and declared
// responsibilities. Shared between server and web deliberately, like the contract itself.

export const OWNERSHIP_VERSION = 1;

export const PLATFORM_VALUE_TYPES = Object.freeze([
  "session", "entity", "collection", "transient_result", "artifact", "job", "external_effect",
]);
export const OPERATION_OWNERS = Object.freeze(["module", "generated"]);

/** Reserved names that denote the platform session, never a domain record. */
export const SESSION_ENTITY_NAME = /^(?:auth[-_ ]?session|session|app[-_ ]?session|user[-_ ]?session|login[-_ ]?session|authentication|auth|credentials?|login|sign[-_ ]?in|current[-_ ]?user)s?$/i;
/**
 * Account-shaped names: the platform's own account concept spelled as an entity. Deliberately
 * narrow — a Member, Customer, Employee or Technician is a domain record that may reference a
 * principal; it does not become an account merely because it has an email (audit §8). A bare
 * `user` entity counts only when it carries platform account facts (see isAccountEntity).
 */
export const ACCOUNT_ENTITY_NAME = /^(?:app[-_ ]?user|user[-_ ]?profile|user[-_ ]?account|platform[-_ ]?user|auth[-_ ]?user|login[-_ ]?user|app[-_ ]?account)s?$/i;
const BARE_USER_ENTITY = /^users?$/i;
/** Fields that are credentials or session tokens: operation inputs with special sensitivity, never schema. */
export const CREDENTIAL_FIELD_NAME = /^(?:auth[-_ ]?password|password(?:[-_ ]?hash)?|passcode|auth[-_ ]?token|session[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|reset[-_ ]?token|token|secret|api[-_ ]?key)$/i;
const SESSION_STATE_FIELD = /^(?:auth[-_ ]?email|signed[-_ ]?in|is[-_ ]?signed[-_ ]?in|logged[-_ ]?in|is[-_ ]?logged[-_ ]?in|authenticated|is[-_ ]?authenticated|session[-_ ]?id|user[-_ ]?id|current[-_ ]?user(?:[-_ ]?id)?)$/i;

const SESSION_METHOD_BY_VOCABULARY = [
  [/^(?:confirm[-_ ]?reset|reset[-_ ]?confirm|confirm[-_ ]?password[-_ ]?reset)$/i, "confirmReset"],
  [/^(?:reset[-_ ]?password|password[-_ ]?reset|forgot[-_ ]?password|request[-_ ]?reset|reset)$/i, "resetPassword"],
  [/^(?:sign[-_ ]?out|log[-_ ]?out|logout|sign[-_ ]?out[-_ ]?user|end[-_ ]?session)$/i, "signOut"],
  [/^(?:sign[-_ ]?up|register|create[-_ ]?account|registration)$/i, "signUp"],
  [/^(?:sign[-_ ]?in|log[-_ ]?in|login|authenticate(?:[-_ ]?user)?|authentication|auth)$/i, "signIn"],
];
const SESSION_METHODS = new Set(["ensure", "recover", "current", "signUp", "signIn", "signOut", "resetPassword", "confirmReset"]);
const CAPABILITY_MODULES = Object.freeze({
  crud: "thrallo.entities", session: "thrallo.identity", auth: "thrallo.identity", roles: "thrallo.authorization",
  booking: "thrallo.booking", wizard: "thrallo.workflow", contact: "thrallo.contact", newsletter: "thrallo.newsletter",
  "interaction-primitives": "thrallo.forms",
  accounts: "thrallo.accounts", authorization: "thrallo.authorization", admin: "thrallo.admin",
});
// Fields of an account-shaped entity that are platform membership facts, never profile data.
const PLATFORM_ACCOUNT_FIELD = /^(?:id|user[-_ ]?id|auth[-_ ]?user[-_ ]?id|email|user[-_ ]?email|role|roles|status|account[-_ ]?status|created[-_ ]?at|updated[-_ ]?at|last[-_ ]?login|invited(?:[-_ ]?at)?)$/i;
const ROLE_FIELD = /^roles?$/i;
const STATUS_FIELD = /^(?:status|account[-_ ]?status)$/i;
const ACCOUNT_STORAGE_NOTE = "platform-managed account membership through the accounts service; not an application record";
const CRUD_METHOD_BY_KIND = Object.freeze({
  create: "create", insert: "create", add: "create",
  read: "get", get: "get", find: "get", lookup: "get", view: "get", fetch: "get",
  list: "list", search: "list", query: "list",
  update: "update", edit: "update",
  delete: "remove", remove: "remove", destroy: "remove",
});
const COLLECTION_KINDS = new Set(["list", "search", "query"]);
const ARTIFACT_KINDS = new Set(["export", "download", "print"]);
const READ_KINDS = new Set(["read", "get", "find", "lookup", "view", "fetch"]);
const MUTATION_KINDS = new Set(["create", "insert", "add", "update", "edit"]);
const REMOVAL_KINDS = new Set(["delete", "remove", "destroy"]);
const TRANSIENT_STORAGE = /\b(?:client(?:-only| side| session)?|browser(?:-only| session)?|session(?:-only| local)?|in[- ]?memory|local in-app|local state|ephemeral|transient|current (?:browser )?session|not (?:saved|stored|persisted)|no backend)\b/i;

/**
 * How unresolved platform requirements are treated. `block` fails the contract before generation
 * (audit §11: never replace requested infrastructure with generated code); `warn` records the gap
 * while the owning work package is still to land. Each later package flips its own row.
 */
export const PLATFORM_REQUIREMENT_ENFORCEMENT = Object.freeze({
  identity: "block",      // WP3 — module exists (thrallo.identity)
  accounts: "block",      // WP4 — module exists (thrallo.accounts); availability decides
  authorization: "block", // WP4 — module exists (thrallo.authorization)
  admin: "block",         // WP4 — module exists (thrallo.admin); availability decides
  entities: "block",      // WP5 — module exists (thrallo.entities)
  file_uploads: "warn",   // WP10
  realtime: "warn",       // WP10
  exports: "warn",        // WP11
  payments: "warn",       // WP12
});

const lower = (value) => String(value || "").trim().toLowerCase();
const kindOf = (operation) => lower(operation?.kind || operation?.type || operation?.action || operation?.id || operation?.name)
  .split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
const idOf = (operation) => String(operation?.id || operation?.name || "").trim();
// Arrays of objects and arrays of names both pass through here unchanged: callers stringify a
// name where they compare it, never the whole element.
const listOf = (value) => (Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "") : []);
const isTransientEntity = (entity) => TRANSIENT_STORAGE.test([entity?.storage, entity?.persistence, entity?.durability]
  .filter(Boolean).join(" ").replace(/_+/g, " ")) || entity?.transient === true;

function sessionMethodFor(operation) {
  for (const responsibility of listOf(operation?.responsibilities)) {
    const capability = lower(responsibility?.capability || responsibility?.capabilityId);
    if (capability === "session" || capability === "auth") {
      const method = responsibility?.capabilityMethod || responsibility?.method || responsibility?.operation;
      if (SESSION_METHODS.has(method)) return method;
    }
  }
  for (const candidate of [operation?.kind, operation?.action, operation?.method, idOf(operation)]) {
    const text = String(candidate || "").trim();
    if (!text) continue;
    if (SESSION_METHODS.has(text)) return text;
    for (const [pattern, method] of SESSION_METHOD_BY_VOCABULARY) if (pattern.test(text)) return method;
  }
  return null;
}

function isSessionEntity(entity) {
  if (SESSION_ENTITY_NAME.test(String(entity?.name || ""))) return true;
  const fields = listOf(entity?.fields).map((field) => String(field?.name || field));
  // An entity whose fields are only credentials and session flags is the session by another name.
  return fields.length > 0 && fields.every((name) => CREDENTIAL_FIELD_NAME.test(name) || SESSION_STATE_FIELD.test(name) || /^(?:email|user[-_ ]?email)$/i.test(name))
    && fields.some((name) => CREDENTIAL_FIELD_NAME.test(name) || SESSION_STATE_FIELD.test(name));
}

function moduleForResponsibility(responsibility) {
  const capability = lower(responsibility?.capability || responsibility?.capabilityId);
  if (responsibility?.type === "persistence") return CAPABILITY_MODULES[capability] || "thrallo.entities";
  return CAPABILITY_MODULES[capability] || null;
}

function outputTypeFor(operation, { sessionMethod, transientEntity }) {
  if (sessionMethod) return "session";
  const kind = kindOf(operation);
  if (ARTIFACT_KINDS.has(kind)) return "artifact";
  if (COLLECTION_KINDS.has(kind)) return "collection";
  if (READ_KINDS.has(kind)) return operation?.entity && !transientEntity ? "entity" : "transient_result";
  if (MUTATION_KINDS.has(kind)) return operation?.entity && !transientEntity ? "entity" : "transient_result";
  if (REMOVAL_KINDS.has(kind)) return "transient_result";
  return "transient_result";
}

/**
 * Normalise a contract's ownership. Idempotent: a contract already at OWNERSHIP_VERSION is
 * returned as-is. The returned `report` equals the contract's `ownership` section.
 */
export function normalizeContractOwnership(contract, { buildProfile = null } = {}) {
  if (!contract || typeof contract !== "object") return { contract, report: null, changed: false };
  if (contract.ownership?.version === OWNERSHIP_VERSION) return { contract, report: contract.ownership, changed: false };

  const removedEntities = [];
  const strippedFields = [];
  const warnings = [];
  const accountCandidates = [];
  const accountEntities = [];
  const profileSchema = [];
  const entities = [];
  for (const entity of listOf(contract.entities)) {
    if (isSessionEntity(entity)) { removedEntities.push(entity); continue; }
    const fields = listOf(entity.fields);
    const kept = fields.filter((field) => {
      const name = String(field?.name || field);
      if (CREDENTIAL_FIELD_NAME.test(name)) {
        strippedFields.push({ entity: entity.name, field: field?.name ? field : { name } });
        return false;
      }
      return true;
    });
    const bareUserWithAccountFacts = BARE_USER_ENTITY.test(String(entity.name || ""))
      && kept.some((field) => ROLE_FIELD.test(String(field?.name || field)) || STATUS_FIELD.test(String(field?.name || field)))
      && kept.some((field) => /^(?:email|user[-_ ]?email)$/i.test(String(field?.name || field)));
    if ((ACCOUNT_ENTITY_NAME.test(String(entity.name || "")) || bareUserWithAccountFacts) && entity.platform !== "accounts") {
      // WP4: an account-shaped entity is the platform's membership, kept declared (its fields
      // remain the contract's vocabulary for controls and reads) but never an application
      // record: no entity store is composed for it, and its operations bind to the accounts
      // and admin modules below. Non-platform fields become the self-editable profile schema.
      accountCandidates.push(entity.name);
      accountEntities.push({ name: entity.name, original: JSON.parse(JSON.stringify(entity)) });
      for (const field of kept) {
        const name = String(field?.name || field);
        if (!PLATFORM_ACCOUNT_FIELD.test(name) && !profileSchema.some((row) => row.name === name)) {
          profileSchema.push(field?.name ? { ...field } : { name });
        }
      }
      entities.push({ ...entity, fields: kept, platform: "accounts", owned: false, storage: ACCOUNT_STORAGE_NOTE });
      continue;
    }
    if (entity.platform === "accounts") accountCandidates.push(entity.name);
    entities.push(kept.length === fields.length ? entity : { ...entity, fields: kept });
  }
  const accountNames = new Set(entities.filter((entity) => entity.platform === "accounts").map((entity) => lower(entity.name)));
  const hasAdminVocabulary = listOf(contract.auth?.roles).some((role) => /admin|owner|manager/i.test(String(role)))
    || listOf(buildProfile?.requirementSignals || contract.buildProfile?.requirementSignals).includes("admin");

  /** Bind an operation on the platform account entity to the accounts/admin module operation it means. */
  const accountRetarget = (operation) => {
    const kind = kindOf(operation);
    const declaredWrites = listOf(operation.responsibilities).flatMap((row) => listOf(row?.writes)).map((field) => String(field).split(".").pop());
    const declaredReads = listOf(operation.responsibilities).flatMap((row) => listOf(row?.reads)).map((field) => String(field).split(".").pop());
    const target = (capability, method, reads) => ({ capability, method, reads });
    if (MUTATION_KINDS.has(kind) && kind !== "update" && kind !== "edit") return target("admin", "inviteMember", ["email", "role"]);
    if (kind === "update" || kind === "edit") {
      if (declaredWrites.some((field) => ROLE_FIELD.test(field))) return target("admin", "setMemberRole", ["email", "role"]);
      if (declaredWrites.some((field) => STATUS_FIELD.test(field))) return target("admin", "setMemberStatus", ["email", "status"]);
      return target("accounts", "updateMe", declaredReads.length ? declaredReads : ["values"]);
    }
    if (REMOVAL_KINDS.has(kind)) return target("admin", "setMemberStatus", ["email", "status"]);
    if (COLLECTION_KINDS.has(kind)) return target("admin", "listMembers", []);
    if (READ_KINDS.has(kind)) return target("accounts", "getMember", ["email"]);
    return null;
  };
  const removedNames = new Set(removedEntities.map((entity) => lower(entity.name)));
  const removedFieldNames = new Set(removedEntities.flatMap((entity) => listOf(entity.fields).map((field) => lower(field?.name || field))));
  const transientNames = new Set(entities.filter(isTransientEntity).map((entity) => lower(entity.name)));

  const retargetedOperations = [];
  const moduleBindings = [];
  const operations = listOf(contract.operations).map((operation) => {
    const sessionMethod = sessionMethodFor(operation);
    const entityRemoved = removedNames.has(lower(operation?.entity));
    let next = { ...operation };
    let responsibilities = listOf(operation.responsibilities).map((responsibility) => ({ ...responsibility }));
    if (sessionMethod) {
      const original = JSON.parse(JSON.stringify(operation));
      // The session responsibility: an existing one bound to session/auth, or the responsibility
      // that was standing in for it (no registered capability, writing session-shaped state).
      const index = responsibilities.findIndex((responsibility) => ["session", "auth"].includes(lower(responsibility?.capability || responsibility?.capabilityId)));
      const standIn = index === -1 ? responsibilities.findIndex((responsibility) => !responsibility?.capability && !responsibility?.capabilityId
        && (entityRemoved || listOf(responsibility?.writes).every((field) => removedFieldNames.has(lower(String(field).split(".").pop())) || SESSION_STATE_FIELD.test(String(field).split(".").pop())))) : -1;
      const credentialReads = sessionMethod === "signOut" ? []
        : sessionMethod === "resetPassword" ? ["authEmail"]
          : sessionMethod === "confirmReset" ? ["authEmail"]
            : ["authEmail", "authPassword"];
      // An explicitly session-bound responsibility keeps its declared type and reads (a contract
      // may legitimately read a domain field beside the credentials); only its capability id is
      // canonicalised and its writes cleared, because a session operation stores no record. A
      // stand-in (no capability, session-shaped writes) becomes the canonical functional form.
      const sessionResponsibility = index >= 0
        ? { ...responsibilities[index], capability: "session", capabilityMethod: sessionMethod, writes: [] }
        : {
          type: "functional", capability: "session", capabilityMethod: sessionMethod,
          behavior: responsibilities[standIn]?.behavior
            || (sessionMethod === "signOut" ? "end the platform session" : "establish the platform session"),
          reads: credentialReads, writes: [],
        };
      if (index >= 0) responsibilities[index] = sessionResponsibility;
      else if (standIn >= 0) responsibilities[standIn] = sessionResponsibility;
      else responsibilities.unshift(sessionResponsibility);
      // No other responsibility may write session state or credential fields.
      responsibilities = responsibilities.map((responsibility) => responsibility === sessionResponsibility ? responsibility : {
        ...responsibility,
        reads: listOf(responsibility.reads).filter((field) => !CREDENTIAL_FIELD_NAME.test(String(field).split(".").pop())),
        writes: listOf(responsibility.writes).filter((field) => !removedFieldNames.has(lower(String(field).split(".").pop()))
          && !SESSION_STATE_FIELD.test(String(field).split(".").pop()) && !CREDENTIAL_FIELD_NAME.test(String(field).split(".").pop())),
      });
      // The structured kind becomes the session method only when the operation had no domain
      // entity (or its entity was the removed session). A sign-in that also reads the caller's
      // records ("sign in and load my plans") keeps its declared read kind on that entity, so
      // route resolution and generation scope for that journey are unchanged; its ownership and
      // platform value are typed below regardless.
      const rebindKind = entityRemoved || !next.entity;
      next = {
        ...next, ...(rebindKind ? { kind: sessionMethod } : {}), responsibilities,
        ...(rebindKind ? { entity: undefined } : {}),
      };
      if (next.entity === undefined) delete next.entity;
      retargetedOperations.push({ id: idOf(operation), reason: "platform_session", from: original,
        to: { kind: sessionMethod, entity: next.entity || null, module: "thrallo.identity", operation: sessionMethod } });
    } else if (entityRemoved) {
      // A non-session operation on a removed session entity cannot stand; leave it generated and
      // say so, rather than silently binding it to a record that does not exist.
      warnings.push(`operation ${idOf(operation)} targets the removed platform entity ${operation.entity}`);
      next = { ...next, entity: undefined };
      delete next.entity;
    } else if (accountNames.has(lower(operation?.entity)) && !listOf(operation.responsibilities).some((row) => ["accounts", "admin", "authorization"].includes(lower(row?.capability || row?.capabilityId)))) {
      // WP4: generic CRUD on the account entity becomes the module command it means — invite,
      // role change, suspension, profile update, member lookup — enforced by the accounts service.
      const retarget = accountRetarget(operation);
      if (retarget) {
        const original = JSON.parse(JSON.stringify(operation));
        const previous = responsibilities.find((row) => row?.type === "persistence") || responsibilities[0] || {};
        // A generated transformation that only fabricates platform account facts (an authUserId
        // "derived from the email", a status, a role) is exactly what the accounts service owns;
        // it is dropped and recorded, never kept as generation scope.
        const fabricated = responsibilities.filter((row) => row !== previous && row?.type !== "persistence"
          && listOf(row?.writes).length > 0
          && listOf(row.writes).every((field) => PLATFORM_ACCOUNT_FIELD.test(String(field).split(".").pop())));
        responsibilities = [
          { type: "functional", capability: retarget.capability, capabilityMethod: retarget.method,
            behavior: previous?.behavior || operation.description || `${retarget.method} through the accounts service`,
            reads: retarget.reads, writes: [] },
          ...responsibilities.filter((row) => row !== previous && row?.type !== "persistence" && !fabricated.includes(row)),
        ];
        next = { ...next, responsibilities };
        retargetedOperations.push({ id: idOf(operation), reason: "platform_accounts", from: original,
          to: { kind: next.kind, entity: next.entity || null, module: CAPABILITY_MODULES[retarget.capability], operation: retarget.method },
          ...(fabricated.length ? { droppedResponsibilities: fabricated } : {}) });
      }
    }
    // Strip credential fields from every responsibility's writes and from any operation's inputs.
    responsibilities = responsibilities.map((responsibility) => ({
      ...responsibility,
      writes: listOf(responsibility.writes).filter((field) => !CREDENTIAL_FIELD_NAME.test(String(field).split(".").pop())),
    }));
    next.responsibilities = responsibilities;
    if (!Array.isArray(operation.responsibilities) && !responsibilities.length) delete next.responsibilities;

    // Ownership: module-owned when every responsibility maps to a registered module; generated
    // when any responsibility is a custom transformation. A bare persistence kind on a durable
    // entity is module-owned CRUD, exactly as the capability graph derives it.
    const transientEntity = transientNames.has(lower(next.entity));
    const kind = kindOf(next);
    const bindings = [];
    let generated = false;
    if (responsibilities.length) {
      for (const [responsibilityIndex, responsibility] of responsibilities.entries()) {
        const module = moduleForResponsibility(responsibility);
        const isPersistence = responsibility?.type === "persistence";
        const requested = responsibility?.capabilityMethod || responsibility?.method || responsibility?.operation || null;
        // Persistence names a CRUD verb in contract vocabulary ("delete", "read"); the module
        // operation is the registered one ("remove", "get"), exactly as the graph maps it.
        const method = isPersistence
          ? (module === "thrallo.entities" ? (CRUD_METHOD_BY_KIND[lower(requested)] || CRUD_METHOD_BY_KIND[kind] || requested || null)
            : (requested || CRUD_METHOD_BY_KIND[kind] || null))
          : requested;
        if (module && (isPersistence || method)) bindings.push({ responsibility: responsibilityIndex, module, operation: method });
        else generated = true;
      }
    } else if (sessionMethod) {
      bindings.push({ responsibility: 0, module: "thrallo.identity", operation: sessionMethod });
    } else if (next.entity && !transientEntity && CRUD_METHOD_BY_KIND[kind]) {
      bindings.push({ responsibility: null, module: "thrallo.entities", operation: CRUD_METHOD_BY_KIND[kind] });
    } else {
      generated = true;
    }
    const owner = generated || !bindings.length ? "generated" : "module";
    const primary = bindings.find((binding) => binding.module === "thrallo.identity") || bindings[0] || null;
    const output = { type: outputTypeFor(next, { sessionMethod, transientEntity }) };
    for (const binding of bindings) moduleBindings.push({ operationId: idOf(next), ...binding });
    return {
      ...next, owner,
      ...(owner === "module" ? { module: primary.module, moduleOperation: primary.operation } : {}),
      ...(owner === "generated" && bindings.length ? { moduleBindings: bindings } : {}),
      output,
    };
  });

  // Platform requirements: what the contract needs from infrastructure, resolved or not.
  const signals = new Set(listOf(buildProfile?.requirementSignals || contract.buildProfile?.requirementSignals));
  const platformRequirements = [];
  const usesIdentity = contract.auth?.required === true || operations.some((operation) => operation.module === "thrallo.identity");
  if (usesIdentity) {
    platformRequirements.push({ type: "identity", module: "thrallo.identity", status: "resolved",
      source: contract.auth?.required === true ? "auth.required" : "session_operation" });
  }
  if (operations.some((operation) => operation.module === "thrallo.entities" || (operation.moduleBindings || []).some((binding) => binding.module === "thrallo.entities"))) {
    platformRequirements.push({ type: "entities", module: "thrallo.entities", status: "resolved", source: "durable_operations" });
  }
  const usesAdminModule = operations.some((operation) => operation.module === "thrallo.admin"
    || (operation.moduleBindings || []).some((binding) => binding.module === "thrallo.admin"));
  const usesAccountsModule = operations.some((operation) => operation.module === "thrallo.accounts"
    || (operation.moduleBindings || []).some((binding) => binding.module === "thrallo.accounts"));
  const roles = listOf(contract.auth?.roles);
  if (accountCandidates.length || usesAccountsModule || usesAdminModule || roles.length) {
    platformRequirements.push({ type: "accounts", module: "thrallo.accounts", status: "resolved",
      source: accountCandidates.length ? `entity:${accountCandidates[0]}` : roles.length ? "auth.roles" : "account_operations",
      entities: [...accountCandidates], profileFields: profileSchema.map((field) => field.name) });
  }
  if (roles.length || signals.has("admin") || usesAdminModule) {
    platformRequirements.push({ type: "authorization", module: "thrallo.authorization", status: "resolved",
      source: roles.length ? "auth.roles" : usesAdminModule ? "account_operations" : "signal:admin", roles });
  }
  if (signals.has("admin") || usesAdminModule || hasAdminVocabulary) {
    platformRequirements.push({ type: "admin", module: "thrallo.admin", status: "resolved",
      source: usesAdminModule ? "account_operations" : signals.has("admin") ? "signal:admin" : "auth.roles" });
  }
  for (const [signal, type] of [["payments", "payments"], ["file_uploads", "file_uploads"], ["realtime", "realtime"], ["export", "exports"]]) {
    if (signals.has(signal)) platformRequirements.push({ type, module: null, status: "unresolved", source: `signal:${signal}` });
  }
  if (!signals.has("export") && operations.some((operation) => operation.output?.type === "artifact")) {
    platformRequirements.push({ type: "exports", module: null, status: "unresolved", source: "artifact_operations" });
  }
  for (const requirement of platformRequirements) {
    requirement.enforcement = PLATFORM_REQUIREMENT_ENFORCEMENT[requirement.type] || "warn";
  }

  // A contract that declared the platform session as an entity was asking for platform
  // authentication; with the entity gone, the reserved credential controls stay addressable
  // only through auth.required, so it is set (and the inference recorded) rather than lost.
  const auth = removedEntities.length && contract.auth?.required !== true
    ? { ...(contract.auth || {}), required: true, rules: listOf(contract.auth?.rules), inferredFrom: "session_entity" }
    : contract.auth;

  const ownership = {
    version: OWNERSHIP_VERSION,
    normalizedFrom: contract.version ?? null,
    platformRequirements,
    moduleBindings,
    removedEntities,
    retargetedOperations,
    strippedFields,
    accountEntities,
    profileSchema,
    warnings,
  };
  return { contract: { ...contract, ...(auth !== contract.auth ? { auth } : {}), entities, operations, ownership }, report: ownership, changed: true };
}

/** Problems a typed contract raises before generation: blocked requirements and malformed types. */
export function ownershipProblems(contract) {
  const problems = [];
  const ownership = contract?.ownership;
  if (!ownership) return problems;
  for (const requirement of ownership.platformRequirements || []) {
    if (requirement.status !== "resolved" && requirement.enforcement === "block") {
      problems.push(`platform requirement ${requirement.type} (${requirement.source}) has no qualified module on this platform`);
    }
  }
  for (const operation of contract.operations || []) {
    if (!OPERATION_OWNERS.includes(operation.owner)) problems.push(`operation ${idOf(operation)} has no owner`);
    if (!PLATFORM_VALUE_TYPES.includes(operation.output?.type)) problems.push(`operation ${idOf(operation)} has no platform value type`);
    if (operation.owner === "module" && (!operation.module || !operation.moduleOperation)) {
      problems.push(`operation ${idOf(operation)} is module-owned but names no module operation`);
    }
  }
  return problems;
}

/** Warnings worth surfacing without blocking: unresolved requirements under warn enforcement. */
export function ownershipWarnings(contract) {
  const ownership = contract?.ownership;
  if (!ownership) return [];
  return [
    ...(ownership.platformRequirements || []).filter((requirement) => requirement.status !== "resolved" && requirement.enforcement !== "block")
      .map((requirement) => `platform requirement ${requirement.type} (${requirement.source}) is not yet module-owned`),
    ...(ownership.warnings || []),
  ];
}

/** The operations a module owns outright — never generation scope. */
export function moduleOwnedOperations(contract) {
  return (contract?.operations || []).filter((operation) => operation.owner === "module");
}

export function generatedOperations(contract) {
  return (contract?.operations || []).filter((operation) => operation.owner === "generated");
}
