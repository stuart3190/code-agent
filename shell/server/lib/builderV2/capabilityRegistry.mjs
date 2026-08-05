// Capability Registry (finish plan WP-4; master plan Part 6).
//
// The platform's authoritative list of what generated apps may bind: name, version, the
// exported interface the builder codes against, the scaffold package that implements it,
// the entity types it owns, and the UI CONTRACT — the states a screen using it MUST render
// (enforced later by the D1 capability-contract lint). Capabilities are headless by law:
// functions and state enums only, no JSX, no styles — visual identity belongs to the design
// system, which is how two sites sharing every capability still look nothing alike.

export const CAPABILITIES = Object.freeze({
  crud: {
    name: "crud",
    version: "1.0.0",
    package: "src/lib/capabilities/crud.js",
    interface: ["makeEntityStore"],
    storeInterface: ["list", "get", "create", "update", "remove", "count", "subscribe"],
    entities: [],            // generic — binds to whatever the contract declares
    uiContract: [],
    upgradePolicy: "replace-on-iterate",
  },
  session: {
    name: "session",
    version: "1.0.0",
    package: "src/lib/capabilities/session.js",
    interface: ["ensureSession", "ensureVisitorSession", "currentUser", "signOut"],
    entities: [],
    uiContract: [],
    upgradePolicy: "replace-on-iterate",
  },
  roles: {
    name: "roles",
    version: "1.0.0",
    package: "src/lib/capabilities/roles.js",
    interface: ["isOwner", "requireOwner"],
    entities: [],
    uiContract: [],
    upgradePolicy: "replace-on-iterate",
  },
  booking: {
    name: "booking", version: "1.0.0", package: "src/lib/capabilities/booking.js",
    interface: ["makeBookingSystem"],
    systemInterface: ["createBooking", "getBooking", "listBookings", "cancelBooking", "remaining"],
    entities: ["booking"],
    // The states a booking UI MUST render — the exact behaviours the 32.65-credit run lacked.
    uiContract: ["idle", "invalid", "over_capacity", "confirmed_with_reference", "cancel_confirm_prompt", "cancelled"],
    upgradePolicy: "replace-on-iterate",
  },
  contact: {
    name: "contact", version: "1.0.0", package: "src/lib/capabilities/forms.js",
    interface: ["makeContactForm"], entities: ["contactMessage"],
    uiContract: ["idle", "invalid", "sent"], upgradePolicy: "replace-on-iterate",
  },
  newsletter: {
    name: "newsletter", version: "1.0.0", package: "src/lib/capabilities/forms.js",
    interface: ["makeNewsletter"], entities: ["newsletterSignup"],
    uiContract: ["idle", "invalid", "success", "duplicate"], upgradePolicy: "replace-on-iterate",
  },
});

/** Validate a contract's capability bindings against the registry. */
export function validateBindings(bindings = []) {
  const problems = [];
  for (const binding of bindings) {
    const entry = CAPABILITIES[binding.name];
    if (!entry) { problems.push(`unknown capability "${binding.name}"`); continue; }
    const wantedMajor = String(binding.version || entry.version).split(".")[0];
    const haveMajor = entry.version.split(".")[0];
    if (wantedMajor !== haveMajor) {
      problems.push(`capability "${binding.name}" wants major ${wantedMajor}, platform ships ${entry.version}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The interface brief a build prompt carries — small, byte-stable, sorted. */
export function capabilityBrief(names = Object.keys(CAPABILITIES)) {
  const lines = ["CAPABILITIES (import from ./lib/capabilities — never reimplement):"];
  for (const name of [...names].sort()) {
    const entry = CAPABILITIES[name];
    if (!entry) continue;
    lines.push(`  ${entry.name}@${entry.version}: ${entry.interface.join(", ")}`);
    if (entry.uiContract.length) lines.push(`    UI must render states: ${entry.uiContract.join(", ")}`);
  }
  return lines.join("\n");
}
