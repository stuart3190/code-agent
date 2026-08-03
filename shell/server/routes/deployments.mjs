// Deployment routes.
//
//   GET  /api/v1/projects/:id/deployments                    the publish history
//   POST /api/v1/projects/:id/deployments/:deploymentId/rollback
//   GET  /api/v1/projects/:id/deployments/:deploymentId/download
//
// Every one is owner-scoped inside the library, and rollback and download additionally prove the
// deployment belongs to THIS app — an owner with two apps must not be able to roll one back onto
// the other's address by pasting an id.

import { listDeployments, getDeployment, assertBelongsTo, publicDeployment } from "../lib/deployments/deploymentService.mjs";
import { rollbackToDeployment } from "../lib/appBuild/appPublishService.mjs";
import { assertNoPlatformSecrets, buildProjectZip } from "../lib/exportProject.mjs";

// Same rule the ordinary export uses: a filename reaching a Content-Disposition header must not be
// able to carry quotes or newlines into it.
function safeContentDisposition(filename) {
  const fallback = "thrallo-deployment.zip";
  const safe = String(filename || fallback).replace(/[^a-zA-Z0-9._-]/g, "-") || fallback;
  return `attachment; filename="${safe}"`;
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function wrap(res, run) {
  try {
    return sendJson(res, 200, await run());
  } catch (error) {
    const status = error.status || 500;
    console.error(`[deployments] ${error?.message || error}`);
    return sendJson(res, status, {
      error: status === 500 ? "Something went wrong with that deployment. Please try again." : error.message,
      code: error.code || "deployment_failed",
    });
  }
}

export async function handleDeploymentsList(_req, res, owner, projectId) {
  return wrap(res, async () => ({ deployments: await listDeployments(owner.id, projectId) }));
}

export async function handleDeploymentRollback(_req, res, owner, projectId, deploymentId) {
  return wrap(res, async () => {
    const result = await rollbackToDeployment(owner.id, projectId, deploymentId);
    return { ...result, deployments: await listDeployments(owner.id, projectId) };
  });
}

/**
 * The source that was published as this deployment — not the project's current source.
 *
 * Labelled as a source reconstruction, because it is. Thrallo stores the exact TREE that was
 * published, not the built artifact, so this rebuilds the app from that source rather than handing
 * back the bytes that were served. Calling it "the deployment" would overstate what is kept.
 */
export async function handleDeploymentDownload(_req, res, owner, projectId, deploymentId) {
  try {
    const deployment = await getDeployment(owner.id, deploymentId);
    await assertBelongsTo(owner.id, deployment, projectId);
    if (!deployment.source_tree) {
      return sendJson(res, 409, {
        error: "That deployment's source is no longer stored, so it cannot be downloaded.",
        code: "source_unavailable",
      });
    }

    let built;
    try {
      built = buildProjectZip({ name: `deployment-${deployment.number}`, tree: deployment.source_tree });
      // The same scrubber the ordinary export runs. A deployment archive is exactly as capable of
      // carrying a platform secret as any other.
      assertNoPlatformSecrets(built.files);
    } catch (error) {
      console.error(`[deployments] download build failed: ${error?.stack || error}`);
      return sendJson(res, 400, { error: "That download could not be prepared.", code: "download_failed" });
    }

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": safeContentDisposition(built.filename),
      "Cache-Control": "no-store",
      // Says plainly what this is, for anyone reading the response rather than the UI.
      "X-Thrallo-Source-Reconstruction": "true",
    });
    return res.end(built.zip);
  } catch (error) {
    const status = error.status || 500;
    console.error(`[deployments] ${error?.message || error}`);
    return sendJson(res, status, {
      error: status === 500 ? "That download could not be prepared." : error.message,
      code: error.code || "download_failed",
    });
  }
}

export { publicDeployment };
