// startAppBuild: the bridge between the Lead Agent and the generation pipeline.
// Creates the project row (server-mediated — the legacy client-side tree write is gone),
// dispatches a build job, and relays the pipeline's phases into the conversation as a
// staged specialist team (Principle 4) with an unprompted preview card the moment the
// preview is reachable (Principle 5). The terminal tree is persisted server-side.

import { serviceClient } from "../supabase.mjs";
import { createJob, subscribe, getJob, isTerminal } from "../buildJobs.mjs";
import { notifyOwnerIfAway } from "../notifications/notificationService.mjs";
import { previewProvider } from "../../preview/index.mjs";
import { startDiagSessionSafe, nullDiagSession } from "./buildDiagnostics.mjs";
import { fingerprintFailure, fingerprintPrompt } from "./contextScope.mjs";

// The end-of-build message NEVER claims a live preview unless a URL actually exists
// (Stuart, 2026-07-31: "a build should never claim success unless the preview is actually
// visible"). Pure and unit-tested.
export function buildEndSummary(result) {
  if (!result?.previewUrl) {
    return "Your app is built. The preview is still warming up — I'll drop it into this conversation the moment it's ready.";
  }
  return "Your app is built and the preview is live in this conversation.";
}

// Autonomous failure handling (Stuart, 2026-07-31): a failed build is UNFINISHED WORK, not
// a reason to hand control back. This pure planner decides the relay's next move — repair
// and re-verify without asking, retry crashed jobs, and only stop at genuine exhaustion.
// Routine failures (build checks, runtime config, tests, verification) NEVER ask permission.
export const MAX_AUTO_ROUNDS = 3;

export function planEndAction(data, { attempt = 1, maxAttempts = MAX_AUTO_ROUNDS, previousFingerprints = [] } = {}) {
  if (data.status === "complete" && data.result?.buildOk !== false) {
    return { kind: data.result?.previewUrl ? "verify" : "warmup" };
  }
  const reasons = data.status === "complete"
    ? (data.result?.qualityWarnings?.length ? data.result.qualityWarnings : ["the build's quality checks failed"])
    : [`the build ${data.status}${data.error ? `: ${String(data.error).slice(0, 200)}` : ""}`];
  // Controlled repair loop: an identical failure after a repair round means the repair made
  // no meaningful progress — stop immediately instead of burning the remaining rounds.
  const fingerprint = fingerprintFailure(reasons);
  if (previousFingerprints.includes(fingerprint)) {
    return {
      kind: "blocked", fingerprint,
      message: `The same failure came back unchanged after an autonomous repair — repeating the loop would spend your budget without progress:\n${reasons.map((r) => `- ${r}`).join("\n")}\nI need a decision from you on how to proceed.`,
    };
  }
  if (attempt < maxAttempts) {
    const brief = [
      "AUTONOMOUS REPAIR — the previous round failed these checks. Diagnose the root cause and",
      "apply the smallest safe fix for each; change nothing else:",
      ...reasons.map((r) => `- ${r}`),
      "",
      "Preserve the existing design, layout, branding and component structure exactly.",
    ].join("\n");
    return {
      kind: data.status === "complete" ? "repair" : "retry",
      brief, fingerprint,
      announcement: `The build check found a problem (${String(reasons[0]).slice(0, 140)}). I'm repairing it now and will re-run verification.`,
    };
  }
  return {
    kind: "blocked", fingerprint,
    message: `I attempted ${maxAttempts} autonomous repair rounds and this still fails:\n${reasons.map((r) => `- ${r}`).join("\n")}\nThis looks like a genuine blocker beyond routine repair — I need a decision from you on how to proceed.`,
  };
}

// Build phases → the specialist the user watches. Sequential: each phase change retires the
// previous specialist (✓) and spawns the next, so the team appears as work actually begins.
const PHASE_SPECIALISTS = {
  preparing: { agent: "Planner", status: "Preparing the build…" },
  planning: { agent: "Planner", status: "Planning the architecture…" },
  designing: { agent: "Designer", status: "Creating the design system…" },
  building: { agent: "Builder", status: "Writing the code…" },
  "quality-checking": { agent: "Tester", status: "Running quality checks…" },
  polishing: { agent: "Designer", status: "Polishing the design…" },
  finalizing: { agent: "Publisher", status: "Preparing your preview…" },
};

