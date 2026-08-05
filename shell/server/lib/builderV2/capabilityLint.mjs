// D1 capability-usage lint (master plan Part 9; built after live run 3, diag 31b97b07).
//
// The third live build failed its essential journey because generated code called
// `contactForm.submit(...)` where the contact capability exports `submitContact` — the
// method was undefined, the throw was caught into a silent error state, and the defect
// cost a full browser-verification cycle to even observe. A call to a method a capability
// does not export is DETECTABLE STATICALLY the moment patches apply; this lint fails it
// there, with the real interface in the rejection so the next round cannot miss.
//
// FACTORY_METHODS is pinned statically for byte-stable prompts and lint output; a drift
// test asserts it equals Object.keys() of what the real scaffold factories return.

export const FACTORY_METHODS = Object.freeze({
  makeEntityStore: ["list", "get", "create", "update", "remove", "count", "subscribe"],
  makeBookingSystem: ["createBooking", "getBooking", "listBookings", "cancelBooking", "remaining"],
  makeContactForm: ["submitContact"],
  makeNewsletter: ["subscribe"],
});

// Non-method properties an instance legitimately exposes (enums; never called).
const FACTORY_PROPERTIES = Object.freeze({
  makeBookingSystem: ["BOOKING_STATUS", "CREATE_RESULT"],
});

const GENERATED_FILE = /^src\/.*\.(jsx?|tsx?)$/;
const PLATFORM_PATH = /^src\/lib\//;

/**
 * Scan generated files for capability-instance method calls that the capability does not
 * export. Returns { ok, problems } with teaching-quality reasons.
 */
export function lintCapabilityUsage(tree) {
  const problems = [];
  for (const [path, source] of Object.entries(tree)) {
    if (!GENERATED_FILE.test(path) || PLATFORM_PATH.test(path)) continue;
    const code = String(source);
    for (const [factory, methods] of Object.entries(FACTORY_METHODS)) {
      // Every binding of this factory's instance: const x = makeContactForm(...),
      // including through useMemo(() => makeContactForm(...)).
      const bindingRe = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=[^;\\n]*\\b${factory}\\s*\\(`, "g");
      for (const bindingMatch of code.matchAll(bindingRe)) {
        const varName = bindingMatch[1];
        const callRe = new RegExp(`\\b${varName}\\.(\\w+)\\s*\\(`, "g");
        for (const call of code.matchAll(callRe)) {
          const method = call[1];
          if (methods.includes(method)) continue;
          if ((FACTORY_PROPERTIES[factory] || []).includes(method)) continue;
          problems.push(
            `${path}: ${varName}.${method}(...) does not exist — ${factory}() exposes exactly `
            + `[${methods.join(", ")}]. Call the real method; do not reimplement the capability.`,
          );
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
