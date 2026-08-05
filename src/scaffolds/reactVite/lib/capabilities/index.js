// Capability surface for generated apps — platform infrastructure, do not edit.
//
//   import { makeEntityStore, ensureSession, ensureVisitorSession, isOwner } from "./lib/capabilities";
//
// Versions are semver majors the platform pins per project (recorded in project knowledge);
// a scaffold refresh on iterate updates these files only when the pinned major matches.

export { makeEntityStore } from "./crud";
export { ensureSession, ensureVisitorSession, currentUser, signOut } from "./session";
export { isOwner, requireOwner } from "./roles";

export const CAPABILITY_VERSIONS = Object.freeze({
  crud: "1.0.0",
  session: "1.0.0",
  roles: "1.0.0",
});
