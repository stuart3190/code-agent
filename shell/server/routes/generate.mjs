// POST /api/generate — the ONE endpoint that spends Codex quota. Fires only on an explicit
// user click. As of the background-builds change it no longer streams: it validates, gates,
// creates a detached build JOB (lib/buildJobs.mjs owns the engine loop) and returns 202 with
// the job id. The client observes the job via GET /api/builds/:id/events — so a build survives
// the browser navigating away, and two apps can build at once.
//
// The proven engine chain (runAgent · routing provider · prompts · scaffold · buildTree ·
// ledger.debit) moved verbatim into buildJobs.runJob — nothing reimplemented.

import { ledger } from "../lib/services.mjs";
import { getDecryptedKey } from "../lib/byokStore.mjs";
import { ensureWelcomeGrant } from "../lib/welcome.mjs";
import { createJob, latestBuildStderr } from "../lib/buildJobs.mjs";
import { ownedProject } from "../lib/supabase.mjs";

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export async function handleGenerate(req, res, body, owner) {
  let prompt = (body?.prompt || "").trim();
  const mode = body?.mode === "iterate" ? "iterate" : body?.mode === "plan" ? "plan" : "build";
  const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
  const knowledge = typeof body?.knowledge === "string" ? body.knowledge.trim().slice(0, 4000) : "";
  const style = {
    preset: typeof body?.style?.preset === "string" ? body.style.preset.slice(0, 40) : "auto",
    notes: typeof body?.style?.notes === "string" ? body.style.notes.trim().slice(0, 500) : "",
  };
  const designProfile = body?.designProfile && typeof body.designProfile === "object" && !Array.isArray(body.designProfile)
    ? body.designProfile : null;
  const redesign = body?.redesign === true;
  const projectId = body?.projectId || `new-${Date.now()}`;

  if (!(await ownedProject(owner.id, projectId))) {
    return sendJson(res, 404, { error: "project not found" });
  }

  // "Fix it" for a BUILD error: the stderr never went to the browser (it is full of file
  // paths), so the fix prompt is composed HERE from the job record's server-side copy.
  if (body?.fixBuild === true) {
    const stderr = await latestBuildStderr(owner.id, projectId);
    if (!stderr) return sendJson(res, 400, { error: "no build error on record for this project" });
    prompt = `The app fails to build. Fix the root cause of this build error:\n\n${stderr}`;
  }

  if (!prompt) return sendJson(res, 400, { error: "prompt is required" });
  if (mode === "iterate" && (!body?.tree || typeof body.tree !== "object")) {
    return sendJson(res, 400, { error: "iterate mode requires the current project `tree`" });
  }

  // Coarse pre-spend gate — MANAGED lane only, synchronous so "no credits" stays an immediate
  // 402 (no job is created). BYOK users pay their own inference. New accounts get their
  // one-time welcome credits before the gate (idempotent no-op after).
  let byok = false;
  try { byok = !!(await getDecryptedKey(owner.id)); } catch { byok = false; }
  await ensureWelcomeGrant(owner.id);
  const preBal = await ledger().getBalance(owner.id);
  if (!byok && preBal.total <= 0) {
    return sendJson(res, 402, { error: "insufficient_balance", balance: preBal,
      hint: "You're out of credits. Top up and try again." });
  }

  const { job, existing } = await createJob({
    owner, projectId, mode, prompt,
    tree: mode === "iterate" ? { ...body.tree } : undefined,
    plan, knowledge, style, designProfile, redesign,
  });
  return sendJson(res, 202, { jobId: job.id, existing, status: job.status, phase: job.phase });
}