export async function startAppBuild(ctx, { description, productName = null }) {
  const client = serviceClient();
  const name = (productName || "").trim() || null;

  // Product memory: an app build always belongs to a named product when one is given.
  let productId = ctx.conversation.product_id || null;
  if (name) {
    const product = await ctx.conversations.upsertProduct(ctx.owner, name.slice(0, 120));
    productId = product.id;
    if (!ctx.conversation.product_id) {
      await ctx.conversations.updateConversation(ctx.conversation, { product_id: product.id });
    }
  }

  const { data: project, error } = await client.from("projects").insert({
    owner: ctx.owner,
    name: name || String(description).slice(0, 120),
    product_id: productId,
  }).select("*").single();
  if (error) throw new Error(`project creation failed: ${error.message}`);

  const diag = await startDiagSessionSafe({
    owner: ctx.owner, projectId: project.id, conversationId: ctx.conversation.id,
    kind: "app_build", prompt: String(description),
  });
  const { job } = await createJob({
    owner: { id: ctx.owner },
    projectId: project.id,
    mode: "build",
    prompt: String(description),
    diag: diag.recorderForJob({ round: 1 }),
  });

  relayBuildJob(ctx, { job, projectId: project.id, diag });
  await ctx.emit("build_started", {
    jobId: job.id,
    projectId: project.id,
    buildId: diag.id,
    message: "The team is assembling to build this.",
  });
  return { jobId: job.id, projectId: project.id, buildId: diag.id, note: "Build dispatched; the team's progress streams into this conversation." };
}

// Milestone copy for phase transitions during LONG builds — an engineering manager keeping
// the user informed, only when there's real progress to report.
const PHASE_MILESTONES = {
  designing: "Planning's done — the Designer is shaping the look and feel now.",
  building: "Design's locked in. The Builder has started implementation.",
  "quality-checking": "Implementation is in — running quality checks on the build.",
  polishing: "Checks pass. Giving the design a final polish.",
  finalizing: "Nearly there — packaging the build and preparing your preview.",
};
const MILESTONE_MIN_PHASE_MS = 2 * 60_000;   // fast builds stay quiet; the roster covers them
const REASSURE_AFTER_MS = 4 * 60_000;        // never silent for long, never noisy either

