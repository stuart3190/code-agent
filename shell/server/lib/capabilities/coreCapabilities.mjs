// Core capabilities registered with the Capability Registry at boot. Each is a plugin-shaped
// module entry — the Lead Agent discovers all of them through the registry, never through
// hardcoded branches (docs/PRINCIPLES.md, Platform Architecture 1–2).

import { registerCapability } from "../capabilityRegistry.mjs";
import { codeAgentStore } from "../codeAgentStore.mjs";
import { assertRunWithinBudget, assertWithinRateLimits, budgetOverview } from "../usageBudgets.mjs";
import { activeAiProviderName } from "../aiCredentialStore.mjs";
import { publicRun } from "../codeAgentContracts.mjs";

// Strict tool schemas (OpenAI Responses) require EVERY property in `required`; optionality
// is expressed as a nullable type, and invokes treat null as absent.
const strings = (properties) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const str = (description) => ({ type: "string", description });
const optionalStr = (description) => ({ type: ["string", "null"], description: `${description} (null when not applicable)` });
const optionalNum = (description) => ({ type: ["number", "null"], description: `${description} (null when not applicable)` });

export function registerCoreCapabilities() {
  registerCapability({
    id: "create_plan",
    specialist: "Planner",
    statusText: "Planning architecture…",
    description: "Record the implementation plan for the current request before building. Steps are plain English, outcome-focused.",
    costProfile: "free",
    inputSchema: strings({
      title: str("Short name for what is being planned"),
      steps: { type: "array", items: { type: "string" }, description: "Ordered plain-English steps" },
    }),
    async invoke(ctx, input) {
      await ctx.emit("plan.created", {
        title: String(input.title || "Plan").slice(0, 200),
        steps: (input.steps || []).slice(0, 20).map((step) => String(step).slice(0, 300)),
      });
      return { recorded: true };
    },
  });

  registerCapability({
    id: "repo_change",
    specialist: "Builder",
    statusText: "Working in the repository…",
    description: "Make a code change in one of the user's connected GitHub repositories: an autonomous cloud run that edits code, runs tests, and prepares a pull request. Use for fixes, features, and refactors on existing repositories.",
    costProfile: "run",
    inputSchema: strings({
      repositoryFullName: optionalStr("owner/name of the connected repository; null if only one is connected"),
      task: str("What to change, as a complete engineering brief"),
    }),
    async invoke(ctx, input) {
      const run = await dispatchRun(ctx, input, "agent");
      return { runId: run.id, state: run.state, note: "Run dispatched; progress streams into this conversation." };
    },
  });

  registerCapability({
    id: "repo_review",
    specialist: "Reviewer",
    statusText: "Reviewing code…",
    description: "Run a read-only repository-aware review: either of an open pull request (give pullRequestNumber) or a general audit. Produces structured findings; posting to GitHub stays approval-gated.",
    costProfile: "run",
    inputSchema: strings({
      repositoryFullName: optionalStr("owner/name of the connected repository; null if only one is connected"),
      focus: str("What the review should focus on"),
      pullRequestNumber: optionalNum("Open PR number to review; null for a general audit"),
    }),
    async invoke(ctx, input) {
      const run = await dispatchRun(ctx, {
        repositoryFullName: input.repositoryFullName,
        task: input.focus,
        pullRequestNumber: input.pullRequestNumber,
      }, "review");
      return { runId: run.id, state: run.state };
    },
  });

  registerCapability({
    id: "get_status",
    specialist: "Lead Agent",
    statusText: "Checking status…",
    description: "Get the user's current platform status: recent runs and their states, and remaining monthly budgets. Use to answer questions like 'what's running?' or 'how much budget is left?'.",
    costProfile: "free",
    inputSchema: strings({}, []),
    async invoke(ctx) {
      const store = codeAgentStore();
      const [agents, overview] = await Promise.all([
        store.listAgents(ctx.owner),
        budgetOverview(ctx.owner),
      ]);
      const latest = [];
      for (const agent of agents.slice(0, 8)) {
        const run = await store.getLatestRun(ctx.owner, agent.id);
        if (run) latest.push({ agent: agent.name, run: compactRun(run) });
      }
      return {
        runs: latest,
        budgets: overview.budgets,
        plan: overview.plan.id,
      };
    },
  });

  registerCapability({
    id: "remember",
    specialist: "Lead Agent",
    statusText: "Noting that down…",
    description: "Persist something important about the user or a product so it is never asked again: preferences (style, colours, frameworks, auth, deployment), facts about their companies/products, or an episode summary. Use proactively whenever the user reveals a durable preference or fact.",
    costProfile: "free",
    inputSchema: strings({
      kind: { type: "string", enum: ["preference", "fact", "episode"], description: "What kind of memory this is" },
      content: str("The thing to remember, written so it is useful months later without context"),
      productName: optionalStr("Product this belongs to (creates/updates the named product)"),
    }),
    async invoke(ctx, input) {
      let productId = null;
      if (input.productName?.trim()) {
        const product = await ctx.conversations.upsertProduct(ctx.owner, input.productName.trim().slice(0, 120));
        productId = product.id;
        if (!ctx.conversation.product_id) {
          await ctx.conversations.updateConversation(ctx.conversation, { product_id: product.id });
        }
      }
      await ctx.conversations.addMemory(ctx.owner, {
        kind: input.kind,
        content: String(input.content).slice(0, 4_000),
        product_id: productId,
      });
      return { remembered: true };
    },
  });

  registerCapability({
    id: "ask_business_question",
    specialist: "Lead Agent",
    statusText: "Checking with you…",
    description: "Pause and ask the user ONE question. ONLY for genuine business decisions — never technical choices (frameworks, databases, auth, hosting, structure: you decide those). The businessConsequence field must state what business outcome depends on the answer.",
    costProfile: "free",
    inputSchema: strings({
      question: str("The question, in plain language"),
      businessConsequence: str("What business outcome depends on this answer (required; technical convenience does not qualify)"),
    }),
    async invoke(ctx, input) {
      const consequence = String(input.businessConsequence || "").trim();
      if (consequence.length < 10) {
        const error = new Error("Rejected: ask_business_question requires a genuine business consequence. Decide technical matters yourself.");
        error.code = "not_a_business_question";
        throw error;
      }
      return { __pause: "waiting_user", question: String(input.question).slice(0, 1_000), businessConsequence: consequence };
    },
  });
}

