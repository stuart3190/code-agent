// Application account policy — ONE pure evaluation shared by the server (app-accounts Edge
// Function, the shell's account service) and the client (src/lib/modules/policy.js is a
// byte-identical copy, enforced by test). No I/O, no Deno, no Node.
//
// Authority is a membership row (app_id, principal, role, status) held by the platform. A role
// field on a generated business record is never consulted here (audit §8): the generated client
// cannot grant itself anything by sending role, ownerId or appId — the server derives the actor.

export const POLICY_VERSION = 1;

export const MEMBER_STATUS = Object.freeze({ ACTIVE: "active", INVITED: "invited", SUSPENDED: "suspended" });

export const ACTIONS = Object.freeze([
  "profile.read", "profile.write", "profile.read.any", "profile.write.any",
  "members.read", "members.invite", "members.provision", "members.role", "members.status",
]);

export const MEMBER_GRANTS = Object.freeze(["profile.read", "profile.write"]);
export const ADMIN_GRANTS = Object.freeze([...ACTIONS]);
export const ADMIN_ROLE_NAME = /^(?:admin(?:istrator)?|owner|superuser|manager)s?$/i;

const unique = (values) => [...new Set((values || []).filter(Boolean).map(String))];
const lower = (value) => String(value || "").trim().toLowerCase();

/**
 * Normalise a role catalogue into a policy. Every declared role receives the member grants;
 * admin-shaped roles receive every grant unless the contract declared explicit grants.
 */
export function buildPolicy({ roles = [], grants = {}, defaultRole = null } = {}) {
  const declared = unique(roles.map(lower));
  const catalogue = declared.length ? declared : ["admin", "member"];
  const member = defaultRole ? lower(defaultRole)
    : catalogue.find((role) => !ADMIN_ROLE_NAME.test(role)) || catalogue[0];
  const table = {};
  for (const role of catalogue) {
    const explicit = grants?.[role] ? unique(grants[role]).filter((action) => ACTIONS.includes(action)) : null;
    table[role] = explicit || (ADMIN_ROLE_NAME.test(role) ? [...ADMIN_GRANTS] : [...MEMBER_GRANTS]);
    for (const base of MEMBER_GRANTS) if (!table[role].includes(base)) table[role].push(base);
  }
  if (!catalogue.some((role) => table[role].includes("members.role"))) {
    // A catalogue with no administrative role still needs one so provisioning is possible.
    table.admin = [...ADMIN_GRANTS];
    catalogue.push("admin");
  }
  return Object.freeze({
    version: POLICY_VERSION,
    roles: Object.freeze(unique(catalogue)),
    defaultRole: member,
    adminRoles: Object.freeze(unique(catalogue).filter((role) => table[role].includes("members.role"))),
    grants: Object.freeze(Object.fromEntries(Object.entries(table).map(([role, actions]) => [role, Object.freeze(unique(actions))]))),
  });
}

export const DEFAULT_POLICY = buildPolicy({ roles: ["admin", "member"] });

/** Actor shape: { userId, email, role, status } — always derived server-side from the membership. */
export function evaluate(policy, actor, action, { target = null } = {}) {
  if (!actor || !actor.userId) return Object.freeze({ allowed: false, reason: "unauthenticated" });
  if (actor.status === MEMBER_STATUS.SUSPENDED) return Object.freeze({ allowed: false, reason: "account_suspended" });
  if (actor.status === MEMBER_STATUS.INVITED) return Object.freeze({ allowed: false, reason: "account_invited" });
  if (actor.status !== MEMBER_STATUS.ACTIVE) return Object.freeze({ allowed: false, reason: "account_inactive" });
  if (!ACTIONS.includes(action)) return Object.freeze({ allowed: false, reason: "unknown_action" });
  const grants = policy?.grants?.[lower(actor.role)] || [];
  const self = target?.userId && target.userId === actor.userId;
  if (action === "profile.read" || action === "profile.write") {
    if (!target || self) return Object.freeze({ allowed: grants.includes(action), reason: grants.includes(action) ? null : "forbidden" });
    const any = `${action}.any`;
    return Object.freeze({ allowed: grants.includes(any), reason: grants.includes(any) ? null : "forbidden" });
  }
  if ((action === "members.role" || action === "members.status") && self) {
    return Object.freeze({ allowed: false, reason: "cannot_change_own_membership" });
  }
  return Object.freeze({ allowed: grants.includes(action), reason: grants.includes(action) ? null : "forbidden" });
}

export function allowedActions(policy, actor) {
  return ACTIONS.filter((action) => evaluate(policy, actor, action).allowed);
}

export function isAdminRole(policy, role) {
  return (policy?.adminRoles || []).includes(lower(role));
}
