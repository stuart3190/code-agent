import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, "..");
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "guardrails", "protected-paths.json"), "utf8"));

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function lines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const committed = lines(git(["diff", "--name-only", `${manifest.sourceCommit}...HEAD`]));
const unstaged = lines(git(["diff", "--name-only"]));
const staged = lines(git(["diff", "--cached", "--name-only"]));
const statusOutput = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot, encoding: "utf8" }).replaceAll("\r", "").replace(/\n$/, "");
const status = String(statusOutput || "").split("\n").filter(Boolean)
  .map((line) => line.slice(3).replace(/^"|"$/g, ""));
const changed = [...new Set([...committed, ...unstaged, ...staged, ...status])]
  .map((entry) => entry.replaceAll("\\", "/"));
const violations = changed.filter((entry) => !manifest.allowedChangeRoots.some((root) => entry.startsWith(root)));

if (violations.length) {
  console.error("C0 protected-path guard failed. Changes outside cloud-desktop/ are forbidden:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`C0 protected-path guard passed (${changed.length} changed paths checked).`);
