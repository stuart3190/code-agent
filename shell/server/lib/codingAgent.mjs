import { createCodingModel } from "./modelGateway.mjs";
import { augmentPromptWithContext } from "./repositoryIndexer.mjs";

const MAX_TURNS = 25;

export const CODING_TOOLS = Object.freeze([
  tool("list_files", "List repository files before deciding what to inspect.", {
    path: stringProp("Relative directory, or . for repository root"),
    depth: numberProp("Maximum directory depth, from 1 to 8"),
  }, ["path", "depth"]),
  tool("read_file", "Read one UTF-8 text file from the repository.", {
    path: stringProp("Repository-relative file path"),
  }, ["path"]),
  tool("write_file", "Create or replace one UTF-8 text file in the repository.", {
    path: stringProp("Repository-relative file path"),
    content: stringProp("Complete new file contents"),
  }, ["path", "content"]),
  tool("search", "Search repository text with a literal or regular expression.", {
    query: stringProp("Search expression"),
    path: stringProp("Relative file or directory, or ."),
  }, ["query", "path"]),
  tool("run_command", "Run a non-interactive command inside the isolated repository workspace.", {
    command: stringProp("Shell command"),
    timeout: numberProp("Timeout in seconds, from 1 to 600"),
  }, ["command", "timeout"]),
  tool("git_status", "Show concise working-tree status.", {}, []),
  tool("git_diff", "Show the current patch and change summary.", {}, []),
]);

const INSTRUCTIONS = `You are Thrallo, a careful senior software engineer operating in an isolated repository.
Complete the user's task end-to-end. Inspect before editing, preserve unrelated work, and use the smallest coherent change.
You may edit files and run non-interactive commands. Never attempt to access credentials, host metadata, or paths outside the repository.
Run relevant tests or builds before finishing. Your final response must summarize the outcome, verification, and any genuine remaining limitation.
Do not claim success when tests fail.`;

export async function runCodingAgent({
  run,
  runner,
  emit,
  isCancelled,
  provider = null,
  context = [],
  repositoryMap = [],
  tokenBudget = null,
}) {
  const model = provider || createCodingModel(run.model);
  const input = [{ role: "user", content: augmentPromptWithContext(run.prompt, context, repositoryMap) }];
  const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  let selectedProvider = model.id;
  let selectedModel = model.model;

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    if (await isCancelled()) return { cancelled: true, usage };
    await emit("model.turn_started", { turn, model: model.model, message: `Thinking · turn ${turn}` });
    const response = await model.turn({
      instructions: INSTRUCTIONS,
      input,
      tools: CODING_TOOLS,
      safetyIdentifier: run.owner,
    });
    selectedProvider = response.provider || model.id;
    selectedModel = response.model || model.model;
    if (response.routing?.fallbackFrom) {
      await emit("model.fallback", {
        fromProvider: response.routing.fallbackFrom.provider,
        fromModel: response.routing.fallbackFrom.model,
        provider: selectedProvider,
        model: selectedModel,
        reason: response.routing.reason,
        message: `Switched to ${selectedProvider} after a temporary provider failure`,
      });
    }
    mergeUsage(usage, response.usage);
    if (tokenBudget != null && usage.totalTokens > tokenBudget) {
      await emit("run.budget_exhausted", {
        message: "The monthly managed-model token allowance ran out during this run.",
        usedTokens: usage.totalTokens,
      });
      throw agentError("The monthly managed-model token allowance ran out during this run. "
        + "Upgrade your plan or connect your own provider key to continue.", "budget_exhausted", usage);
    }
    input.push(...response.output);
    const calls = response.output.filter((item) => item.type === "function_call");

    if (!calls.length) {
      const diff = await runner.diff().catch((error) => ({ exitCode: -1, output: error.message }));
      const status = await runner.status().catch((error) => ({ exitCode: -1, output: error.message }));
      await emit("assistant.message", { text: response.text || "Task completed." });
      return {
        summary: response.text || "Task completed.",
        diff: diff.output,
        status: status.output,
        provider: selectedProvider,
        model: selectedModel,
        usage,
      };
    }

    for (const call of calls) {
      if (await isCancelled()) return { cancelled: true, usage };
      let args;
      try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
      await emit("tool.started", { callId: call.call_id, name: call.name, arguments: redactArguments(call.name, args) });
      let output;
      try {
        output = await executeTool(runner, call.name, args);
        await emit("tool.completed", {
          callId: call.call_id, name: call.name, output: summarizeOutput(output),
        });
      } catch (error) {
        output = { ok: false, error: error.message, exitCode: error.exitCode ?? null };
        await emit("tool.failed", { callId: call.call_id, name: call.name, error: error.message });
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
    }
  }
  throw agentError(`Agent exceeded the ${MAX_TURNS}-turn safety limit`, "turn_limit", usage);
}

// Errors carry accumulated usage so the worker can still meter tokens spent by a failed run.
function agentError(message, code, usage) {
  const error = new Error(message);
  error.code = code;
  error.usage = { ...usage };
  return error;
}

async function executeTool(runner, name, args) {
  switch (name) {
    case "list_files": return runner.listFiles(args.path, args.depth);
    case "read_file": return { path: args.path, content: await runner.readFile(args.path) };
    case "write_file": return runner.writeFile(args.path, args.content);
    case "search": return runner.search(args.query, args.path);
    case "run_command": return runner.runCommand(args.command, args.timeout);
    case "git_status": return runner.status();
    case "git_diff": return runner.diff();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function tool(name, description, properties, required) {
  return {
    type: "function", name, description, strict: true,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

function stringProp(description) {
  return { type: "string", description };
}

function numberProp(description) {
  return { type: "number", description };
}

function mergeUsage(total, next = {}) {
  for (const key of Object.keys(total)) total[key] += Number(next[key] || 0);
}

function redactArguments(name, args) {
  if (name === "write_file") return { path: args.path, bytes: Buffer.byteLength(String(args.content || "")) };
  return args;
}

function summarizeOutput(output) {
  const value = typeof output === "string" ? output : JSON.stringify(output);
  return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
}
