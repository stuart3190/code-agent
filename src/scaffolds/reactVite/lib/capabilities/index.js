// Capability surface for generated apps — platform infrastructure, do not edit.
//
//   import { makeEntityStore, ensureSession, ensureVisitorSession, isOwner } from "./lib/capabilities";
//
// Versions are semver majors the platform pins per project (recorded in project knowledge);
// a scaffold refresh on iterate updates these files only when the pinned major matches.

export { makeEntityStore } from "./crud.js";
export { ensureSession, ensureVisitorSession, currentUser, signOut } from "./session.js";
export { isOwner, requireOwner } from "./roles.js";
export { makeBookingSystem, BOOKING_STATUS, CREATE_RESULT } from "./booking.js";
export { makeContactForm, makeNewsletter, CONTACT_RESULT, NEWSLETTER_RESULT } from "./forms.js";

export const CAPABILITY_VERSIONS = Object.freeze({
  crud: "1.0.0",
  session: "1.0.0",
  roles: "1.0.0",
  booking: "1.0.0",
  forms: "1.0.0",
});