function relayBuildJob(ctx, { job, projectId, verificationAttempt = 1, diag = nullDiagSession(), repairMemory = { fingerprints: [], briefs: [] } }) {
  const jobId = job.id;
  let lastSpecialist = null;
  let phaseStartedAt = Date.now();
  let lastEventAt = Date.now();
  let reassured = false;
  const sayProgress = async (text) => {
    await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId, progress: true } });
    await ctx.emit("message", { role: "lead", text, projectId });
  };
  // Reassurance heartbeat: if nothing meaningful has happened for a while mid-build, say
  // so once, honestly — "still working…" spam is banned.
  const heartbeat = setInterval(() => {
    if (Date.now() - lastEventAt > REASSURE_AFTER_MS && !reassured) {
      reassured = true;
      sayProgress("Long stretch of deep work — the team is progressing normally; nothing needs you yet.").catch(() => {});
    }
  }, 60_000);
  heartbeat.unref?.();

  const finishSpecialist = async (ok = true) => {
    if (lastSpecialist) {
      await ctx.emit("agent_done", { agent: lastSpecialist, ok });
      lastSpecialist = null;
    }
  };

  const unsubscribe = subscribe(job, async (name, data) => {
    try {
      if (name === "phase") {
        lastEventAt = Date.now();
        reassured = false;
        const specialist = PHASE_SPECIALISTS[data.phase];
        if (!specialist) return;
        if (specialist.agent !== lastSpecialist) {
          await finishSpecialist(true);
          await ctx.emit("agent_spawned", { agent: specialist.agent, status: specialist.status });
          lastSpecialist = specialist.agent;
        } else {
          await ctx.emit("agent_status", { agent: specialist.agent, status: specialist.status });
        }
        // Milestone message only when the finished phase genuinely took a while.
        if (Date.now() - phaseStartedAt > MILESTONE_MIN_PHASE_MS && PHASE_MILESTONES[data.phase]) {
          sayProgress(PHASE_MILESTONES[data.phase]).catch(() => {});
        }
        phaseStartedAt = Date.now();
        return;
      }
      if (name === "end") {
        clearInterval(heartbeat);
        unsubscribe();
        const action = planEndAction(data, { attempt: verificationAttempt, previousFingerprints: repairMemory.fingerprints });
        await finishSpecialist(action.kind === "verify" || action.kind === "warmup");
        if (data.status === "complete") await persistBuildResult(ctx.owner, projectId, data.result);

        if (action.kind === "verify") {
          await ctx.emit("preview_ready", { url: data.result.previewUrl, projectId, message: "Preview ready — take a look." });
          // The Verification Agent gate: completion is only announced after PASS.
          runVerificationGate(ctx, { projectId, jobId, previewUrl: data.result.previewUrl, result: data.result, attempt: verificationAttempt, diag, repairMemory })
            .catch((error) => console.error("[app-build] verification:", error.message));
          return;
        }
        if (action.kind === "warmup") {
          diag.finish("complete_unverified");
          recoverPreview(ctx, projectId).catch((error) => console.error("[app-build] preview recovery:", error.message));
          const text = `${buildEndSummary(data.result)}${data.result?.finalText ? ` ${String(data.result.finalText).slice(0, 400)}` : ""}`;
          await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId } });
          await ctx.emit("message", { role: "lead", text, projectId });
          return;
        }
        if (action.kind === "repair" || action.kind === "retry") {
          // Autonomous: announce briefly, fix, re-verify. Never ask permission for routine
          // failures — but never send the identical repair brief twice either.
          const nextBrief = action.kind === "repair" ? action.brief : job.prompt;
          const briefFp = fingerprintPrompt(nextBrief);
          if (repairMemory.briefs.includes(briefFp)) {
            diag.finish("failed");
            const text = `I stopped the repair loop: it was about to send the exact same repair instructions again, which means the previous attempt didn't change the outcome.\n\n${diag.failureEvidence()}`;
            await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId, buildId: diag.id } });
            await ctx.emit("message", { role: "lead", text, projectId });
            return;
          }
          if (action.fingerprint) repairMemory.fingerprints.push(action.fingerprint);
          repairMemory.briefs.push(briefFp);
          await sayProgress(action.announcement);
          const nextRound = verificationAttempt + 1;
          diag.repairDispatched({ prompt: nextBrief, round: nextRound });
          const { job: next } = await createJob({
            owner: { id: ctx.owner }, projectId,
            mode: action.kind === "repair" ? "iterate" : (job.mode || "build"),
            prompt: nextBrief,
            trigger: "autonomous_repair",
            diag: diag.recorderForJob({ round: nextRound }),
          });
          relayBuildJob(ctx, { job: next, projectId, verificationAttempt: nextRound, diag, repairMemory });
          return;
        }
        // Genuine exhaustion — the only point control returns to the user. The message
        // carries the EXACT stored diagnostic output, never an unevidenced claim.
        diag.finish("failed");
        const blockedText = `${action.message}\n\n${diag.failureEvidence()}`;
        await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: blockedText, payload: { jobId, projectId, buildId: diag.id } });
        await ctx.emit("message", { role: "lead", text: blockedText, projectId });
        notifyOwnerIfAway(ctx.owner, ctx.conversation.id, {
          title: "Build needs a decision",
          body: "Autonomous repair is exhausted — open the conversation.",
          tag: `build-${projectId}`,
        }).catch(() => {});
      }
    } catch (error) {
      console.error("[app-build] relay:", error.message);
    }
  });
}

