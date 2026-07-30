// startAppBuild: the bridge between the Lead Agent and the generation pipeline.
// Creates the project row (server-mediated — the legacy client-side tree write is gone),
// dispatches a build job, and relays the pipeline's phases into the conversation as a
// staged specialist team (Principle 4) with an unprompted preview card the moment the
// preview is reachable (Principle 5). The terminal tree is persisted server-side.

import { serviceClient } from "../supabase.mjs";
import { createJob, subscribe, getJob, isTerminal } from "../buildJobs.mjs";

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

function relayBuildJob(ctx, { job, projectId }) {
  const jobId = job.id;
  let lastSpecialist = null;

  const finishSpecialist = async (ok = true) => {
    if (lastSpecialist) {
      await ctx.emit("agent_done", { agent: lastSpecialist, ok });
      lastSpecialist = null;
    }
  };

  const unsubscribe = subscribe(job, async (name, data) => {
    try {
      if (name === "phase") {
        const specialist = PHASE_SPECIALISTS[data.phase];
        if (!specialist) return;
        if (specialist.agent !== lastSpecialist) {
          await finishSpecialist(true);
          await ctx.emit("agent_spawned", { agent: specialist.agent, status: specialist.status });
          lastSpecialist = specialist.agent;
        } else {
          await ctx.emit("agent_status", { agent: specialist.agent, status: specialist.status });
        }
        return;
      }
      if (name === "end") {
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
          }
          const summary = data.result?.buildOk === false
            ? "The app is generated but its build check failed — I'll fix that if you say the word."
            : "Your app is built and the preview is live in this conversation.";
          const text = `${summary}${data.result?.finalText ? ` ${String(data.result.finalText).slice(0, 400)}` : ""}`;
          await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId } });
          await ctx.emit("message", { role: "lead", text, projectId });
        } else {
          const text = `The build ${data.status}${data.error ? `: ${String(data.error).slice(0, 300)}` : "."} Tell me to try again and I will.`;
          await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId } });
          await ctx.emit("message", { role: "lead", text, projectId });
        }
      }
    } catch (error) {
      console.error("[app-build] relay:", error.message);
    }
  });
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
