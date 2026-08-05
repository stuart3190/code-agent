// Does this application actually do what it appears to do?
//
// PR7 of docs/PIPELINE-REDESIGN.md. Everything before this checks that the app compiles, loads and
// can be driven. None of it catches the failure the customer actually reported: a convincing
// interface whose controls do nothing.
//
// These patterns are not hypothetical. Each one is something a generated app has really done:
//
//   - a whole reservation layer built on localStorage. It survived a reload on that browser,
//     looked completely working, and would lose every booking anywhere else. (Production, staged
//     run 2, 2026-08-04.)
//   - forms that show a success toast and store nothing.
//   - `await new Promise(r => setTimeout(r, 800))` standing in for a backend call, so the app even
//     has a convincing loading state.
//   - buttons with `onClick={() => {}}`.
//
// The rule the brief sets, and this enforces: every visible action must work, be clearly disabled
// with a reason, or be omitted.
//
// STATIC analysis, deliberately. A runtime check cannot tell "saved to the backend" from "saved to
// a variable" — both look identical from outside — and the source says plainly which one it is.

const SOURCE = /\.(jsx?|tsx?)$/;
const APP_SOURCE = (path) => SOURCE.test(path) && path.startsWith("src/") && !path.startsWith("src/lib/backend/");

// Comments and string bodies produce false hits — a comment saying "TODO: wire up the backend" is
// not a fake handler. Blanked, preserving newlines so reported line numbers stay true.
function stripNonCode(source) {
  let out = "";
  let i = 0;
  let quote = null;
  const text = String(source);
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === "\\") { out += "  "; i += 2; continue; }
      if (ch === quote) { quote = null; out += ch; i += 1; continue; }
      out += ch === "\n" ? "\n" : " ";
      i += 1; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") out += "\n"; i += 1; }
      i += 2; continue;
    }
    out += ch; i += 1;
  }
  return out;
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// ── the patterns ──────────────────────────────────────────────────────────────────────────────
//
// `severity: "hard"` is a lie about what the app does and fails the scan. `severity: "soft"` is
// worth reporting but may be legitimate, and only warns — a scan that blocks builds on
// judgement calls would stop shipping working software.

const PATTERNS = [
  {
    id: "empty_handler",
    severity: "hard",
    label: "a control whose handler does nothing",
    // onClick={() => {}} / onSubmit={()=>{}} / onClick={function(){}}
    regex: /\bon[A-Z]\w+\s*=\s*\{\s*(?:\(\s*\w*\s*\)|\w+)?\s*=>\s*\{\s*\}\s*\}/g,
    explain: () => "the handler is empty, so the control does nothing when used",
  },
  {
    id: "todo_handler",
    severity: "hard",
    label: "a handler that only leaves a note",
    // A handler whose entire body is a console.log or a TODO.
    regex: /\bon[A-Z]\w+\s*=\s*\{\s*\(?\s*\w*\s*\)?\s*=>\s*(?:console\.\w+\([^)]*\)|alert\([^)]*\))\s*\}/g,
    explain: () => "the handler only logs or alerts — nothing is stored and nothing changes",
  },
  {
    id: "fake_persistence",
    severity: "hard",
    label: "records stored in the browser instead of the backend",
    regex: /\b(?:localStorage|sessionStorage|indexedDB)\s*\.\s*(?:setItem|getItem|removeItem|put|add)\b/g,
    explain: (match) => `${match.split(".")[0].trim()} is not persistence — the data exists on one `
      + "browser only, survives a reload there, and is invisible everywhere else",
  },
  {
    id: "simulated_delay",
    severity: "hard",
    label: "a fake loading delay standing in for a backend call",
    regex: /new\s+Promise\s*\(\s*(?:\w+|\([^)]*\))\s*=>\s*setTimeout\s*\(/g,
    explain: () => "an artificial delay imitates a network call, which makes an app that does "
      + "nothing feel like an app that is working",
  },
  {
    id: "fake_auth",
    severity: "hard",
    label: "authentication that authenticates nothing",
    regex: /\b(?:setIsLoggedIn|setLoggedIn|setAuthenticated|setIsAuthenticated)\s*\(\s*true\s*\)/g,
    explain: () => "the signed-in state is set directly rather than by the auth SDK, so anyone is "
      + "signed in as anyone",
  },
  {
    id: "disabled_without_reason",
    severity: "soft",
    label: "a control disabled with no stated reason",
    regex: /\bdisabled\s*=\s*\{?\s*true\s*\}?/g,
    explain: () => "a permanently disabled control needs a visible reason, or it reads as broken",
  },
  {
    id: "placeholder_control",
    severity: "soft",
    label: "a control labelled as unfinished",
    regex: /(?:coming soon|not implemented|todo|placeholder|under construction)/gi,
    explain: () => "deferred work should be absent or explained, not labelled in the interface",
  },
];

// A file that talks to the backend at all. Used to decide whether component state is a cache or
// the whole database.
const USES_BACKEND = /\b(?:db\s*\.\s*entity|auth\s*\.\s*(?:signUp|signIn|currentUser)|storage\s*\.)/;

// ── Session-credential bootstrap (run cf130c23, src/App.jsx ensureBookingSession) ─────────────
//
// Entities are owner-scoped by RLS, so an app whose contract requires no sign-in can only persist
// visitor data by minting a visitor account — and the only place that account's generated
// credentials can live between reloads is the browser. That localStorage use is AUTH BOOTSTRAP,
// not fake persistence: the cached value's sole purpose is to be handed to auth.signIn/auth.signUp,
// and the records themselves live in db.entity() under the session it establishes. Flagging it as
// dishonest blocked a build whose bookings demonstrably persisted server-side and survived reload.
//
// The classification is deliberately narrow — ALL of these must hold in the ENCLOSING FUNCTION:
//   - a variable is assigned from JSON.parse(<store>.getItem(...)),
//   - that SAME variable is the argument of auth.signIn(...) or auth.signUp(...),
//   - the function mints credentials (a `password` field appears in code, not just strings).
// Business records handed to a sign-in call is not a shape a generated app produces; anything
// looser than this stays a hard finding.