// The Verification Agent gate (Stuart, 2026-07-31): before ANY completion message, the
// Verifier drives the live preview like a real user. PASS → completion + ✓ summary.
// FAIL → the build is rejected, the failures go back to the Builder in surgical repair
// mode (design/layout/branding preserved), and the repaired build is re-verified — up to
// two automatic repair rounds before reporting honestly.
async function runVerificationGate(ctx, { projectId, jobId, previewUrl, result, attempt = 1, diag = nullDiagSession(), repairMemory = { fingerprints: [], briefs: [] } }) {
  const { verifyApp, repairPrompt } = await import("./verificationAgent.mjs");
  const { treeUsesBackendSdk } = await import("../appRuntimeStatus.mjs");
  await ctx.emit("agent_spawned", { agent: "Verifier", status: "Verifying the app like a real user…" });
  const verifyStarted = Date.now();
  let verdict;
  try {
    verdict = await verifyApp({ previewUrl, usesBackend: treeUsesBackendSdk(result?.tree) });
  } catch (error) {
    verdict = { pass: false, failures: [`Verification could not run: ${error.message}`], summary: "" };
  }
  diag.step({
    agent: "Verifier", kind: "verification", label: `Verification (round ${attempt})`,
    status: verdict.pass ? "ok" : "failed", round: attempt,
    output: verdict.pass ? verdict.summary : (verdict.failures || []).join("\n"),
    durationMs: Date.now() - verifyStarted,
  });

  if (verdict.pass) {
    diag.finish("passed");
    await ctx.emit("agent_done", { agent: "Verifier", ok: true });
    await ctx.emit("verification", { pass: true, summary: verdict.summary, projectId });
    const text = `Your app is built, verified, and live in this conversation.\n\n${verdict.summary}${result?.finalText ? `\n\n${String(result.finalText).slice(0, 300)}` : ""}`;
    await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId, verified: true } });
    await ctx.emit("message", { role: "lead", text, projectId });
    notifyOwnerIfAway(ctx.owner, ctx.conversation.id, {
      title: "App verified", body: "Built, tested as a real user, and live.", url: previewUrl, tag: `build-${projectId}`,
    }).catch(() => {});
    return;
  }

  await ctx.emit("agent_done", { agent: "Verifier", ok: false });
  await ctx.emit("verification", { pass: false, failures: verdict.failures, projectId });

  const failureFp = fingerprintFailure(verdict.failures);
  if (attempt <= 2 && !repairMemory.fingerprints.includes(failureFp)) {
    repairMemory.fingerprints.push(failureFp);
    const text = `Verification found real problems (${verdict.failures.slice(0, 3).join("; ")}). I'm sending it back to the Builder to repair — design untouched, minimum change.`;
    await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
    await ctx.emit("message", { role: "lead", text, projectId });
    const nextRound = attempt + 1;
    const brief = repairPrompt(verdict.failures);
    repairMemory.briefs.push(fingerprintPrompt(brief));
    diag.repairDispatched({ prompt: brief, round: nextRound });
    const { job } = await createJob({
      owner: { id: ctx.owner }, projectId, mode: "iterate",
      prompt: brief,
      trigger: "verification_repair",
      diag: diag.recorderForJob({ round: nextRound }),
    });
    relayBuildJob(ctx, { job, projectId, verificationAttempt: nextRound, diag, repairMemory });
    return;
  }

  diag.finish("failed");
  const text = `I ran the full repair loop and verification still fails:\n${verdict.failures.map((f) => `- ${f}`).join("\n")}\nThis is beyond routine repair — I need a decision from you on how to proceed.\n\n${diag.failureEvidence()}`;
  await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId, buildId: diag.id } });
  await ctx.emit("message", { role: "lead", text, projectId });
}

// Late preview recovery: the container often finishes warming up shortly after the build
// relay ends. Poll the provider, and the moment a URL exists, deliver the card + an honest
// follow-up. If it never comes up, say so — with the sentence that fixes it.
async function recoverPreview(ctx, projectId, { attempts = 9, delayMs = 20_000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const preview = await previewProvider().get(projectId);
      if (preview?.url) {
        await serviceClient().from("projects").update({ preview_ref: preview.url, updated_at: new Date().toISOString() })
          .eq("id", projectId).eq("owner", ctx.owner);
        await ctx.emit("preview_ready", { url: preview.url, projectId, message: "Preview ready — take a look." });
        const text = "Here's the preview — it needed a moment to warm up.";
        await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
        await ctx.emit("message", { role: "lead", text, projectId });
        notifyOwnerIfAway(ctx.owner, ctx.conversation.id, {
          title: "Preview ready", body: "Your app's preview is up — take a look.", url: preview.url, tag: `build-${projectId}`,
        }).catch(() => {});
        return;
      }
    } catch { /* provider hiccup — keep polling */ }
  }
  const text = "The preview infrastructure isn't responding after repeated automatic attempts — the build itself is fine, and I'll bring the preview up the moment the infrastructure recovers.";
  await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
  await ctx.emit("message", { role: "lead", text, projectId });
}

