// Whether a release may reuse the previous sandbox image.
//
// deploy.sh on the VPS is not in this repository. It used to take the noimage path when
// build-worker/Dockerfile was unchanged, including when verdict-deciding shell files had
// changed. Those files are copied into the image, so the running sandbox then disagreed
// with the host and builds failed with sandbox_version_mismatch.
//
// Callers (deploy.sh, or ops/require-sandbox-image-rebuild.mjs) must rebuild, or fail
// closed and ask for an explicit --image, when this decision says noimage is not allowed.

import { sandboxIdentityFiles } from "../../shell/server/lib/builderV2/sandboxProvenance.mjs";

export const SANDBOX_IMAGE_DEFINITION = "build-worker/Dockerfile";

export function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function sandboxImageRebuildDecision(changedPaths, identityFiles) {
  const critical = new Set([SANDBOX_IMAGE_DEFINITION, ...(identityFiles || [])]);
  const files = [...new Set((changedPaths || []).map(normalizeRepoPath).filter((file) => critical.has(file)))].sort();
  return {
    rebuild: files.length > 0,
    noimageAllowed: files.length === 0,
    files,
    reason: files.length
      ? `provenance-critical files changed since the previous release (${files.join(", ")}); rebuild the sandbox image or pass --image`
      : "no provenance-critical files changed; an unchanged sandbox image may be reused",
  };
}

export async function sandboxImageRebuildDecisionForCheckout({ root = process.cwd(), changedPaths } = {}) {
  const identityFiles = await sandboxIdentityFiles(root);
  return sandboxImageRebuildDecision(changedPaths, identityFiles);
}
