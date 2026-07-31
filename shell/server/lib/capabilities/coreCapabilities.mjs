// Core capabilities registered with the Capability Registry at boot. Each is a plugin-shaped
// module entry — the Lead Agent discovers all of them through the registry, never through
// hardcoded branches (docs/PRINCIPLES.md, Platform Architecture 1–2).

import { registerCapability } from "../capabilityRegistry.mjs";
import { codeAgentStore } from "../codeAgentStore.mjs";
import { assertRunWithinBudget, assertWithinRateLimits, budgetOverview } from "../usageBudgets.mjs";
import { activeAiProviderName } from "../aiCredentialStore.mjs";
import { publicRun } from "../codeAgentContracts.mjs";
import { startAppBuild, showPreview } from "../appBuild/appBuildService.mjs";
import { publishApp, connectDomain, publishConfigured } from "../appBuild/appPublishService.mjs";
import { openAIConfigured } from "../openAIProvider.mjs";
import { anthropicConfigured } from "../anthropicCodingProvider.mjs";
import { automationsStore, nextRunAt } from "../automationsStore.mjs";
import { parseAutomationInput, publicAutomation } from "../automationService.mjs";

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
    id: "app_build",
    specialist: "Builder",
    statusText: "Assembling the build team…",
    description: "Create a complete new application from a description: the team designs it, writes the code on a modern stack it chooses itself, verifies it builds, and serves a live preview into this conversation. Use for any 'build me a…' outcome that is not a change to an existing connected repository. Write the description as a full product brief — the user never chooses technology.",
    costProfile: "run",
    inputSchema: strings({
      description: str("Complete product brief: what the app does, who uses it, key screens/flows, branding hints from memory"),
      productName: optionalStr("Short product name (creates/updates the named product in memory)"),
    }),
    requirements: () => (openAIConfigured() || anthropicConfigured()
      ? { ok: true }
      : { ok: false, reason: "No build-capable model is configured." }),
    async invoke(ctx, input) {
      // Managed builds need remaining budget; BYOK owners build on their own key.
      const credentialProvider = await activeAiProviderName(ctx.owner).catch(() => "managed");
      if (!["anthropic", "openai"].includes(credentialProvider)) {
        const overview = await budgetOverview(ctx.owner, { store: codeAgentStore() });
        if (!overview.unlimited && overview.budgets.managedTokens.remaining <= 0) {
          const error = new Error("The monthly managed-model allowance is used up; builds need budget or a BYOK key.");
          error.code = "budget_exceeded";
          throw error;
        }
      }
      return startAppBuild(ctx, {
        description: String(input.description),
        productName: input.productName || null,
      });
    },
  });

  registerCapability({
    id: "show_preview",
    specialist: "Publisher",
    statusText: "Bringing the preview up…",
    description: "Bring up (or revive) the live preview of the user's most recent built app — previews idle out, and a fresh one starts from the stored code. Use whenever the user asks to see, reopen, or fix a missing/broken preview. The preview card lands in the conversation automatically.",
    costProfile: "free",
    inputSchema: strings({
      productName: optionalStr("Which product's preview, when the conversation has several"),
    }),
    requirements: () => (publishConfigured() ? { ok: true } : { ok: false, reason: "Preview infrastructure is not configured." }),
    async invoke(ctx, input) {
      return showPreview(ctx, { productName: input.productName || null });
    },
  });

  registerCapability({
    id: "open_view",
    specialist: "Lead Agent",
    statusText: "Opening it…",
    description: "Instantly open a rich visual surface in the user's Thrallo window when it serves their goal better than prose: 'repos' (connect GitHub, repository status, indexing, policies, open pull requests), 'usage' (budgets, plan, spend guards, usage records), 'ops' (admin-only platform telemetry). Use whenever the user asks to see, manage, or connect these things — then narrate briefly. Never describe data the view already shows.",
    costProfile: "free",
    inputSchema: strings({
      view: { type: "string", enum: ["repos", "usage", "ops"], description: "Which surface to open" },
    }),
    async invoke(ctx, input) {
      await ctx.emit("open_view", { view: input.view });
      return { opened: input.view, note: "The view is open on the user's screen — narrate briefly, do not repeat its contents." };
    },
  });

  registerCapability({
    id: "publish",
    specialist: "Publisher",
    statusText: "Publishing…",
    description: "Take the user's built app live at a real https URL (their-name.app.thrallo.com). Use when the user asks to publish, ship, go live, or share their app publicly. The user asking IS the approval — never ask them to confirm again.",
    costProfile: "run",
    inputSchema: strings({
      siteName: optionalStr("Preferred site name for the URL (slugified); defaults to the app's name"),
      productName: optionalStr("Which product to publish when the conversation has several"),
    }),
    requirements: () => (publishConfigured() ? { ok: true } : { ok: false, reason: "Publishing infrastructure is not configured." }),
    async invoke(ctx, input) {
      return publishApp(ctx, { siteName: input.siteName || null, productName: input.productName || null });
    },
  });

  registerCapability({
    id: "configure_domain",
    specialist: "Publisher",
    statusText: "Connecting the domain…",
    description: "Connect the user's own domain (e.g. mybusiness.com) to their published app. Returns the DNS record they must set; certificates issue automatically once DNS points at Thrallo. Requires the app to be published first.",
    costProfile: "free",
    inputSchema: strings({
      domain: str("The domain to connect, e.g. mybusiness.com"),
      productName: optionalStr("Which product's site to attach it to"),
    }),
    requirements: () => (publishConfigured() ? { ok: true } : { ok: false, reason: "Publishing infrastructure is not configured." }),
    async invoke(ctx, input) {
      return connectDomain(ctx, { domain: input.domain, productName: input.productName || null });
    },
  });

  registerCapability({
    id: "create_automation",
    specialist: "Planner",
    statusText: "Setting up the automation…",
    description: "Create a standing automation on a connected repository: automatic review of every new pull request (kind pr_review), or a recurring scheduled task described in plain English (kind scheduled_task, runs every intervalHours). Use when the user wants something to happen automatically from now on.",
    costProfile: "free",
    inputSchema: strings({
      repositoryFullName: optionalStr("owner/name of the connected repository; null if only one is connected"),
      kind: { type: "string", enum: ["pr_review", "scheduled_task"], description: "What kind of automation" },
      instructions: optionalStr("What the automation should focus on or do, in plain English"),
      intervalHours: optionalNum("For scheduled tasks: how often to run, in hours (1-168)"),
    }),
    async invoke(ctx, input) {
      const store = codeAgentStore();
      const repositories = (await store.listRepositories(ctx.owner)).filter((r) => r.status === "ready");
      let repository = null;
      if (input.repositoryFullName) {
        repository = repositories.find((r) => r.full_name.toLowerCase() === String(input.repositoryFullName).toLowerCase()) || null;
        if (!repository) throw withCode(new Error(`Repository ${input.repositoryFullName} is not connected.`), "repository_not_found");
      } else if (repositories.length === 1) {
        repository = repositories[0];
      } else {
        throw withCode(new Error("Specify which connected repository this automation is for."), "ambiguous_repository");
      }
      if (input.kind === "pr_review" && !repository.installation_id) {
        throw withCode(new Error("Automatic PR review needs the GitHub App connection on that repository."), "github_installation_required");
      }
      const parsed = parseAutomationInput({
        kind: input.kind,
        intervalHours: input.intervalHours ?? undefined,
        config: { prompt: String(input.instructions || "").slice(0, 10_000) },
      });
      const row = await automationsStore().create(ctx.owner, {
        ...parsed,
        repository_id: repository.id,
        next_run_at: parsed.kind === "scheduled_task" ? nextRunAt(parsed.interval_hours) : null,
      });
      await ctx.emit("run_linked", {
        runId: null, repository: repository.full_name, mode: "automation",
        message: parsed.kind === "pr_review"
          ? `Every new pull request on ${repository.full_name} now gets an automatic review.`
          : `Scheduled task created on ${repository.full_name} — every ${parsed.interval_hours}h.`,
      });
      return { automation: publicAutomation(row) };
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
