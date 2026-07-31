// startAppBuild: the bridge between the Lead Agent and the generation pipeline.
// Creates the project row (server-mediated — the legacy client-side tree write is gone),
// dispatches a build job, and relays the pipeline's phases into the conversation as a
// staged specialist team (Principle 4) with an unprompted preview card the moment the
// preview is reachable (Principle 5). The terminal tree is persisted server-side.

import { serviceClient } from "../supabase.mjs";
import { createJob, subscribe, getJob, isTerminal } from "../buildJobs.mjs";
import { notifyOwnerIfAway } from "../notifications/notificationService.mjs";
import { previewProvider } from "../../preview/index.mjs";

// The end-of-build message NEVER claims a live preview unless a URL actually exists
// (Stuart, 2026-07-31: "a build should never claim success unless the preview is actually
// visible"). Pure and unit-tested.
export function buildEndSummary(result) {
  if (result?.buildOk === false) {
    return "The app is generated but its build check failed — I'll fix that if you say the word.";
  }
  if (!result?.previewUrl) {
    return "Your app is built. The preview is still warming up — I'll drop it into this conversation the moment it's ready.";
  }
  return "Your app is built and the preview is live in this conversation.";
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

  const { job } = await createJob({
    owner: { id: ctx.owner },
    projectId: project.id,
    mode: "build",
    prompt: String(description),
  });

  relayBuildJob(ctx, { job, projectId: project.id });
  await ctx.emit("build_started", {
    jobId: job.id,
    projectId: project.id,
    message: "The team is assembling to build this.",
  });
  return { jobId: job.id, projectId: project.id, note: "Build dispatched; the team's progress streams into this conversation." };
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

function relayBuildJob(ctx, { job, projectId, verificationAttempt = 1 }) {
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
        const ok = data.status === "complete" && data.result?.buildOk !== false;
        await finishSpecialist(ok);
        if (data.status === "complete") {
          await persistBuildResult(ctx.owner, projectId, data.result);
          if (data.result?.previewUrl) {
            // Preview-first: the card appears the moment the preview exists, unprompted.
            await ctx.emit("preview_ready", {
              url: data.result.previewUrl,
              projectId,
              message: "Preview ready — take a look.",
            });
            if (data.result?.buildOk !== false) {
              // The Verification Agent gate: completion is only announced after PASS.
              runVerificationGate(ctx, { projectId, jobId, previewUrl: data.result.previewUrl, result: data.result, attempt: verificationAttempt })
                .catch((error) => console.error("[app-build] verification:", error.message));
              return;
            }
          } else if (data.result?.buildOk !== false) {
            // Cold starts can outlive provisiond's readiness window while the container
            // keeps coming up — recover in the background and deliver the card late
            // rather than lying now.
            recoverPreview(ctx, projectId).catch((error) => console.error("[app-build] preview recovery:", error.message));
          }
          const summary = buildEndSummary(data.result);
          const text = `${summary}${data.result?.finalText ? ` ${String(data.result.finalText).slice(0, 400)}` : ""}`;
          await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId } });
          await ctx.emit("message", { role: "lead", text, projectId });
          notifyOwnerIfAway(ctx.owner, ctx.conversation.id, {
            title: "Preview ready",
            body: "Your app is built — take a look.",
            url: data.result?.previewUrl || null,
            tag: `build-${projectId}`,
          }).catch(() => {});
        } else {
          const text = `The build ${data.status}${data.error ? `: ${String(data.error).slice(0, 300)}` : "."} Tell me to try again and I will.`;
          await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId } });
          await ctx.emit("message", { role: "lead", text, projectId });
          notifyOwnerIfAway(ctx.owner, ctx.conversation.id, {
            title: "Build needs attention",
            body: "The build didn't finish — open the conversation and I'll explain.",
            tag: `build-${projectId}`,
          }).catch(() => {});
        }
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
async function runVerificationGate(ctx, { projectId, jobId, previewUrl, result, attempt = 1 }) {
  const { verifyApp, repairPrompt } = await import("./verificationAgent.mjs");
  const { treeUsesBackendSdk } = await import("../appRuntimeStatus.mjs");
  await ctx.emit("agent_spawned", { agent: "Verifier", status: "Verifying the app like a real user…" });
  let verdict;
  try {
    verdict = await verifyApp({ previewUrl, usesBackend: treeUsesBackendSdk(result?.tree) });
  } catch (error) {
    verdict = { pass: false, failures: [`Verification could not run: ${error.message}`], summary: "" };
  }

  if (verdict.pass) {
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

  if (attempt <= 2) {
    const text = `Verification found real problems (${verdict.failures.slice(0, 3).join("; ")}). I'm sending it back to the Builder to repair — design untouched, minimum change.`;
    await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
    await ctx.emit("message", { role: "lead", text, projectId });
    const { job } = await createJob({
      owner: { id: ctx.owner }, projectId, mode: "iterate",
      prompt: repairPrompt(verdict.failures),
    });
    relayBuildJob(ctx, { job, projectId, verificationAttempt: attempt + 1 });
    return;
  }

  const text = `The build is up at the preview, but verification still fails after two repair rounds:\n${verdict.failures.map((f) => `- ${f}`).join("\n")}\nTell me which to prioritise and I'll fix it with you.`;
  await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
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
  const text = "The preview couldn't be brought up automatically. Say “show me the preview” and I'll start it fresh.";
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
  const { job } = await createJob({
    owner: { id: ctx.owner }, projectId: project.id, mode: "iterate", prompt,
  });
  relayBuildJob(ctx, { job, projectId: project.id });
  await ctx.emit("build_started", { jobId: job.id, projectId: project.id, message: "Repairing — design untouched." });
  return { jobId: job.id, projectId: project.id, note: "Repair dispatched; the fix will be verified before completion is announced." };
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