// Shared run dispatch used by repo_change / repo_review: budget+rate admission, repository
// resolution, find-or-create agent, run creation linked to the conversation.
async function dispatchRun(ctx, input, mode) {
  const store = codeAgentStore();
  const credentialProvider = await activeAiProviderName(ctx.owner).catch(() => "managed");
  await assertWithinRateLimits(ctx.owner, { store });
  await assertRunWithinBudget(ctx.owner, { credentialProvider, store });

  const repositories = await store.listRepositories(ctx.owner);
  const ready = repositories.filter((repo) => repo.status === "ready");
  let repository = null;
  if (input.repositoryFullName) {
    repository = ready.find((repo) =>
      repo.full_name.toLowerCase() === String(input.repositoryFullName).toLowerCase()) || null;
    if (!repository) throw withCode(new Error(`Repository ${input.repositoryFullName} is not connected.`), "repository_not_found");
  } else if (ready.length === 1) {
    repository = ready[0];
  } else if (!ready.length) {
    throw withCode(new Error("No repository is connected yet. Ask the user to connect one at app.thrallo.com → Repositories."), "no_repository");
  } else {
    throw withCode(new Error(`Multiple repositories are connected (${ready.map((r) => r.full_name).join(", ")}); specify repositoryFullName.`), "ambiguous_repository");
  }

  const wanted = mode === "review" ? "review" : "agent";
  const agents = await store.listAgents(ctx.owner);
  let agent = agents.find((a) => a.repository_id === repository.id && a.mode === wanted);
  if (!agent) {
    agent = await store.createAgent(ctx.owner, {
      repository_id: repository.id,
      name: wanted === "review" ? "Reviewer" : "Builder",
      mode: wanted,
    });
  }
  const run = await store.createRun(ctx.owner, agent, repository, {
    prompt: String(input.task).slice(0, 50_000),
    mode: wanted,
    model: "auto",
    ...(input.pullRequestNumber ? { pull_request: Math.floor(Number(input.pullRequestNumber)) } : {}),
  });
  await ctx.emit("run_linked", {
    runId: run.id,
    repository: repository.full_name,
    mode: wanted,
    message: `${mode === "review" ? "Review" : "Build"} run started on ${repository.full_name}`,
  });
  ctx.relayRun?.(run.id);
  return publicRun(run);
}

function compactRun(run) {
  return { id: run.id, state: run.state, prompt: String(run.prompt || "").slice(0, 120), updatedAt: run.updated_at };
}

function withCode(error, code) {
  error.code = code;
  return error;
}
