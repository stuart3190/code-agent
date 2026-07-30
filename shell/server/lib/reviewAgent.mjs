// Review-mode support: read-only toolset, review instructions, and lenient parsing of the
// agent's structured findings. Review runs never edit the repository — write_file is absent
// from the toolset and the command policy still applies to run_command.

import { CODING_TOOLS } from "./codingAgent.mjs";

export const REVIEW_INSTRUCTIONS = `You are Thrallo, a rigorous senior engineer reviewing a pull request in a read-only workspace.
The pull request's head is checked out; the diff against the base branch is included in the task.
Investigate before judging: read the changed files in full, follow references into the rest of the
repository, and run the test suite or targeted checks when they help verify a concern. Never modify files.
Judge correctness first (bugs, broken edge cases, security, data loss), then design and clarity. Do not
invent problems: every finding must cite concrete code you inspected, and style nitpicks belong in the
summary, not findings.
Your FINAL response must be exactly one JSON object, no prose around it, with this shape:
{"verdict":"approve|request_changes|comment","summary":"overall assessment in 2-6 sentences",
"findings":[{"path":"relative/file","line":123,"severity":"blocker|major|minor","title":"short title","detail":"what is wrong, why it matters, and what to do"}]}
Use an empty findings array when the change is sound. The line number must reference the NEW file version.`;

export function reviewTools() {
  return CODING_TOOLS.filter((tool) => tool.name !== "write_file");
}

const DIFF_LIMIT = 60_000;

export function buildReviewPrompt(userPrompt, pullNumber, diff) {
  const trimmedDiff = String(diff || "").slice(0, DIFF_LIMIT);
  const truncated = String(diff || "").length > DIFF_LIMIT;
  return [
    `Review pull request #${pullNumber}.`,
    String(userPrompt || "").trim() && `Reviewer focus: ${String(userPrompt).trim()}`,
    "Diff against the base branch:",
    "```diff",
    trimmedDiff || "(empty diff)",
    "```",
    truncated && "(The diff was truncated; use git_diff and read_file for the full picture.)",
  ].filter(Boolean).join("\n\n");
}

const VERDICTS = new Set(["approve", "request_changes", "comment"]);
const SEVERITIES = new Set(["blocker", "major", "minor"]);

// The model is instructed to answer with bare JSON, but tolerate fenced blocks and
// surrounding prose. An unparseable answer degrades to a comment-only review.
export function parseReviewOutput(text) {
  const raw = String(text || "");
  const candidate = extractJson(raw);
  if (!candidate) {
    return { verdict: "comment", summary: raw.trim().slice(0, 4_000) || "The reviewer returned no assessment.", findings: [], structured: false };
  }
  const verdict = VERDICTS.has(String(candidate.verdict || "").toLowerCase())
    ? String(candidate.verdict).toLowerCase()
    : "comment";
  const findings = (Array.isArray(candidate.findings) ? candidate.findings : [])
    .slice(0, 50)
    .map((finding) => ({
      path: String(finding?.path || "").slice(0, 500),
      line: Number.isFinite(Number(finding?.line)) && Number(finding.line) > 0 ? Math.floor(Number(finding.line)) : null,
      severity: SEVERITIES.has(String(finding?.severity || "").toLowerCase())
        ? String(finding.severity).toLowerCase()
        : "minor",
      title: String(finding?.title || "Finding").slice(0, 200),
      detail: String(finding?.detail || "").slice(0, 4_000),
    }))
    .filter((finding) => finding.path && finding.detail);
  return {
    verdict,
    summary: String(candidate.summary || "").trim().slice(0, 8_000) || "Review completed.",
    findings,
    structured: true,
  };
}

export function renderReviewMarkdown(review, pullNumber) {
  const lines = [
    `# Review of pull request #${pullNumber}`,
    "",
    `**Verdict:** ${review.verdict.replace("_", " ")}`,
    "",
    review.summary,
  ];
  if (review.findings.length) {
    lines.push("", "## Findings");
    for (const finding of review.findings) {
      lines.push("", `### ${severityBadge(finding.severity)} ${finding.title}`,
        `\`${finding.path}\`${finding.line ? `:${finding.line}` : ""}`, "", finding.detail);
    }
  } else {
    lines.push("", "No findings.");
  }
  return lines.join("\n");
}

export function reviewEventForVerdict(verdict, findings) {
  if (verdict === "approve" && !findings.some((finding) => finding.severity !== "minor")) return "APPROVE";
  if (verdict === "request_changes" || findings.some((finding) => finding.severity === "blocker")) return "REQUEST_CHANGES";
  return "COMMENT";
}

function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const source of [fenced?.[1], raw]) {
    if (!source) continue;
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* keep trying */ }
  }
  return null;
}

function severityBadge(severity) {
  return severity === "blocker" ? "🟥" : severity === "major" ? "🟧" : "🟨";
}