// repair_app capability backing: surgical fix on the EXISTING tree (iterate mode) with the
// preservation rules baked into the prompt. Build once, repair precisely, verify completely.
export async function repairApp(ctx, { issue, productName = null }) {
  const client = serviceClient();
  let query = client.from("projects").select("id, name, tree, product_id, updated_at")
    .eq("owner", ctx.owner).not("tree", "is", null)
    .order("updated_at", { ascending: false }).limit(1);
  if (productName) {
    const { data: product } = await client.from("ca_products")
      .select("id").eq("owner", ctx.owner).ilike("name", productName).maybeSingle();
    if (product) query = query.eq("product_id", product.id);
  }
  const { data } = await query;
  const project = data?.[0];
  if (!project) {
    const error = new Error("There's no existing app to repair — describe what you want built instead.");
    error.code = "nothing_to_repair";
    throw error;
  }
  const prompt = [
    `REPAIR MODE — fix ONLY this reported problem in the existing app "${project.name}":`,
    issue,
    "",
    "Hard rules: preserve the existing design, layout, colours, branding, UX and component",
    "structure exactly. Do NOT redesign, restyle, or rebuild anything. Make the minimum code",
    "change that fixes the reported problem. Do not touch unrelated files.",
  ].join("\n");
  const diag = await startDiagSessionSafe({
    owner: ctx.owner, projectId: project.id, conversationId: ctx.conversation.id,
    kind: "repair", prompt: String(issue),
  });
  const { job } = await createJob({
    owner: { id: ctx.owner }, projectId: project.id, mode: "iterate", prompt,
    diag: diag.recorderForJob({ round: 1 }),
  });
  relayBuildJob(ctx, { job, projectId: project.id, diag });
  await ctx.emit("build_started", { jobId: job.id, projectId: project.id, buildId: diag.id, message: "Repairing — design untouched." });
  return { jobId: job.id, projectId: project.id, buildId: diag.id, note: "Repair dispatched; the fix will be verified before completion is announced." };
}

// show_preview capability backing: (re)provision the preview for a project from its stored
// tree — heals reaped containers, warm-up timeouts, and old conversations alike.
export async function showPreview(ctx, { productName = null } = {}) {
  const client = serviceClient();
  let query = client.from("projects").select("id, name, tree, product_id, updated_at")
    .eq("owner", ctx.owner).not("tree", "is", null)
    .order("updated_at", { ascending: false }).limit(1);
  if (productName) {
    const { data: product } = await client.from("ca_products")
      .select("id").eq("owner", ctx.owner).ilike("name", productName).maybeSingle();
    if (product) query = query.eq("product_id", product.id);
  }
  const { data } = await query;
  const project = data?.[0];
  if (!project) {
    const error = new Error("There's no built app to preview yet — ask me to build something first.");
    error.code = "nothing_to_preview";
    throw error;
  }
  await ctx.emit("agent_spawned", { agent: "Publisher", status: "Bringing the preview up…" });
  try {
    const { withRuntimeEnv } = await import("../runtimeEnv.mjs");
    const preview = await previewProvider().start(project.id, withRuntimeEnv(project.tree, project.id));
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

async function persistBuildResult(owner, projectId, result) {
  if (!result?.tree) return;
  const client = serviceClient();
  const { error } = await client.from("projects").update({
    tree: result.tree,
    design_profile: result.designProfile || null,
    preview_ref: result.previewUrl || null,
    updated_at: new Date().toISOString(),
  }).eq("id", projectId).eq("owner", owner);
  if (error) console.error("[app-build] tree persistence:", error.message);
}

export async function buildJobSnapshot(ownerId, jobId) {
  const job = await getJob(ownerId, jobId);
  if (!job) return null;
  return { jobId: job.id, status: job.status, phase: job.phase, terminal: isTerminal(job) };
}
