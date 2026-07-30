// Thrallo CLI core. Pure logic with injected fetch/io/config so the whole command surface is
// unit-testable; cli/thrallo.mjs is the thin executable wrapper. Reuses the same
// zero-dependency API client as the VS Code extension.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { ThralloClient, describeEvent, TERMINAL_STATES } = require("../../editor/vscode/lib/api.js");
const { version: PACKAGE_VERSION } = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

const DEFAULT_SERVER = "https://app.thrallo.com";

export function configPath() {
  return path.join(os.homedir(), ".thrallo", "config.json");
}

export function loadConfig({ readFile = fs.readFileSync } = {}) {
  try {
    return JSON.parse(readFile(configPath(), "utf8"));
  } catch {
    return null;
  }
}

export function saveConfig(config, { mkdir = fs.mkdirSync, writeFile = fs.writeFileSync } = {}) {
  const file = configPath();
  mkdir(path.dirname(file), { recursive: true });
  writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return file;
}

export function deleteConfig({ rm = fs.rmSync } = {}) {
  try { rm(configPath(), { force: true }); return true; } catch { return false; }
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] || "help", positional: positional.slice(1), flags };
}

const HELP = `Thrallo CLI — cloud coding agents from your terminal

Usage: thrallo <command> [options]

  login [--server <url>] [--token <pat>]   Connect with an API token (Settings → API tokens)
  logout                                   Remove the stored credentials
  version                                  Print the Thrallo package version
  status                                   Server capabilities and connection check
  repos                                    List connected repositories
  agents                                   List agents
  usage                                    Plan, budgets, and this period's consumption
  run "<prompt>" [--agent <name>] [--repo <full/name>] [--yes]
                                           Launch a run and stream the timeline; approve the
                                           pull request when prompted (--yes auto-approves)
  review <pr#> [--repo <full/name>] [--focus "<text>"] [--yes]
                                           Review a pull request; approve to post to GitHub
  resume <runId>                           Resume a failed run from its preserved workspace
  cancel <runId>                           Cancel a run

Config is stored at ~/.thrallo/config.json (0600).`;

export async function runCli(argv, {
  fetchImpl = fetch,
  stdout = (line) => console.log(line),
  prompt = defaultPrompt,
  config = loadConfig(),
  persistConfig = saveConfig,
  removeConfig = deleteConfig,
} = {}) {
  const { command, positional, flags } = parseArgs(argv);

  if (command === "help" || flags.help) {
    stdout(HELP);
    return 0;
  }

  if (command === "version") {
    stdout(PACKAGE_VERSION);
    return 0;
  }

  if (command === "login") {
    const server = String(flags.server || config?.server || DEFAULT_SERVER);
    const token = String(flags.token || await prompt("Paste your Thrallo API token: ", { secret: true })).trim();
    if (!token.startsWith("thrallo_pat_")) {
      stdout("Tokens start with thrallo_pat_ — create one in the web workspace under Settings → API tokens.");
      return 1;
    }
    const client = new ThralloClient({ serverUrl: server, token, fetchImpl });
    await client.listAgents();
    persistConfig({ server, token });
    stdout(`Connected to ${server}.`);
    return 0;
  }

  if (command === "logout") {
    removeConfig();
    stdout("Logged out.");
    return 0;
  }

  if (!config?.token) {
    stdout("Not connected. Run: thrallo login");
    return 1;
  }
  const client = new ThralloClient({ serverUrl: config.server || DEFAULT_SERVER, token: config.token, fetchImpl });

  if (command === "status") {
    const caps = await client.capabilities();
    const { agents } = await client.listAgents();
    stdout(`${caps.product} ${caps.apiVersion} at ${config.server || DEFAULT_SERVER}`);
    stdout(`runtime ready: ${caps.ready} · store: ${caps.store} · agents: ${agents.length}`);
    stdout(`reviews: ${caps.reviews?.pullRequestReview} · automations: ${caps.automations?.pullRequestReviews}`);
    return 0;
  }

  if (command === "repos") {
    const { repositories } = await client.listRepositories();
    for (const repo of repositories) {
      stdout(`${repo.fullName}  [${repo.status}]  default: ${repo.defaultBranch}`);
    }
    if (!repositories.length) stdout("No repositories connected.");
    return 0;
  }

  if (command === "agents") {
    const [{ agents }, { repositories }] = await Promise.all([client.listAgents(), client.listRepositories()]);
    const names = new Map(repositories.map((repo) => [repo.id, repo.fullName]));
    for (const agent of agents) {
      stdout(`${agent.name}  (${agent.mode})  ${names.get(agent.repositoryId) || ""}  ${agent.id}`);
    }
    if (!agents.length) stdout("No agents yet — connect a repository in the web workspace.");
    return 0;
  }

  if (command === "usage") {
    const billing = await client.request("/api/v1/billing");
    stdout(`Plan: ${billing.subscription.planName} (${billing.subscription.status})${billing.pastDue ? " — PAST DUE, metered at Free limits" : ""}`);
    for (const [name, meter] of Object.entries(billing.budgets)) {
      stdout(`  ${name}: ${meter.used.toLocaleString()} / ${meter.limit.toLocaleString()}`);
    }
    stdout(`Period resets ${billing.period.end}`);
    return 0;
  }

  if (command === "run") {
    const promptText = positional.join(" ").trim();
    if (!promptText) {
      stdout("Usage: thrallo run \"<prompt>\" [--agent <name>] [--repo <full/name>] [--yes]");
      return 1;
    }
    const agent = await resolveAgent(client, flags, stdout);
    if (!agent) return 1;
    const { run } = await client.createRun(agent.id, promptText, agent.mode || "agent");
    return followRun(client, run.id, { stdout, prompt, autoApprove: !!flags.yes });
  }

  if (command === "review") {
    const pullNumber = Math.floor(Number(positional[0]));
    if (!Number.isFinite(pullNumber) || pullNumber <= 0) {
      stdout("Usage: thrallo review <pr#> [--repo <full/name>] [--focus \"<text>\"] [--yes]");
      return 1;
    }
    const agent = await resolveAgent(client, { ...flags, mode: "review" }, stdout);
    if (!agent) return 1;
    const { run } = await client.request(`/api/v1/agents/${agent.id}/runs`, {
      method: "POST",
      body: JSON.stringify({
        prompt: String(flags.focus || `Review pull request #${pullNumber}.`),
        mode: "review",
        model: "auto",
        pullRequestNumber: pullNumber,
      }),
    });
    return followRun(client, run.id, { stdout, prompt, autoApprove: !!flags.yes });
  }

  if (command === "resume") {
    const runId = String(positional[0] || "");
    if (!runId) { stdout("Usage: thrallo resume <runId>"); return 1; }
    const { run } = await client.resumeRun(runId);
    stdout(`Resumed as ${run.id}`);
    return followRun(client, run.id, { stdout, prompt, autoApprove: !!flags.yes });
  }

  if (command === "cancel") {
    const runId = String(positional[0] || "");
    if (!runId) { stdout("Usage: thrallo cancel <runId>"); return 1; }
    const { run } = await client.cancelRun(runId);
    stdout(`Run ${run.id}: ${run.state}`);
    return 0;
  }

  stdout(`Unknown command: ${command}\n`);
  stdout(HELP);
  return 1;
}

