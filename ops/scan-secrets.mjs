import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  .split("\0").filter(Boolean);
const rules = [
  ["Supabase secret key", /sb_secret_[A-Za-z0-9_-]{20,}/g],
  ["Stripe live secret", /sk_live_[A-Za-z0-9]{16,}/g],
  ["OpenAI project key", /sk-proj-[A-Za-z0-9_-]{20,}/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];
const allowed = new Set((process.env.THRALLO_SECRET_SCAN_ALLOWLIST || "").split(",").filter(Boolean));
const fixtureFiles = /^(?:test\/|ops\/prove-analytics\.mjs$)/;
const findings = [];
for (const file of files) {
  if (fixtureFiles.test(file.replace(/\\/g, "/"))) continue;
  const bytes = await readFile(file).catch(() => null);
  if (!bytes || bytes.includes(0) || bytes.length > 5 * 1024 * 1024) continue;
  const source = bytes.toString("utf8");
  for (const [label, pattern] of rules) {
    for (const match of source.matchAll(pattern)) {
      const fingerprint = `${file}:${label}:${match.index}`;
      if (!allowed.has(fingerprint)) findings.push({ file, label, line: source.slice(0, match.index).split("\n").length });
    }
  }
}
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2)); process.exit(1);
}
console.log(JSON.stringify({ ok: true, scannedFiles: files.length, rules: rules.map(([name]) => name) }));
