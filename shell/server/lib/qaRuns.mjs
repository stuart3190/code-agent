import crypto from "node:crypto";
import { previewProvider } from "../preview/index.mjs";
import { runQaBrowser } from "./qaRunner.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";
import { auditEvent } from "./projectState.mjs";

const active = new Set();

async function finish(client, id, patch) {
  await client.from("qa_runs").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", id);
}

async function execute(run, tree, client) {
  active.add(run.id);
  try {
    await client.from("qa_runs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", run.id);
    const preview = await previewProvider().start(run.project_id, tree);
    await client.from("qa_runs").update({ preview_url: preview.url }).eq("id", run.id);
    const report = await runQaBrowser({ previewUrl: preview.url, runId: run.id });
    await finish(client, run.id, {
      status: report.issueCount ? "issues_found" : "passed",
      report, passed_count: report.passedCount, issue_count: report.issueCount, error: null,
    });
  } catch (error) {
    console.error(`[qa ${run.id.slice(0, 8)}] ${error?.stack || error}`);
    await finish(client, run.id, { status: "failed", error: "Browser testing could not finish. Please try again." });
  } finally {
    active.delete(run.id);
  }
}

export async function createQaRun(owner, projectId, client = serviceClient()) {
  // Gating lives in the capability registry (requirements()), not the retired Buildr101
  // feature-flag matrix: that read a `feature_flags` table Thrallo never created and an
  // entitlement from the retired credit ledger, so it denied every caller unconditionally.
  const project = await ownedProject(owner.id, projectId, "id,tree", client);
  if (!project) return null;
  if (!project.tree || typeof project.tree !== "object") throw Object.assign(new Error("Build the app before testing it."), { code: "no_app" });
  const { data: existing } = await client.from("qa_runs").select("id,status")
    .eq("owner", owner.id).eq("project_id", projectId).in("status", ["queued", "running"]).maybeSingle();
  if (existing) return existing;

  const row = { id: crypto.randomUUID(), owner: owner.id, project_id: projectId, status: "queued" };
  const { error } = await client.from("qa_runs").insert(row);
  if (error) throw new Error(`qa run create: ${error.message}`);
  execute(row, project.tree, client);
  await auditEvent({ owner: owner.id, projectId, action: "project.qa.started", target: row.id }, client).catch(() => {});
  return { id: row.id, status: row.status };
}

export async function getQaRun(owner, runId, client = serviceClient()) {
  const { data, error } = await client.from("qa_runs")
    .select("id,project_id,status,preview_url,report,passed_count,issue_count,error,created_at,started_at,finished_at")
    .eq("id", runId).eq("owner", owner).maybeSingle();
  if (error) throw new Error(`qa run read: ${error.message}`);
  return data;
}

export async function listQaRuns(owner, projectId, client = serviceClient()) {
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  const { data, error } = await client.from("qa_runs")
    .select("id,project_id,status,passed_count,issue_count,error,created_at,started_at,finished_at")
    .eq("owner", owner).eq("project_id", projectId).order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(`qa run list: ${error.message}`);
  return data || [];
}

export async function sweepQaRuns(client = serviceClient()) {
  const cutoff = new Date(Date.now() - 90 * 60_000).toISOString();
  const { error } = await client.from("qa_runs").update({
    status: "failed", error: "Testing was interrupted by a server restart.", finished_at: new Date().toISOString(),
  }).in("status", ["queued", "running"]).lt("created_at", cutoff);
  if (error) throw new Error(`qa sweep: ${error.message}`);
}
