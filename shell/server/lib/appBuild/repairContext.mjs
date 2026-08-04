// What the repair agent is actually told.
//
// PR1 of docs/PIPELINE-REDESIGN.md. The brief used to be one line, truncated at 200 characters:
//
//   `the build ${status}: ${String(error).slice(0, 200)}`
//
// …and the conversational evidence it sometimes carried said "open Build Diagnostics (baa3e8fc) to
// read it". The repair agent said what that cost, verbatim, in production:
//
//   "I reviewed the supplied project files and found no compile-time issue in the current source
//    that can be safely changed without the actual Build Diagnostics `baa3e8fc` output; no files
//    were modified."
//
// It could not see the error, so it guessed: once removing three UNUSED imports believing it was a
// lint failure, once restoring an unrelated window.confirm. The real fault — one invalid icon
// import — was never touched, across two rounds and ~21 credits.
//
// So this module builds a brief that CONTAINS the failure rather than pointing at it. Every field
// here exists because its absence produced a specific wrong repair.

const MAX_OUTPUT_CHARS = 6_000;
const MAX_DIFF_CHARS = 2_000;
const MAX_FILES_LISTED = 60;

// eslint-disable-next-line no-control-regex
const ANSI = /[[0-9;]*[A-Za-z]/g;

/**
 * Strip terminal colour codes.
 *
 * Vite and rollup colourise their output, so raw stderr is full of escape sequences. Left in, they
 * corrupt every downstream parse - a path arrives as ESC[31msrc/App.jsx, and a patch verifier
 * comparing that against a tree path finds no match - and they are noise in the brief besides.
 * Stripped once, at the entry point everything else goes through.
 *
 * Anchored on the ESC character deliberately: a bare /[[0-9;]*[A-Za-z]/ also matches ordinary
 * code (items[0]d, a CSS [data-state]) and would quietly corrupt source quoted in the brief.
 */
export function stripAnsi(text) {
  return String(text || "").replace(ANSI, "");
}

/**
 * Redact anything that looks like a credential before it reaches a model.
 *
 * The build output carries env dumps, install logs and occasionally a URL with a token in it. The
 * brief is the one place raw terminal output is deliberately forwarded, so it is also the one place
 * that has to scrub. Patterns are deliberately broad: a false positive costs the model a little
 * context, a false negative leaks a live key.
 */
export function redact(text) {
  return stripAnsi(text)
    // key=value and "key": "value" forms for anything that names itself a secret
    .replace(/([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*[:=]\s*)(["']?)([^\s"',}]+)\2/gi,
      (_, prefix, quote) => `${prefix}${quote}<redacted>${quote}`)
    // Bearer tokens and Authorization headers
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 <redacted>")
    // Well-known key shapes: Stripe, OpenAI/Anthropic, Supabase/JWT, GitHub
    .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-<redacted>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh_<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted-jwt>")
    // Credentials embedded in a URL
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@");
}

// The tail is where compilers put the actual error; the head is usually the banner.
function trimOutput(text, limit = MAX_OUTPUT_CHARS) {
  const clean = redact(text).trimEnd();
  if (clean.length <= limit) return clean;
  return `…[${clean.length - limit} earlier characters omitted]…\n${clean.slice(-limit)}`;
}

/**
 * The single most important line in the brief.
 *
 * Compilers bury the cause in a wall of context. Surfacing it verbatim at the top means the model
 * reads the real fault before it reads anything it might mistake for one — which is exactly the
 * mistake that produced "addressing the build quality/lint failure".
 */
export function headlineError(output) {
  const text = stripAnsi(output);
  const patterns = [
    // Rollup/Vite: "X" is not exported by "Y", imported by "Z"
    /"[^"]+" is not exported by [^\n]+/,
    // Node/bundler resolution
    /(?:Cannot find module|Failed to resolve import|Module not found)[^\n]+/,
    // TypeScript
    /error TS\d+:[^\n]+/,
    // Generic bundler error line
    /error during build:[^\n]*\n?[^\n]*/,
    // Node runtime
    /\b[A-Z][a-zA-Z]*Error:[^\n]+/,
  ];
  for (const pattern of patterns) {
    const found = text.match(pattern);
    if (found) return found[0].trim();
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|failed/i.test(l)) || lines.at(-1) || "";
}

/**
 * Assemble the repair brief.
 *
 * Ordered so the model reads the failure before the project: what ran, what it said, what changed
 * last time, and whether that changed anything. The instruction to fix the NAMED error comes last,
 * immediately before it starts work.
 */
export function buildRepairBrief({
  command = "npm run build",
  output = "",
  fingerprint = null,
  previousFingerprint = null,
  changedFiles = [],
  lastDiff = "",
  tree = null,
  manifest = null,
  worktree = null,
  branch = null,
  commit = null,
  attempt = 1,
  maxAttempts = null,
  previousAttempts = [],
  reasons = [],
  strategy = null,
  patchVerdict = null,
} = {}) {
  const headline = headlineError(output);
  const unchanged = !!fingerprint && !!previousFingerprint && fingerprint === previousFingerprint;
  const lines = [];

  lines.push("AUTONOMOUS REPAIR — fix the failure below. It is quoted exactly; do not infer a");
  lines.push("different problem, and do not 'tidy' anything the error does not name.");
  lines.push("");

  if (headline) {
    lines.push("THE ERROR:");
    lines.push(`  ${headline}`);
    lines.push("");
  }

  lines.push(`COMMAND THAT FAILED: ${command}`);
  lines.push("");
  lines.push("COMPLETE OUTPUT:");
  lines.push(trimOutput(output));
  lines.push("");

  if (unchanged) {
    // The strongest signal available, and the one previously used to give up rather than escalate.
    lines.push("THE LAST REPAIR DID NOT WORK. The failure signature is byte-for-byte identical to");
    lines.push("before your previous patch. Whatever you changed last time was not the cause.");
    lines.push("Do NOT repeat it or a variation of it. Read the error above and fix THAT.");
    lines.push("");
  }

  // What the patch verifier concluded about the last round, in its own words — "you edited a file
  // the error does not name" is far more actionable than "it still fails".
  if (patchVerdict?.summary) {
    lines.push(`VERIFIED ABOUT YOUR LAST PATCH: ${patchVerdict.summary}.`);
    lines.push("");
  }

  // The escalation rung. Named explicitly so each round is a materially different approach rather
  // than the same one restated — which is what four identical fingerprints in production were.
  if (strategy) {
    lines.push(`APPROACH FOR THIS ATTEMPT — ${strategy.label}:`);
    lines.push(strategy.instruction);
    lines.push("");
  }

  if (previousAttempts.length) {
    lines.push("ALREADY TRIED (do not repeat):");
    for (const attemptSummary of previousAttempts.slice(-4)) {
      lines.push(`- ${String(attemptSummary).replace(/\s+/g, " ").slice(0, 240)}`);
    }
    lines.push("");
  }

  if (changedFiles.length) {
    lines.push(`FILES YOUR LAST PATCH TOUCHED: ${changedFiles.slice(0, MAX_FILES_LISTED).join(", ")}`);
    if (lastDiff) {
      lines.push("THAT PATCH:");
      lines.push(redact(String(lastDiff)).slice(0, MAX_DIFF_CHARS));
    }
    lines.push("");
  }

  if (manifest) {
    // The installed dependency set, so a version-specific export can be reasoned about rather than
    // assumed. The lucide-react failure was exactly this: an icon that does not exist in the pin.
    lines.push("INSTALLED DEPENDENCIES (package.json):");
    lines.push(redact(typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2)).slice(0, 2_000));
    lines.push("");
  }

  if (tree && Object.keys(tree).length) {
    lines.push(`PROJECT FILES (${Object.keys(tree).length}): ${Object.keys(tree).slice(0, MAX_FILES_LISTED).join(", ")}`);
    lines.push("");
  }

  if (worktree || branch || commit) {
    // So a stale-source repair is diagnosable rather than invisible.
    lines.push(`BUILDING FROM: ${[worktree && `worktree ${worktree}`, branch && `branch ${branch}`, commit && `commit ${commit}`]
      .filter(Boolean).join(" · ")}`);
    lines.push("");
  }

  if (reasons.length) {
    lines.push("CHECKS THAT FAILED:");
    for (const reason of reasons) lines.push(`- ${String(reason).replace(/\s+/g, " ").slice(0, 300)}`);
    lines.push("");
  }

  lines.push(`Attempt ${attempt}${maxAttempts ? ` of ${maxAttempts}` : ""}.`);
  lines.push("Apply the smallest change that fixes the named error. Preserve the existing design,");
  lines.push("layout, branding and component structure exactly.");

  return lines.join("\n");
}

// True when the brief still points at diagnostics instead of carrying them. Used by the tests and
// by the proof, so the regression cannot come back quietly.
export function referencesDiagnosticsOnly(brief) {
  const text = String(brief || "");
  const points = /open Build Diagnostics|saved build diagnostics|Diagnostics view|diagnostics \([0-9a-f]{6,}\)/i.test(text);
  const carries = /COMPLETE OUTPUT:/.test(text);
  return points && !carries;
}