async function resolveAgent(client, flags, stdout) {
  const [{ agents }, { repositories }] = await Promise.all([client.listAgents(), client.listRepositories()]);
  const wantedMode = flags.mode === "review" ? "review" : null;
  let candidates = wantedMode ? agents.filter((agent) => agent.mode === wantedMode) : agents;

  if (flags.agent) {
    const needle = String(flags.agent).toLowerCase();
    const found = agents.find((agent) => agent.id === flags.agent
      || agent.name.toLowerCase() === needle);
    if (!found) { stdout(`No agent named "${flags.agent}".`); return null; }
    return found;
  }
  if (flags.repo) {
    const repo = repositories.find((entry) => entry.fullName.toLowerCase() === String(flags.repo).toLowerCase());
    if (!repo) { stdout(`Repository ${flags.repo} is not connected.`); return null; }
    const inRepo = candidates.filter((agent) => agent.repositoryId === repo.id);
    if (inRepo.length) return inRepo[0];
    if (wantedMode === "review") {
      const created = await client.request("/api/v1/agents", {
        method: "POST",
        body: JSON.stringify({ repositoryId: repo.id, name: "Reviewer", mode: "review" }),
      });
      return created.agent;
    }
    const any = agents.filter((agent) => agent.repositoryId === repo.id);
    if (any.length) return any[0];
    stdout(`No agents exist for ${flags.repo}; create one in the web workspace.`);
    return null;
  }
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length && wantedMode === "review" && repositories.length === 1) {
    const created = await client.request("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify({ repositoryId: repositories[0].id, name: "Reviewer", mode: "review" }),
    });
    return created.agent;
  }
  if (!candidates.length) { stdout("No matching agents; use --repo or --agent."); return null; }
  stdout("Multiple agents available — pick one with --agent <name> or --repo <full/name>:");
  for (const agent of candidates) stdout(`  ${agent.name} (${agent.mode})`);
  return null;
}

async function followRun(client, runId, { stdout, prompt, autoApprove }) {
  stdout(`Run ${runId}`);
  try {
    await client.streamRunEvents(runId, (event) => stdout(`  ${describeEvent(event)}`));
  } catch (error) {
    stdout(`  stream ended: ${error.message}`);
  }
  const { run } = await client.getRun(runId);
  if (!run) return 1;

  if (run.state === "waiting_for_approval") {
    const isReview = run.result?.approval?.action === "post_review";
    stdout("");
    if (isReview) {
      stdout(`Review ready — verdict: ${run.result.verdict}, ${(run.result.findings || []).length} findings.`);
      for (const finding of run.result.findings || []) {
        stdout(`  [${finding.severity}] ${finding.path}${finding.line ? `:${finding.line}` : ""} — ${finding.title}`);
      }
    } else {
      stdout("Changes ready. Approving will commit, push, and open a pull request.");
    }
    const approve = autoApprove
      || /^y/i.test(String(await prompt(isReview ? "Post this review to GitHub? [y/N] " : "Approve and open the pull request? [y/N] ")));
    if (!approve) {
      await client.cancelRun(runId);
      stdout("Declined; workspace discarded.");
      return 0;
    }
    const published = (await client.publishRun(runId)).run;
    const pr = published.result?.publication?.pullRequest;
    const review = published.result?.publication?.review;
    if (pr?.url) stdout(`Pull request #${pr.number}: ${pr.url}`);
    if (review?.url) stdout(`Review posted: ${review.url}`);
    return 0;
  }

  if (run.state === "succeeded") {
    stdout(`Succeeded: ${String(run.result?.summary || "done").slice(0, 300)}`);
    return 0;
  }
  if (TERMINAL_STATES.has(run.state)) {
    stdout(`${run.state}: ${run.error || "no details"}`);
    if (run.resumable) stdout(`The workspace is preserved — resume with: thrallo resume ${runId}`);
    return 1;
  }
  stdout(`Run is ${run.state}.`);
  return 0;
}

async function defaultPrompt(question, { secret = false } = {}) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (secret && process.stdin.isTTY) process.stdout.write("(input hidden not supported; token will echo)\n");
  const answer = await rl.question(question);
  rl.close();
  return answer;
}
