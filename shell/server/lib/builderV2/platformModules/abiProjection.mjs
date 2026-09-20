// The public-ABI prompt projection (WP14).
//
// Generation used to be briefed with the whole capability surface: every registry entry, every
// composed interface, every extension point, whether or not this build installed it. That was the
// right call when composition was partial and the model had to be told what existed. With a
// module lock it is the wrong call twice over:
//
//   - it costs tokens on every call, for modules this application does not have; and
//   - it invites the model to reach past the facade, because it names things the facade does not
//     export. The audit's rule is that generated code imports the PUBLIC ABI and nothing deeper
//     (§14), and a brief that lists private module internals argues against that rule.
//
// This projects the one thing generation needs: what `src/lib/app` exports, grouped by the module
// that owns it, with the states a surface must render. Everything else stays machine-enforced.
//
// Old snapshots are unaffected. A build with no lock gets the legacy projection, because a tree
// composed before the facade existed cannot import from it.

// 2 since 2026-09-20: the brief now names capabilities that have no facade, and hides the composed
// modules the facades cover. Stamped into the projection so a stored build record says which of the
// two briefs generation was actually given.
export const ABI_PROJECTION_VERSION = 2;

const listOf = (value) => (Array.isArray(value) ? value : []);
const APP_FACADE = /^src\/lib\/app\//;

/**
 * Project the public ABI from a module lock and its composition plan.
 * Returns { version, modules, imports, lines, text } — `text` is what the prompt carries.
 */
export function projectPublicAbi({ moduleLock = null, compositionPlan = null, scaffoldPlan = null } = {}) {
  if (!moduleLock?.modules?.length) return null;
  // What the facade actually exports, read from the composed bytes by the composer, so the brief
  // cannot drift from the file. `owns` comes from the composed module behind each facade.
  const composedOwners = new Map(listOf(compositionPlan?.interfaces)
    .map((row) => [String(row?.module || "").split("/").pop().replace(/\.js$/, ""), row]));
  const byModule = new Map();
  for (const row of listOf(compositionPlan?.publicFacades)) {
    const owner = composedOwners.get(row.facade)
      || composedOwners.get(row.facade === "routing" ? "routes" : row.facade) || {};
    byModule.set(row.facade, {
      facade: row.facade,
      exports: listOf(row.exports).map(String),
      owns: listOf(owner.owns).map(String),
      operations: listOf(owner.operations).map(String),
    });
  }
  const modules = moduleLock.modules.map((row) => ({ id: row.id, version: row.version }));
  const states = listOf(compositionPlan?.surfaceBindings || scaffoldPlan?.surfaceBindings)
    .filter((row) => row?.required !== false).map((row) => String(row.state));

  // Not every installed capability has a facade. The legacy eight are composed into
  // lib/capabilities/composed/* and several never gained an app/* wrapper, so for those the
  // composed module IS the import surface. Naming only the facades made the brief claim to be the
  // whole surface while omitting them, and told the model never to import from lib/capabilities —
  // an instruction it could not follow for a contact form. It then guessed makeContactForm, which
  // the composed module does not export, tried to patch the protected file to make its guess true,
  // was refused by the write guard, and the build blocked having spent 2.77 credits (live
  // qualification, 2026-09-20). A brief that hides half the surface is worse than no brief.
  //
  // The converse matters just as much: a row the composer tagged with a facade this build actually
  // has is private, because the facade is the supported way to reach it. Naming it here would
  // re-expose on one line exactly what the closing lines call private. Coverage is a fact the
  // composer records when it assembles a facade, never a guess from a path.
  const facadeNames = new Set(byModule.keys());
  const composedOnly = listOf(compositionPlan?.interfaces)
    .filter((row) => !APP_FACADE.test(String(row?.module || "")))
    .filter((row) => !listOf(row.facades).some((name) => facadeNames.has(String(name))))
    .filter((row) => listOf(row.exports).length);

  const lines = [
    "PUBLIC ABI — the whole platform surface this application has. Import it; never reimplement it.",
    ...(byModule.size ? ['From "./lib/app":'] : []),
    ...[...byModule.values()].map((entry) => {
      const owns = entry.owns.length ? ` — owns ${entry.owns.join(", ")}` : "";
      return `  ${entry.facade}: ${entry.exports.join(", ")}${owns}`;
    }),
    ...(composedOnly.length ? ["These have no facade yet; import them from the exact path shown:"] : []),
    ...composedOnly.map((row) => {
      const owns = listOf(row.owns).length ? ` — owns ${listOf(row.owns).join(", ")}` : "";
      return `  ${row.module}: ${listOf(row.exports).join(", ")}${owns}`;
    }),
    ...(states.length ? [`  every surface bound to a module renders: ${[...new Set(states)].join(", ")}`] : []),
    "Import ONLY the names listed above, from the paths shown. Anything else in lib/modules,",
    "lib/capabilities or lib/backend is private, and none of it may be edited or reimplemented.",
  ];
  const text = lines.join("\n");
  return {
    version: ABI_PROJECTION_VERSION,
    modules,
    facades: [...byModule.keys()],
    imports: [
      ...[...byModule.values()].flatMap((entry) => entry.exports),
      ...composedOnly.flatMap((row) => listOf(row.exports).map(String)),
    ],
    composedModules: composedOnly.map((row) => row.module),
    lines,
    text,
    characters: text.length,
  };
}

/**
 * The measured saving against the projection this replaces. Reported rather than asserted at a
 * fixed number: what matters is that the compact form is smaller and still names every facade
 * the build composed, which is the audit's "coverage parity, smaller measured prompts".
 */
export function abiProjectionDelta(projection, legacyText) {
  const legacy = String(legacyText || "").length;
  const compact = projection?.characters ?? 0;
  return {
    legacyCharacters: legacy,
    compactCharacters: compact,
    savedCharacters: Math.max(0, legacy - compact),
    ratio: legacy > 0 ? Number((compact / legacy).toFixed(3)) : null,
  };
}

/**
 * Does the compact projection still cover everything generated code may legitimately reach?
 * Parity here means: every composed facade is named, and nothing private is.
 */
export function abiProjectionParity(projection, compositionPlan) {
  const composed = listOf(compositionPlan?.interfaces)
    .filter((row) => APP_FACADE.test(String(row?.module || "")))
    .map((row) => String(row.module).replace(APP_FACADE, "").replace(/\.js$/, ""));
  const named = new Set(projection?.facades || []);
  const missing = composed.filter((facade) => !named.has(facade));
  const privateNames = listOf(compositionPlan?.interfaces)
    .filter((row) => !APP_FACADE.test(String(row?.module || "")))
    .flatMap((row) => listOf(row.exports).map(String));
  // A private export is a leak only when the brief names it as something to import. A name that
  // also happens to be a facade label ("identity") is the heading, not a private symbol, and a
  // composed export the brief offers on purpose, with the path it comes from, is not a leak either.
  const exported = new Set(projection?.imports || []);
  const leaked = privateNames.filter((name) => !exported.has(name) && !named.has(name)
    && (projection?.lines || []).some((line) => line.startsWith("  ") && new RegExp(`\\b${name}\\b`).test(line)));
  return { ok: missing.length === 0 && leaked.length === 0, missing, leaked };
}
