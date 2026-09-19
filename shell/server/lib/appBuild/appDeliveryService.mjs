// Customer-facing operations for a verified Builder V2 project.
//
// Generation, edits and repairs belong to Builder V2. This service deliberately contains only
// operations that consume the owner-bound green snapshot: preview, browser QA and source export.

import { serviceClient } from "../supabase.mjs";
import { previewProvider } from "../../preview/index.mjs";

// (Re)provision a preview from the authoritative verified snapshot. This heals reaped preview
// containers and old conversations without trusting a mutable client/project tree.
export async function showPreview(ctx, { productName = null } = {}) {
  const client = serviceClient();
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project } = await resolveConversationProject(ctx, {
    productName,
    columns: "id, name, product_id, updated_at, builder_version, bv2_green_snapshot_id",
    client,
  });
  if (!project) {
    const error = new Error("There's no built app to preview yet — ask me to build something first.");
    error.code = "nothing_to_preview";
    throw error;
  }
  await ctx.emit("agent_spawned", { agent: "Publisher", status: "Bringing the preview up…" });
  try {
    const { withRuntimeEnv } = await import("../runtimeEnv.mjs");
    const { resolveVerifiedProjectTree } = await import("../builderV2/projectSource.mjs");
    const source = await resolveVerifiedProjectTree(ctx.owner, project, { client, allowLegacy: false });
    const previews = previewProvider();
    if (previews.mode !== "vps") {
      throw Object.assign(new Error("Builder V2 previews require the isolated production provisioner."), {
        code: "preview_isolation_required",
      });
    }
    const preview = await previews.start(project.id, withRuntimeEnv(source.tree, project.id));
    if (!preview?.url) throw new Error("The preview service returned no address.");
    await client.from("projects").update({ preview_ref: preview.url, updated_at: new Date().toISOString() })
      .eq("id", project.id).eq("owner", ctx.owner);
    await ctx.emit("agent_done", { agent: "Publisher", ok: true });
    await ctx.emit("preview_ready", { url: preview.url, projectId: project.id, message: "Preview ready — take a look." });
    return { url: preview.url, projectId: project.id, note: "The preview card is in the conversation — do not repeat the URL." };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Publisher", ok: false });
    throw error;
  }
}

// Start the responsive/multi-route QA sweep. createQaRun independently rematerialises the green
// snapshot and requires the durable worker, so this capability remains a thin scoped dispatcher.
export async function runQaSweep(ctx, { productName = null } = {}) {
  const client = serviceClient();
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project } = await resolveConversationProject(ctx, {
    productName,
    columns: "id, name, product_id, updated_at, builder_version, bv2_green_snapshot_id",
    client,
  });
  if (!project) {
    const error = new Error("There's no built app to test yet — ask me to build something first.");
    error.code = "nothing_to_test";
    throw error;
  }

  const { createQaRun } = await import("../qaRuns.mjs");
  await ctx.emit("agent_spawned", { agent: "Tester", status: "Testing the app across screen sizes…" });
  try {
    const run = await createQaRun({ id: ctx.owner }, project.id, client);
    if (!run) throw new Error("That project could not be found.");
    return {
      runId: run.id,
      projectId: project.id,
      status: run.status,
      note: "The sweep is running; I'll report what it finds across phone, tablet and desktop widths.",
    };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Tester", ok: false });
    throw error;
  }
}

// Package the authoritative green snapshot as a secret-free source archive.
export async function exportProject(ctx, { productName = null } = {}) {
  const client = serviceClient();
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project } = await resolveConversationProject(ctx, {
    productName,
    columns: "id, name, product_id, updated_at, builder_version, bv2_green_snapshot_id",
    client,
  });
  if (!project) {
    const error = new Error("There's no built app to export yet — ask me to build something first.");
    error.code = "nothing_to_export";
    throw error;
  }

  const { buildProjectZip } = await import("../exportProject.mjs");
  const { assertNoPlatformSecrets, stripExportNoise } = await import("../secretScrub.mjs");
  await ctx.emit("agent_spawned", { agent: "Publisher", status: "Packaging the source…" });
  try {
    const { resolveVerifiedProjectTree } = await import("../builderV2/projectSource.mjs");
    const source = await resolveVerifiedProjectTree(ctx.owner, project, { client, allowLegacy: false });
    const cleaned = stripExportNoise(source.tree);
    const built = buildProjectZip({ ...project, tree: cleaned.files });
    assertNoPlatformSecrets(built.files);

    const { signalBuildOutcome } = await import("../buildOutcomes.mjs");
    signalBuildOutcome({ owner: ctx.owner, projectId: project.id, signal: "exported" }).catch(() => {});

    await ctx.emit("agent_done", { agent: "Publisher", ok: true });
    await ctx.emit("download_ready", {
      projectId: project.id,
      filename: built.filename,
      url: `/api/export?projectId=${encodeURIComponent(project.id)}`,
      sizeBytes: built.zip.length,
      fileCount: Object.keys(built.files).length,
      message: "Your source package is ready.",
    });
    return {
      projectId: project.id,
      filename: built.filename,
      fileCount: Object.keys(built.files).length,
      note: "The download card is in the conversation — do not repeat the link.",
    };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Publisher", ok: false });
    throw error;
  }
}