function functionRanges(code) {
  const ranges = [];
  const header = /(?:async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*\{|=>\s*\{/g;
  let m;
  while ((m = header.exec(code)) !== null) {
    const open = code.indexOf("{", m.index + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) { ranges.push({ start: open, end: i + 1 }); break; }
      }
    }
  }
  return ranges;
}

function bootstrapBodyTest(body) {
  const cached = /([\w$]+)\s*=\s*JSON\s*\.\s*parse\s*\(\s*(?:window\s*\.\s*|globalThis\s*\.\s*)?(?:localStorage|sessionStorage)\s*\.\s*getItem\b/.exec(body);
  if (!cached) return false;
  const name = cached[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`auth\s*\.\s*(?:signIn|signUp)\s*\(\s*${name}\s*\)`).test(body)
    && /\bpassword\b/.test(body);
}

/** Is the storage expression at `index` part of a session-credential bootstrap? */
export function isSessionBootstrap(code, index) {
  const enclosing = functionRanges(code)
    .filter((r) => r.start <= index && index < r.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  return enclosing ? bootstrapBodyTest(code.slice(enclosing.start, enclosing.end)) : false;
}

/**
 * The app's own session-bootstrap function, if it declares one: a NAMED top-level function whose
 * body passes the same three-part test. The persistence transform reuses it verbatim rather than
 * synthesising session logic it cannot prove.
 */
export function findSessionBootstrapFunction(source) {
  const code = stripNonCode(String(source || ""));
  const header = /(?:async\s+)?function\s+([\w$]+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = header.exec(code)) !== null) {
    const open = code.indexOf("{", m.index + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          if (bootstrapBodyTest(code.slice(open, i + 1))) {
            // Return the ORIGINAL text (comments and strings intact), located by the same offsets:
            // stripNonCode preserves newlines and brace structure, so the stripped offsets map to
            // the same function in the raw source via its header-to-close line span.
            const raw = String(source || "");
            const startLine = lineOf(code, m.index);
            const endLine = lineOf(code, i);
            const lines = raw.split("\n");
            return { name: m[1], text: lines.slice(startLine - 1, endLine).join("\n") };
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Scan a generated project.
 *
 * `contract` matters: something the contract DEFERS is allowed to be absent or disabled, and
 * reporting it would be reporting a decision the customer was told about.
 *
 * Returns `{ ok, findings, warnings, summary }` — `ok` false means the app claims to do something
 * it does not.
 */
export function honestyScan(tree, { contract = null } = {}) {
  const findings = [];
  const warnings = [];
  const deferred = (contract?.deferred || []).map((d) => String(d.item || "").toLowerCase());
  const entities = (contract?.entities || []).map((e) => String(e.name || "").toLowerCase());

  let anyBackendCall = false;

  for (const [path, raw] of Object.entries(tree || {})) {
    if (!APP_SOURCE(path)) continue;
    const code = stripNonCode(String(raw || ""));
    if (USES_BACKEND.test(code)) anyBackendCall = true;

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(code)) !== null) {
        const line = lineOf(code, match.index);
        const snippet = String(raw).split("\n")[line - 1]?.trim().slice(0, 120) || match[0];

        // A finding about work the contract explicitly deferred is not dishonest — it is the
        // agreement being kept. Only "coming soon"-style labels can be excused this way: a fake
        // persistence call is dishonest whatever was deferred.
        if (pattern.severity === "soft" && deferred.some((item) => snippet.toLowerCase().includes(item.split(" ")[0]))) {
          continue;
        }

        // Session-credential bootstrap: storage whose only consumer is auth.signIn/auth.signUp.
        // Reported — the cache is real and worth seeing — but as a warning, because the records
        // themselves live in the database under the session it establishes.
        if (pattern.id === "fake_persistence" && isSessionBootstrap(code, match.index)) {
          warnings.push({
            id: "session_credentials", severity: "soft", file: path, line,
            label: "session credentials cached in the browser", snippet,
            message: `${path}:${line} — session credentials cached in the browser: the cached value `
              + "only signs into the backend (auth.signIn/auth.signUp); the records themselves live "
              + "in the database",
          });
          continue;
        }

        const entry = {
          id: pattern.id, severity: pattern.severity, file: path, line,
          label: pattern.label, snippet,
          message: `${path}:${line} — ${pattern.label}: ${pattern.explain(match[0])}`,
        };
        (pattern.severity === "hard" ? findings : warnings).push(entry);
      }
    }
  }

  // A contract that declares entities, in an app that never once calls the backend, is the
  // whole-application version of the same lie — every screen may look right and nothing is stored.
  if (entities.length && !anyBackendCall) {
    findings.push({
      id: "no_backend_at_all", severity: "hard", file: "src/", line: 0,
      label: "declared data that is never stored",
      snippet: "",
      message: `the contract declares ${entities.join(", ")} but nothing in src/ ever calls `
        + "db.entity(), so nothing the user creates is saved anywhere",
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    warnings,
    summary: findings.length
      ? `${findings.length} dishonest implementation(s): ${[...new Set(findings.map((f) => f.id))].join(", ")}`
      : `honest${warnings.length ? ` (${warnings.length} warning(s))` : ""}`,
  };
}

/** The findings, phrased for a repair brief. */
export function honestyFailures(result) {
  return (result?.findings || []).map((f) => f.message);
}
