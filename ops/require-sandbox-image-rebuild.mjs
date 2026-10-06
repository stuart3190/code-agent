// Fail closed when a release would reuse a sandbox image across verdict-deciding changes.
//
//   node ops/require-sandbox-image-rebuild.mjs --from <previous-release-sha> [--to HEAD]
//   node ops/require-sandbox-image-rebuild.mjs --paths <repo-relative-path>...
//
// Exit 0: noimage is allowed.
// Exit 2: provenance-critical files changed. Rebuild the image, or pass --image explicitly.
// Exit 1: the check itself could not be completed. Treat that as "do not noimage".
//
// deploy.sh lives on the VPS and is not in this repo. It must run this before taking the
// noimage path. An unchanged Dockerfile is not evidence that the image is still current.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "../build-worker/processTree.mjs";
import { sandboxImageRebuildDecisionForCheckout } from "./lib/sandboxImageRebuild.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flagIndex = (name) => args.indexOf(`--${name}`);
const value = (name) => {
  const index = flagIndex(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : null;
};

async function changedPaths() {
  const pathsFlag = flagIndex("paths");
  if (pathsFlag >= 0) {
    const listed = args.slice(pathsFlag + 1).filter((arg) => arg && !arg.startsWith("--"));
    if (!listed.length) throw new Error("--paths requires at least one path; refusing silent noimage");
    return listed;
  }
  const from = value("from");
  if (!from) {
    throw new Error("pass --from <previous-release> or --paths <file...>; refusing silent noimage");
  }
  const to = value("to") || "HEAD";
  const result = await runProcess("git", ["diff", "--name-only", from, to], {
    cwd: root, env: process.env, wallMs: 30_000, outputBytes: 1024 * 1024,
  });
  if (!result.ok) {
    throw new Error(`cannot diff ${from}..${to}; refusing silent noimage (${result.classification || `exit ${result.exitCode}`})`);
  }
  return String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const paths = await changedPaths();
const decision = await sandboxImageRebuildDecisionForCheckout({ root, changedPaths: paths });
console.log(JSON.stringify(decision, null, 2));
if (decision.rebuild) process.exitCode = 2;
