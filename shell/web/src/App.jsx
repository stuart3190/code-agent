import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./lib/useSession.js";
import { backend } from "./lib/backend.js";
import {
  addAgent, addRepository, cancelRun, capabilities, createRun, getLatestRun, getRun,
  connectGithubRepository, githubInstallationRepositories, githubInstallations,
  listAgents, listRepositories, publishRun, refreshRepositoryIndex, repositoryFileGraph,
  repositoryIndex, retryRun, runArtifacts, searchRepository, searchRepositorySymbols,
  startGithubInstallation,
  streamRunEvents, usageSummary,
  billingOverview, billingPortal, opsTelemetry, selectPlan, updateBudgets,
  artifactContent, resumeRun, updateAgent,
  repositoryPulls,
  createAutomation, deleteAutomation, listAutomations, updateAutomation,
} from "./lib/codeAgentApi.js";
import Landing from "./landing/Landing.jsx";
import ResetPassword from "./auth/ResetPassword.jsx";
import { Logo } from "./auth/AuthGate.jsx";
import AiProviderSettings from "./settings/AiProviderSettings.jsx";
import ApiTokens from "./settings/ApiTokens.jsx";

const terminalStates = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const nav = [
  ["agents", "Agents", "⌁"], ["repositories", "Repositories", "⌘"], ["automations", "Automations", "↻"],
  ["reviews", "Reviews", "✓"], ["usage", "Usage", "◫"], ["downloads", "Downloads", "↓"],
];

export default function App() {
  const { user, loading, recovery, clearRecovery } = useSession();
  const [view, setView] = useState("agents");
  const [repos, setRepos] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [caps, setCaps] = useState(null);
  const [opsSnapshot, setOpsSnapshot] = useState(null);
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef(null);

  const selectedAgent = agents.find((item) => item.id === selectedAgentId) || null;
  const selectedRepo = repos.find((item) => item.id === selectedAgent?.repositoryId) || null;

  const refresh = useCallback(async () => {
    if (!user) return;
    const [repoResult, agentResult, capabilityResult] = await Promise.all([
      listRepositories(), listAgents(), capabilities(),
    ]);
    setRepos(repoResult.repositories);
    setAgents(agentResult.agents);
    setCaps(capabilityResult);
    setSelectedAgentId((current) => current || agentResult.agents[0]?.id || null);
    opsTelemetry().then(setOpsSnapshot).catch(() => setOpsSnapshot(null));
  }, [user]);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    return () => streamRef.current?.abort();
  }, [refresh]);

  useEffect(() => {
    if (!selectedAgentId) {
      setRun(null);
      setArtifacts([]);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const hydrate = async () => {
      try {
        const result = await getLatestRun(selectedAgentId);
        if (cancelled) return;
        setRun(result.run);
        setArtifacts(result.run ? (await runArtifacts(result.run.id)).artifacts : []);
        if (result.run && !terminalStates.has(result.run.state) && result.run.state !== "waiting_for_approval") {
          timer = setTimeout(hydrate, 2_000);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    hydrate();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedAgentId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github") === "connected") {
      setView("repositories");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  if (loading) return <Splash />;
  if (recovery && user) return <ResetPassword onDone={clearRecovery} />;
  if (!user) return <Landing />;

  async function launchRun(create) {
    if (busy) return;
    setBusy(true); setError(""); setEvents([]); setArtifacts([]);
    streamRef.current?.abort();
    const controller = new AbortController();
    streamRef.current = controller;
    try {
      const created = await create();
      setRun(created.run);
      await streamRunEvents(created.run.id, (event) => {
        setEvents((current) => [...current, event]);
        if (event.type.startsWith("run.") && terminalStates.has(event.type.slice(4))) {
          getRun(created.run.id).then((result) => setRun(result.run)).catch(() => {});
          runArtifacts(created.run.id).then((result) => setArtifacts(result.artifacts)).catch(() => {});
        }
      }, { signal: controller.signal });
      setRun((await getRun(created.run.id)).run);
      setArtifacts((await runArtifacts(created.run.id)).artifacts);
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally { setBusy(false); }
  }

  async function runTask() {
    if (!selectedAgent || !prompt.trim() || busy) return;
    const task = prompt;
    await launchRun(async () => {
      const created = await createRun(selectedAgent.id, { prompt: task, mode: selectedAgent.mode, model: "auto" });
      setPrompt("");
      return created;
    });
  }

  async function retryCurrentRun() {
    if (!run || busy) return;
    await launchRun(() => retryRun(run.id));
  }

  async function resumeCurrentRun() {
    if (!run?.resumable || busy) return;
    await launchRun(() => resumeRun(run.id));
  }

  async function saveAgentPolicy(agentId, patch) {
    const updated = await updateAgent(agentId, patch);
    setAgents((items) => items.map((item) => (item.id === agentId ? updated.agent : item)));
  }

  async function stopRun() {
    if (!run) return;
    setRun((await cancelRun(run.id)).run);
  }

  async function publishCurrentRun() {
    if (!run || run.state !== "waiting_for_approval" || busy) return;
    setBusy(true); setError("");
    try {
      setRun((await publishRun(run.id)).run);
    } catch (e) {
      setError(e.message);
      setRun((await getRun(run.id)).run);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full min-h-0 bg-[#07080b] text-slate-200">
      <div className="grid h-full min-h-0 grid-cols-[230px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-white/[0.07] bg-[#0b0d12]">
          <div className="flex h-16 items-center gap-2.5 border-b border-white/[0.06] px-5">
            <Logo />
            <span className="font-display font-semibold tracking-tight text-white">Thrallo</span>
            <span className="ml-auto rounded border border-violet-400/20 bg-violet-400/10 px-1.5 py-0.5 font-mono text-[9px] text-violet-300">ALPHA</span>
          </div>
          <nav className="flex-1 space-y-1 px-3 py-4">
            {[...nav, ...(opsSnapshot ? [["ops", "Operations", "◉"]] : [])].map(([id, label, icon]) => (
              <button key={id} onClick={() => setView(id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                  view === id ? "bg-white/[0.07] text-white" : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300"
                }`}>
                <span className="w-4 text-center font-mono text-xs">{icon}</span>{label}
                {id === "agents" && agents.length > 0 && <span className="ml-auto text-[10px] text-slate-600">{agents.length}</span>}
              </button>
            ))}
          </nav>
          <div className="border-t border-white/[0.06] p-3">
            <button onClick={() => setView("settings")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-white/[0.04] hover:text-slate-300">
              <span>⚙</span> Settings
            </button>
            <div className="mt-2 flex items-center gap-3 px-3 py-2">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 text-[10px] font-bold text-white">
                {(user.email || "CA").slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{user.email}</span>
              <button title="Sign out" onClick={() => backend().auth.signOut()} className="text-slate-600 hover:text-white">↗</button>
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col">
          <header className="flex h-16 shrink-0 items-center border-b border-white/[0.07] px-6">
            <div>
              <div className="text-sm font-medium text-white">{viewLabel(view)}</div>
              <div className="text-[11px] text-slate-600">{view === "agents" ? selectedRepo?.fullName || "Cloud coding workspace" : "Thrallo control plane"}</div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <StatusDot ok={caps?.ready} label={caps?.ready ? "Runtime ready" : "Setup required"} />
              {view === "agents" && <button onClick={() => setView("repositories")} className="btn-ghost !border-white/10 !px-3 !py-1.5 text-xs">Connect repository</button>}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-auto">
            {error && <div className="mx-6 mt-5 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-4 py-3 text-sm text-red-300">{error}</div>}
            {view === "agents" && (
              <AgentWorkspace repos={repos} agents={agents} selectedAgent={selectedAgent}
                onSelect={setSelectedAgentId} events={events} run={run} prompt={prompt}
                setPrompt={setPrompt} onRun={runTask} onCancel={stopRun} busy={busy}
                caps={caps} artifacts={artifacts} onRetry={retryCurrentRun}
                onPublish={publishCurrentRun} onResume={resumeCurrentRun}
                onPolicyChange={saveAgentPolicy}
                onConnect={() => setView("repositories")} />
            )}
            {view === "repositories" && (
              <Repositories repos={repos} caps={caps} onAdded={async (repo) => {
                setRepos((items) => [repo, ...items.filter((x) => x.id !== repo.id)]);
                const created = await addAgent({ repositoryId: repo.id, name: repo.fullName.split("/")[1], mode: "agent" });
                setAgents((items) => [created.agent, ...items]);
                setSelectedAgentId(created.agent.id); setView("agents");
              }} />
            )}
            {view === "reviews" && (
              <Reviews repos={repos} agents={agents} onAgentCreated={(agent) => setAgents((items) => [agent, ...items])} />
            )}
            {view === "automations" && <Automations repos={repos} />}
            {view === "usage" && <Usage />}
            {view === "ops" && <Operations initial={opsSnapshot} />}
            {view === "settings" && (
              <div>
                <AiProviderSettings />
                <div className="mx-auto max-w-5xl px-8 pb-10"><ApiTokens /></div>
              </div>
            )}
            {view === "downloads" && <Downloads />}
            {!["agents", "repositories", "reviews", "automations", "usage", "ops", "downloads", "settings"].includes(view) && <ComingSoon view={view} caps={caps} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function AgentWorkspace({ repos, agents, selectedAgent, onSelect, events, run, prompt, setPrompt, onRun, onCancel, busy, caps, artifacts, onRetry, onPublish, onResume, onPolicyChange, onConnect }) {
  if (!repos.length) return <EmptyState onConnect={onConnect} />;

  return (
    <div className="grid min-h-full grid-cols-[260px_minmax(380px,1fr)_minmax(300px,0.8fr)]">
      <section className="border-r border-white/[0.06] bg-[#090b0f] p-4">
        <div className="mb-3 flex items-center justify-between px-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">Agents</span>
          <span className="text-xs text-slate-700">+</span>
        </div>
        <div className="space-y-1">
          {agents.map((agent) => (
            <button key={agent.id} onClick={() => onSelect(agent.id)}
              className={`w-full rounded-lg border px-3 py-3 text-left ${
                selectedAgent?.id === agent.id ? "border-blue-400/20 bg-blue-400/[0.07]" : "border-transparent hover:bg-white/[0.03]"
              }`}>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="truncate text-sm text-slate-200">{agent.name}</span>
              </div>
              <div className="mt-1.5 pl-4 font-mono text-[10px] uppercase tracking-wide text-slate-600">{agent.mode} mode</div>
            </button>
          ))}
        </div>
        {selectedAgent && <AgentPolicy key={selectedAgent.id} agent={selectedAgent} onChange={onPolicyChange} />}
      </section>

      <section className="flex min-h-[calc(100vh-4rem)] min-w-0 flex-col border-r border-white/[0.06]">
        <div className="flex-1 space-y-3 overflow-auto p-6">
          {!events.length && (
            <div className="mx-auto mt-[12vh] max-w-lg text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-blue-400/20 bg-gradient-to-br from-blue-500/15 to-violet-500/10 text-2xl text-blue-300">⌁</div>
              <h1 className="mt-5 text-2xl font-semibold text-white">What should the agent build?</h1>
              <p className="mt-2 text-sm leading-6 text-slate-500">It will clone the repository into an isolated workspace, inspect the code, make changes, and run verification.</p>
              {!caps?.ready && <SetupNotice caps={caps} />}
            </div>
          )}
          {events.map((event) => <TimelineEvent key={`${event.sequence}-${event.type}`} event={event} />)}
        </div>
        <div className="shrink-0 border-t border-white/[0.06] bg-[#0a0c11]/95 p-4">
          <div className="rounded-xl border border-white/[0.1] bg-[#10131a] shadow-[0_14px_50px_rgba(0,0,0,.35)] focus-within:border-blue-400/40">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onRun(); }}
              placeholder="Describe a change, bug, or feature…" rows={3}
              className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-slate-200 outline-none placeholder:text-slate-600" />
            <div className="flex items-center gap-2 px-3 pb-3">
              <span className="rounded-md border border-white/[0.08] px-2 py-1 font-mono text-[10px] text-slate-500">{selectedAgent?.mode || "agent"}</span>
              <span className="rounded-md border border-white/[0.08] px-2 py-1 font-mono text-[10px] text-slate-500">auto model</span>
              <span className="ml-auto text-[10px] text-slate-700">⌘ ↵</span>
              {busy && !terminalStates.has(run?.state) ? (
                <button onClick={onCancel} className="rounded-lg border border-red-400/30 px-3 py-1.5 text-xs text-red-300">Stop</button>
              ) : (
                <button onClick={onRun} disabled={!prompt.trim() || !selectedAgent || busy}
                  className="rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-30">Run agent</button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="min-w-0 bg-[#090b0f]">
        <div className="flex h-11 items-center gap-5 border-b border-white/[0.06] px-4 text-[11px]">
          <span className="border-b border-blue-400 py-3 text-slate-200">Changes</span>
          <span className="py-3 text-slate-600">Terminal</span>
          <span className="py-3 text-slate-600">Artifacts</span>
        </div>
        <div className="p-4">
          <RunSummary run={run} onRetry={onRetry} onPublish={onPublish} onDecline={onCancel} onResume={onResume} busy={busy} />
          {artifacts.map((artifact) => <ArtifactCard key={artifact.id || artifact.name} artifact={artifact} />)}
        </div>
      </section>
    </div>
  );
}

function Usage() {
  const [data, setData] = useState(null);
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyPlan, setBusyPlan] = useState("");

  const refreshBilling = useCallback(() => {
    billingOverview().then(setBilling).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    usageSummary().then(setData).catch((err) => setError(err.message));
    refreshBilling();
  }, [refreshBilling]);

  async function choosePlan(planId) {
    setBusyPlan(planId); setError(""); setNotice("");
    try {
      const result = await selectPlan(planId);
      if (result.url) { window.location.href = result.url; return; }
      setBilling(result);
      setNotice(`You are on the ${planId === "free" ? "Free" : planId} plan.`);
    } catch (err) {
      setError(err.message);
    } finally { setBusyPlan(""); }
  }

  const totals = data?.totals || {};
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-400">Metered execution</div>
      <h1 className="mt-2 text-3xl font-semibold text-white">Usage & billing</h1>
      <p className="mt-2 text-sm text-slate-500">Your plan allowance, monthly budgets, and the model tokens and sandbox compute recorded by agent runs.</p>
      {error && <div className="mt-5 rounded-lg border border-red-400/20 bg-red-400/[0.05] p-3 text-xs text-red-300">{error}</div>}
      {notice && <div className="mt-5 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] p-3 text-xs text-emerald-300">{notice}</div>}

      {billing && (
        <>
          <div className="mt-8 grid gap-3 lg:grid-cols-3">
            {billing.plans.map((plan) => {
              const current = billing.subscription.plan === plan.id;
              return (
                <div key={plan.id} className={`rounded-xl border p-5 ${current ? "border-blue-400/30 bg-blue-400/[0.05]" : "border-white/[0.07] bg-white/[0.02]"}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">{plan.name}</span>
                    {current && <span className="rounded border border-blue-400/25 px-1.5 py-0.5 font-mono text-[9px] uppercase text-blue-300">Current</span>}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{plan.description}</div>
                  <div className="mt-3 text-lg font-semibold text-slate-200">
                    {plan.priceGbp === 0 ? "£0" : plan.priceApproved ? `£${plan.priceGbp}/mo` : <span className="text-xs font-normal text-slate-500">Pricing coming soon</span>}
                  </div>
                  <ul className="mt-3 space-y-1 text-[11px] text-slate-500">
                    <li>{formatNumber(plan.monthly.runs)} runs / month</li>
                    <li>{formatCompact(plan.monthly.managedTokens)} managed tokens</li>
                    <li>{Math.round(plan.monthly.computeSeconds / 3600)}h sandbox compute</li>
                  </ul>
                  {!current && (
                    <button onClick={() => choosePlan(plan.id)}
                      disabled={busyPlan === plan.id || (plan.id !== "free" && !billing.stripeConfigured)}
                      className="mt-4 w-full rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.05] disabled:opacity-35">
                      {plan.id === "free" ? "Switch to Free" : billing.stripeConfigured ? `Upgrade to ${plan.name}` : "Not available yet"}
                    </button>
                  )}
                  {current && billing.subscription.stripeManaged && (
                    <button onClick={() => billingPortal().then((r) => { window.location.href = r.url; }).catch((err) => setError(err.message))}
                      className="mt-4 w-full rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs text-slate-300 hover:bg-white/[0.05]">
                      Manage billing
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-8 rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white">This period's budgets</span>
              <span className="font-mono text-[10px] text-slate-600">resets {new Date(billing.period.end).toLocaleDateString()}</span>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <BudgetMeter label="Agent runs" meter={billing.budgets.runs} format={formatNumber} />
              <BudgetMeter label="Managed tokens" meter={billing.budgets.managedTokens} format={formatCompact} />
              <BudgetMeter label="Sandbox compute" meter={billing.budgets.computeSeconds} format={(v) => `${Math.round(v / 60)}m`} />
            </div>
            <SpendGuards billing={billing} onSaved={setBilling} onError={setError} />
          </div>
        </>
      )}

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Input tokens" value={formatNumber(totals.inputTokens)} />
        <Metric label="Output tokens" value={formatNumber(totals.outputTokens)} />
        <Metric label="Cached tokens" value={formatNumber(totals.cachedTokens)} />
        <Metric label="Sandbox time" value={`${Math.round(totals.computeSeconds || 0)}s`} />
      </div>
      <div className="mt-8 overflow-hidden rounded-xl border border-white/[0.07]">
        <div className="grid grid-cols-[1fr_1fr_90px_90px] bg-white/[0.025] px-4 py-2 text-[10px] uppercase tracking-wide text-slate-600">
          <span>Provider</span><span>Model</span><span>Input</span><span>Output</span>
        </div>
        {(data?.records || []).map((record) => (
          <div key={record.id} className="grid grid-cols-[1fr_1fr_90px_90px] border-t border-white/[0.06] px-4 py-3 text-xs text-slate-400">
            <span>{record.provider}</span><span className="truncate">{record.model}</span>
            <span>{formatNumber(record.input_tokens)}</span><span>{formatNumber(record.output_tokens)}</span>
          </div>
        ))}
        {data && !data.records.length && <div className="border-t border-white/[0.06] p-6 text-center text-xs text-slate-600">No completed run usage yet.</div>}
      </div>
    </div>
  );
}

function BudgetMeter({ label, meter, format }) {
  const ratio = meter.limit ? Math.min(meter.used / meter.limit, 1) : 0;
  const tone = ratio >= 1 ? "bg-red-400" : ratio >= 0.8 ? "bg-amber-400" : "bg-blue-400";
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-500">{format(meter.used)} / {format(meter.limit)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(ratio * 100, meter.used ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

function SpendGuards({ billing, onSaved, onError }) {
  const overrides = billing.subscription.overrides;
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState(overrides.runs || "");
  const [tokens, setTokens] = useState(overrides.managedTokens || "");
  const [compute, setCompute] = useState(overrides.computeSeconds || "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); onError("");
    try {
      onSaved(await updateBudgets({
        runs: runs === "" ? null : Number(runs),
        managedTokens: tokens === "" ? null : Number(tokens),
        computeSeconds: compute === "" ? null : Number(compute),
      }));
      setOpen(false);
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-4 text-[11px] text-slate-500 underline decoration-white/20 underline-offset-2 hover:text-slate-300">
        {overrides.runs || overrides.managedTokens || overrides.computeSeconds ? "Edit personal spend guards" : "Set personal spend guards"}
      </button>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-white/[0.07] bg-black/20 p-4">
      <div className="text-[11px] text-slate-400">Personal spend guards cap this account below the plan allowance. Leave a field empty to use the plan limit.</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <GuardInput label="Max runs" value={runs} onChange={setRuns} />
        <GuardInput label="Max managed tokens" value={tokens} onChange={setTokens} />
        <GuardInput label="Max compute seconds" value={compute} onChange={setCompute} />
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={save} disabled={busy} className="rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">Save guards</button>
        <button onClick={() => setOpen(false)} className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-400">Cancel</button>
      </div>
    </div>
  );
}

function GuardInput({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-slate-600">{label}</span>
      <input type="number" min="1" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Plan limit"
        className="mt-1 w-full rounded-lg border border-white/[0.08] bg-transparent px-3 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-blue-400/40" />
    </label>
  );
}

function Operations({ initial }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState("");
  useEffect(() => { opsTelemetry().then(setSnapshot).catch((err) => setError(err.message)); }, []);
  if (!snapshot) return <div className="p-8 text-sm text-slate-500">{error || "Loading operational telemetry…"}</div>;
  const day = snapshot.runs.last24h;
  const week = snapshot.runs.last7d;
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-400">Operator telemetry</div>
      <h1 className="mt-2 text-3xl font-semibold text-white">Operations</h1>
      <p className="mt-2 text-sm text-slate-500">Platform-wide runs, queue health, provider reliability, and metered usage. Generated {new Date(snapshot.generatedAt).toLocaleTimeString()}.</p>
      {error && <div className="mt-5 rounded-lg border border-red-400/20 bg-red-400/[0.05] p-3 text-xs text-red-300">{error}</div>}

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Runs · 24h" value={formatNumber(day.total)} />
        <Metric label="Failure rate · 24h" value={`${Math.round(day.failureRate * 100)}%`} />
        <Metric label="Avg duration · 24h" value={`${day.averageDurationSeconds}s`} />
        <Metric label="Queue depth" value={formatNumber(snapshot.runs.queueDepth)} />
        <Metric label="Active runs" value={formatNumber(snapshot.runs.active)} />
        <Metric label="Awaiting approval" value={formatNumber(snapshot.runs.waitingForApproval)} />
        <Metric label="Tokens · 7d" value={formatCompact(snapshot.usage.last7d.tokens)} />
        <Metric label="Compute · 7d" value={`${Math.round(snapshot.usage.last7d.computeSeconds / 60)}m`} />
      </div>

      <h2 className="mt-10 text-sm font-semibold text-white">Provider reliability · 7d</h2>
      <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.07]">
        <div className="grid grid-cols-[1fr_1fr_80px_80px_100px] bg-white/[0.025] px-4 py-2 text-[10px] uppercase tracking-wide text-slate-600">
          <span>Provider</span><span>Model</span><span>Attempts</span><span>Errors</span><span>Avg latency</span>
        </div>
        {snapshot.providers.map((row) => (
          <div key={`${row.provider}:${row.model}`} className="grid grid-cols-[1fr_1fr_80px_80px_100px] border-t border-white/[0.06] px-4 py-2.5 text-xs text-slate-400">
            <span>{row.provider}</span><span className="truncate">{row.model}</span>
            <span>{formatNumber(row.attempts)}</span>
            <span className={row.errorRate > 0.1 ? "text-red-300" : ""}>{Math.round(row.errorRate * 100)}%</span>
            <span>{formatNumber(row.averageLatencyMs)}ms</span>
          </div>
        ))}
        {!snapshot.providers.length && <div className="border-t border-white/[0.06] p-5 text-center text-xs text-slate-600">No model attempts recorded in the last 7 days.</div>}
      </div>

      <div className="mt-8 grid gap-3 lg:grid-cols-3">
        <StatusList title="Run states · 7d" entries={week.byState} />
        <StatusList title="Webhook deliveries" entries={snapshot.webhooks} />
        <StatusList title="Repository indexes" entries={snapshot.indexing} />
      </div>
    </div>
  );
}

function StatusList({ title, entries }) {
  const keys = Object.keys(entries || {});
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="text-xs font-semibold text-white">{title}</div>
      <div className="mt-3 space-y-1.5">
        {keys.map((key) => (
          <div key={key} className="flex justify-between text-[11px]">
            <span className="text-slate-500">{key}</span>
            <span className="font-mono text-slate-400">{formatNumber(entries[key])}</span>
          </div>
        ))}
        {!keys.length && <div className="text-[11px] text-slate-600">Nothing recorded yet.</div>}
      </div>
    </div>
  );
}

function Repositories({ repos, caps, onAdded }) {
  const [fullName, setFullName] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installations, setInstallations] = useState([]);
  const [available, setAvailable] = useState([]);
  const [githubBusy, setGithubBusy] = useState(false);
  const [indexes, setIndexes] = useState({});
  const [searchRepoId, setSearchRepoId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [symbolResults, setSymbolResults] = useState([]);
  const [searchMode, setSearchMode] = useState("code");
  const [fileGraph, setFileGraph] = useState(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchComplete, setSearchComplete] = useState(false);
  const [refreshing, setRefreshing] = useState({});

  useEffect(() => {
    githubInstallations().then(async (result) => {
      setInstallations(result.installations);
      const installation = result.installations[0];
      if (installation && result.configured) {
        setAvailable((await githubInstallationRepositories(installation.installationId)).repositories);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all(repos.map(async (repo) => {
      try { return [repo.id, (await repositoryIndex(repo.id)).index]; } catch { return [repo.id, null]; }
    })).then((entries) => {
      if (!cancelled) {
        setIndexes(Object.fromEntries(entries));
        setSearchRepoId((current) => current || repos[0]?.id || "");
      }
    });
    return () => { cancelled = true; };
  }, [repos]);

  useEffect(() => {
    if (!repos.some((repo) => ["queued", "indexing"].includes(indexes[repo.id]?.status))) return undefined;
    const timer = setInterval(() => {
      Promise.all(repos.map(async (repo) => {
        try { return [repo.id, (await repositoryIndex(repo.id)).index]; } catch { return [repo.id, indexes[repo.id]]; }
      })).then((entries) => setIndexes(Object.fromEntries(entries)));
    }, 2_000);
    return () => clearInterval(timer);
  }, [repos, indexes]);

  async function installGithub() {
    setGithubBusy(true); setError("");
    try {
      const result = await startGithubInstallation();
      window.location.assign(result.url);
    } catch (err) { setError(err.message); setGithubBusy(false); }
  }

  async function connectFromGithub(repository) {
    setGithubBusy(true); setError("");
    try {
      const installation = installations[0];
      const result = await connectGithubRepository(installation.installationId, repository.id);
      await onAdded(result.repository);
    } catch (err) { setError(err.message); } finally { setGithubBusy(false); }
  }
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const result = await addRepository({ fullName, private: isPrivate });
      setFullName(""); await onAdded(result.repository);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function searchCode(e) {
    e.preventDefault();
    if (!searchRepoId || !searchQuery.trim()) return;
    setSearchBusy(true); setSearchError(""); setSearchComplete(false);
    try {
      const result = searchMode === "code"
        ? await searchRepository(searchRepoId, searchQuery)
        : await searchRepositorySymbols(searchRepoId, searchQuery);
      setSearchResults(result.results || []);
      setSymbolResults(result.symbols || []);
      setFileGraph(null);
      setIndexes((current) => ({ ...current, [searchRepoId]: result.index }));
    } catch (err) {
      setSearchResults([]); setSymbolResults([]); setFileGraph(null);
      setSearchError(err.message);
    } finally { setSearchBusy(false); setSearchComplete(true); }
  }
  async function refreshIndex(repositoryId) {
    setRefreshing((current) => ({ ...current, [repositoryId]: true }));
    setSearchError("");
    try {
      const result = await refreshRepositoryIndex(repositoryId);
      setIndexes((current) => ({ ...current, [repositoryId]: result.index }));
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setRefreshing((current) => ({ ...current, [repositoryId]: false }));
    }
  }
  async function loadFileGraph(path) {
    setSearchError("");
    try {
      const result = await repositoryFileGraph(searchRepoId, path);
      setFileGraph(result.graph);
    } catch (err) {
      setSearchError(err.message);
    }
  }
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-400">GitHub first</div>
          <h1 className="mt-2 text-3xl font-semibold text-white">Repository control</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Connect repositories through the Thrallo GitHub App, then create a persistent agent that can search, understand, and edit the codebase.</p>
          <div className="mt-8 grid gap-3">
            {repos.map((repo) => (
              <div key={repo.id} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
                <div className="flex items-center gap-4">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-white/[0.05] font-mono text-slate-400">⌘</span>
                <div><div className="text-sm text-slate-200">{repo.fullName}</div><div className="mt-1 text-[11px] text-slate-600">{repo.defaultBranch} · {repo.private ? "private" : "public"}</div></div>
                <div className="ml-auto flex flex-col items-end gap-1">
                  <StatusDot ok={repo.status === "ready"} label={repo.status} />
                  <span className={`font-mono text-[9px] uppercase ${
                    indexes[repo.id]?.status === "ready" ? "text-emerald-400/70" : "text-slate-700"
                  }`}>
                    {indexes[repo.id]?.status === "ready"
                      ? `${indexes[repo.id].fileCount} files · ${indexes[repo.id].symbolCount || 0} symbols`
                      : ["queued", "indexing"].includes(indexes[repo.id]?.status)
                        ? indexes[repo.id]?.progress?.phase || indexes[repo.id].status
                        : "index after first run"}
                  </span>
                </div>
                <button type="button" onClick={() => refreshIndex(repo.id)}
                  disabled={refreshing[repo.id] || ["queued", "indexing"].includes(indexes[repo.id]?.status)}
                  className="rounded-lg border border-white/[0.08] px-3 py-2 text-[10px] text-slate-400 hover:border-cyan-400/30 hover:text-cyan-200 disabled:opacity-30">
                  {refreshing[repo.id] ? "Queuing…" : "Reindex"}
                </button>
                </div>
                {["queued", "indexing"].includes(indexes[repo.id]?.status) && (
                  <div className="mt-3">
                    <div className="mb-1 flex justify-between font-mono text-[9px] uppercase text-slate-600">
                      <span>{indexes[repo.id]?.progress?.phase || indexes[repo.id].status}</span>
                      <span>{indexes[repo.id]?.progress?.current || 0}/{indexes[repo.id]?.progress?.total || 0}</span>
                    </div>
                    <div className="h-1 overflow-hidden rounded bg-white/[0.05]">
                      <div className="h-full rounded bg-gradient-to-r from-cyan-400 to-blue-500 transition-all"
                        style={{ width: `${indexes[repo.id]?.progress?.total
                          ? Math.min((indexes[repo.id].progress.current / indexes[repo.id].progress.total) * 100, 100)
                          : 8}%` }} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          {repos.length > 0 && (
            <form onSubmit={searchCode} className="mt-8 rounded-2xl border border-white/[0.08] bg-[#0e1117] p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-400">Encrypted hybrid index</div>
                  <h2 className="mt-1 text-lg font-semibold text-white">Repository intelligence</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Search source or inspect definitions, references and file dependencies.</p>
                </div>
                <span className="rounded-full border border-white/[0.08] px-2 py-1 font-mono text-[9px] text-slate-600">PRIVATE</span>
              </div>
              <div className="mt-4 flex gap-1 rounded-lg border border-white/[0.07] bg-black/20 p-1">
                {["code", "symbols"].map((mode) => (
                  <button key={mode} type="button" onClick={() => {
                    setSearchMode(mode); setSearchResults([]); setSymbolResults([]); setFileGraph(null); setSearchComplete(false);
                  }} className={`rounded-md px-3 py-1.5 text-[10px] uppercase tracking-wide ${
                    searchMode === mode ? "bg-white/[0.08] text-cyan-200" : "text-slate-600"
                  }`}>
                    {mode === "code" ? "Code search" : "Definitions & references"}
                  </button>
                ))}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-[220px_1fr_auto]">
                <select className="field" value={searchRepoId} onChange={(event) => {
                  setSearchRepoId(event.target.value); setSearchResults([]); setSymbolResults([]);
                  setFileGraph(null); setSearchError(""); setSearchComplete(false);
                }}>
                  {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
                </select>
                <input className="field" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={searchMode === "code" ? "Where is authentication handled?" : "verifyToken"} />
                <button disabled={searchBusy || !searchQuery.trim() || indexes[searchRepoId]?.status !== "ready"}
                  className="btn-primary !px-5 disabled:opacity-40">
                  {searchBusy ? "Searching…" : "Search"}
                </button>
              </div>
              {searchError && <p className="mt-3 text-xs text-red-300">{searchError}</p>}
              {indexes[searchRepoId]?.status !== "ready" && (
                <p className="mt-3 text-[10px] text-amber-300/60">Run this repository&apos;s agent once to build the first index.</p>
              )}
              {searchComplete && !searchError && searchResults.length === 0 && symbolResults.length === 0 && (
                <p className="mt-3 text-xs text-slate-600">No matching code was found.</p>
              )}
              {symbolResults.length > 0 && (
                <div className="mt-4 grid gap-3">
                  {symbolResults.map((symbol) => (
                    <div key={symbol.id} className="rounded-xl border border-white/[0.07] bg-black/15 p-4">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-cyan-400/10 px-2 py-1 font-mono text-[9px] uppercase text-cyan-300">{symbol.kind}</span>
                        <span className="font-mono text-xs text-white">{symbol.name}</span>
                        <span className="ml-auto text-[10px] text-slate-600">{symbol.referenceCount} references</span>
                      </div>
                      <div className="mt-2 font-mono text-[10px] text-slate-500">{symbol.path}:L{symbol.startLine}</div>
                      {symbol.signature && <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-400">{symbol.signature}</pre>}
                      {symbol.references?.length > 0 && (
                        <div className="mt-3 grid gap-1 border-t border-white/[0.05] pt-3">
                          {symbol.references.slice(0, 6).map((reference, index) => (
                            <div key={`${reference.path}-${reference.line}-${index}`} className="font-mono text-[9px] text-slate-600">
                              {reference.kind} · {reference.path}:L{reference.line}
                            </div>
                          ))}
                        </div>
                      )}
                      <button type="button" onClick={() => loadFileGraph(symbol.path)}
                        className="mt-3 text-[10px] text-cyan-400/70 hover:text-cyan-200">
                        Show file dependencies
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {fileGraph && (
                <div className="mt-4 rounded-xl border border-violet-400/15 bg-violet-400/[0.04] p-4">
                  <div className="font-mono text-[10px] text-violet-200">{fileGraph.path}</div>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <div className="text-[9px] uppercase tracking-wide text-slate-600">Depends on</div>
                      {(fileGraph.dependencies || []).map((path) => <div key={path} className="mt-1 truncate font-mono text-[9px] text-slate-500">{path}</div>)}
                      {!fileGraph.dependencies?.length && <div className="mt-1 text-[10px] text-slate-700">No internal imports</div>}
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-wide text-slate-600">Used by</div>
                      {(fileGraph.dependents || []).map((path) => <div key={path} className="mt-1 truncate font-mono text-[9px] text-slate-500">{path}</div>)}
                      {!fileGraph.dependents?.length && <div className="mt-1 text-[10px] text-slate-700">No internal dependents</div>}
                    </div>
                  </div>
                </div>
              )}
              {searchResults.length > 0 && (
                <div className="mt-4 grid gap-3">
                  {searchResults.map((result, index) => (
                    <div key={`${result.path}-${result.startLine}-${index}`} className="overflow-hidden rounded-xl border border-white/[0.07] bg-black/15">
                      <div className="flex items-center border-b border-white/[0.06] px-3 py-2">
                        <span className="truncate font-mono text-[10px] text-cyan-300/80">{result.path}</span>
                        <span className="ml-auto pl-3 font-mono text-[9px] text-slate-700">L{result.startLine}–{result.endLine}</span>
                      </div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap p-3 font-mono text-[10px] leading-5 text-slate-500">{result.content}</pre>
                    </div>
                  ))}
                </div>
              )}
            </form>
          )}
          {available.length > 0 && (
            <div className="mt-8">
              <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                Available through {installations[0]?.accountLogin}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {available.map((repo) => {
                  const connected = repos.some((item) => item.fullName === repo.fullName);
                  return (
                    <button key={repo.id} disabled={connected || githubBusy} onClick={() => connectFromGithub(repo)}
                      className="flex items-center rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left text-xs text-slate-400 hover:border-blue-400/20 hover:text-white disabled:opacity-40">
                      <span className="truncate">{repo.fullName}</span>
                      <span className="ml-auto text-[10px] text-slate-600">{connected ? "connected" : "connect"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/[0.08] bg-[#0e1117] p-5">
            <h2 className="text-sm font-medium text-white">GitHub App</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">Use short-lived installation tokens for selected repositories. No personal token is stored.</p>
            <button onClick={installGithub} disabled={!caps?.github?.appConfigured || githubBusy}
              className="mt-4 w-full rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:bg-white/10 disabled:text-slate-600">
              {installations.length ? "Manage GitHub installation" : "Install GitHub App"}
            </button>
            {!caps?.github?.appConfigured && <p className="mt-3 text-[10px] leading-4 text-amber-300/60">Server setup is required before installation can begin.</p>}
          </div>
          <form onSubmit={submit} className="h-fit rounded-2xl border border-white/[0.08] bg-[#0e1117] p-5">
          <h2 className="text-sm font-medium text-white">Temporary manual connection</h2>
          <label className="mt-5 block text-[11px] text-slate-500">GitHub repository</label>
          <input className="field mt-2" placeholder="owner/repository" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          <label className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Private repository
          </label>
          {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
          <button disabled={busy} className="mt-5 w-full rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            {busy ? "Connecting…" : "Connect and create agent"}
          </button>
          <p className="mt-3 text-[10px] leading-4 text-slate-600">Token values never enter the browser or the control-plane database.</p>
          </form>
        </div>
      </div>
    </div>
  );
}

function TimelineEvent({ event }) {
  const payload = event.payload || {};
  const isError = event.type.includes("failed");
  const isTool = event.type.startsWith("tool.");
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${isError ? "border-red-400/20 bg-red-400/[0.05]" : "border-white/[0.06] bg-white/[0.02]"}`}>
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${isError ? "bg-red-400" : isTool ? "bg-violet-400" : "bg-blue-400"}`} />
        <span className="font-mono text-[10px] uppercase tracking-wide text-slate-500">{event.type.replaceAll(".", " ")}</span>
        <span className="ml-auto font-mono text-[9px] text-slate-700">#{event.sequence}</span>
      </div>
      <div className="mt-1.5 pl-3.5 text-xs leading-5 text-slate-400">{payload.message || payload.error || payload.name || payload.text || "Updated"}</div>
    </div>
  );
}

function AgentPolicy({ agent, onChange }) {
  const [busy, setBusy] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const [paths, setPaths] = useState((agent.protectedPaths || []).join("\n"));
  const auto = agent.publishMode === "auto_publish";

  async function toggleMode() {
    setBusy(true);
    try {
      await onChange(agent.id, { publishMode: auto ? "require_approval" : "auto_publish" });
    } finally { setBusy(false); }
  }

  async function savePaths() {
    setBusy(true);
    try {
      await onChange(agent.id, {
        protectedPaths: paths.split("\n").map((line) => line.trim()).filter(Boolean),
      });
      setPathsOpen(false);
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">Publish policy</div>
      <button onClick={toggleMode} disabled={busy}
        className="mt-2 flex w-full items-center justify-between rounded-md border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.04] disabled:opacity-40">
        <span>{auto ? "Auto-publish PRs" : "Ask before PR"}</span>
        <span className={`h-2 w-2 rounded-full ${auto ? "bg-emerald-400" : "bg-amber-400"}`} />
      </button>
      <PolicyToggle busy={busy} value={agent.networkPolicy === "offline"}
        onLabel="Offline sandbox" offLabel="Full network"
        title="Offline blocks all outbound network access after checkout (Codex runs keep network)."
        onToggle={(next) => onChange(agent.id, { networkPolicy: next ? "offline" : "full" })} />
      <PolicyToggle busy={busy} value={agent.commandPolicy === "restricted"}
        onLabel="Restricted commands" offLabel="Standard commands"
        title="Restricted blocks network-transfer, remote-shell, and privilege commands in the tool loop."
        onToggle={(next) => onChange(agent.id, { commandPolicy: next ? "restricted" : "standard" })} />
      {!pathsOpen && (
        <button onClick={() => setPathsOpen(true)} className="mt-2 text-[10px] text-slate-600 underline decoration-white/15 underline-offset-2 hover:text-slate-400">
          Protected paths {agent.protectedPaths?.length ? `(${agent.protectedPaths.length})` : ""}
        </button>
      )}
      {pathsOpen && (
        <div className="mt-2">
          <textarea value={paths} onChange={(e) => setPaths(e.target.value)} rows={3}
            placeholder={"One glob per line, e.g.\nsrc/config/**\n*.sql"}
            className="w-full rounded-md border border-white/[0.08] bg-transparent px-2 py-1.5 font-mono text-[10px] text-slate-300 outline-none placeholder:text-slate-700 focus:border-blue-400/40" />
          <div className="mt-1.5 flex gap-2">
            <button onClick={savePaths} disabled={busy} className="rounded bg-blue-500/80 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40">Save</button>
            <button onClick={() => setPathsOpen(false)} className="rounded border border-white/[0.08] px-2 py-1 text-[10px] text-slate-500">Cancel</button>
          </div>
          <div className="mt-1 text-[9px] leading-4 text-slate-700">Changes touching these globs always wait for your approval, even with auto-publish on.</div>
        </div>
      )}
    </div>
  );
}

function PolicyToggle({ busy, value, onLabel, offLabel, title, onToggle }) {
  const [saving, setSaving] = useState(false);
  async function toggle() {
    setSaving(true);
    try { await onToggle(!value); } finally { setSaving(false); }
  }
  return (
    <button onClick={toggle} disabled={busy || saving} title={title}
      className="mt-2 flex w-full items-center justify-between rounded-md border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.04] disabled:opacity-40">
      <span>{value ? onLabel : offLabel}</span>
      <span className={`h-2 w-2 rounded-full ${value ? "bg-violet-400" : "bg-slate-600"}`} />
    </button>
  );
}

function ArtifactCard({ artifact }) {
  const [content, setContent] = useState(artifact.content);
  useEffect(() => {
    setContent(artifact.content);
    if (artifact.content == null && artifact.sizeBytes > 0 && artifact.id && artifact.runId) {
      artifactContent(artifact.runId, artifact.id).then(setContent).catch(() => setContent("Failed to load artifact content"));
    }
  }, [artifact.id, artifact.runId, artifact.content, artifact.sizeBytes]);
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-white/[0.07]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-slate-400">
        <span>{artifact.name}</span>
        {artifact.sizeBytes > 0 && <span className="font-mono text-[9px] text-slate-600">{formatNumber(artifact.sizeBytes)} B</span>}
      </div>
      <pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap p-3 font-mono text-[10px] leading-5 text-slate-500">
        {content == null && artifact.sizeBytes > 0 ? "Loading…" : content || "No content"}
      </pre>
    </div>
  );
}

function RunSummary({ run, onRetry, onPublish, onDecline, onResume, busy }) {
  if (!run) return <div className="rounded-lg border border-dashed border-white/[0.08] p-5 text-center text-xs text-slate-700">Run output will appear here</div>;
  const color = run.state === "succeeded" ? "text-emerald-300" : run.state === "failed" ? "text-red-300" : "text-blue-300";
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between"><span className="text-xs text-slate-500">Run status</span><span className={`font-mono text-[10px] uppercase ${color}`}>{run.state}</span></div>
      {run.workBranch && <div className="mt-2 truncate font-mono text-[10px] text-slate-600">{run.workBranch}</div>}
      {run.error && <div className="mt-3 rounded bg-red-400/[0.06] p-2 text-[11px] leading-5 text-red-300">{run.error}</div>}
      {run.state === "waiting_for_approval" && (() => {
        const isReview = run.result?.approval?.action === "post_review";
        return (
          <div className="mt-3 space-y-2">
            <div className="rounded border border-amber-300/15 bg-amber-300/[0.05] p-2 text-[11px] leading-5 text-amber-200/75">
              {isReview
                ? `Review of PR #${run.pullRequest} is ready (${(run.result?.findings || []).length} findings, verdict: ${String(run.result?.verdict || "comment").replace("_", " ")}). Approving posts it to GitHub — see the Reviews tab for details.`
                : "Review the diff below. Publishing will commit this branch, push it, and open a pull request."}
            </div>
            <button onClick={onPublish} disabled={busy}
              className="w-full rounded-md bg-gradient-to-r from-blue-500 to-violet-500 px-2 py-2 text-[11px] font-semibold text-white disabled:opacity-40">
              {busy ? "Working…" : isReview ? "Approve & post review" : "Approve & open pull request"}
            </button>
            <button onClick={onDecline} disabled={busy}
              className="w-full rounded-md border border-white/[0.08] px-2 py-1.5 text-[11px] text-slate-400 hover:bg-white/[0.04] disabled:opacity-40">
              {isReview ? "Discard review" : "Decline & discard workspace"}
            </button>
          </div>
        );
      })()}
      {run.result?.publication?.pullRequest?.url && (
        <a href={run.result.publication.pullRequest.url} target="_blank" rel="noreferrer"
          className="mt-3 block rounded-md border border-emerald-400/20 bg-emerald-400/[0.06] px-2 py-2 text-center text-[11px] text-emerald-300">
          Open pull request #{run.result.publication.pullRequest.number}
        </a>
      )}
      {run.resumable && (
        <button onClick={onResume} disabled={busy}
          className="mt-3 w-full rounded-md bg-gradient-to-r from-blue-500 to-violet-500 px-2 py-2 text-[11px] font-semibold text-white disabled:opacity-40">
          Resume from preserved workspace
        </button>
      )}
      {terminalStates.has(run.state) && run.state !== "succeeded" && (
        <button onClick={onRetry} disabled={busy} className="mt-3 w-full rounded-md border border-white/[0.08] px-2 py-1.5 text-[11px] text-slate-400 hover:bg-white/[0.04] disabled:opacity-40">
          Retry from clean baseline
        </button>
      )}
    </div>
  );
}

function SetupNotice({ caps }) {
  const missing = [!caps?.models?.some((x) => x.configured) && "OpenAI", !caps?.runner?.configured && "Daytona"].filter(Boolean);
  return <div className="mx-auto mt-5 max-w-sm rounded-lg border border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-xs text-amber-200/70">Connect {missing.join(" and ") || "runtime services"} in server settings to execute agents.</div>;
}

function EmptyState({ onConnect }) {
  return <div className="grid min-h-[calc(100vh-4rem)] place-items-center p-8"><div className="max-w-md text-center"><div className="text-5xl text-blue-400/70">⌘</div><h1 className="mt-5 text-2xl font-semibold text-white">Connect your first repository</h1><p className="mt-2 text-sm leading-6 text-slate-500">Thrallo needs a repository before it can inspect code, create an isolated branch, and run a task.</p><button onClick={onConnect} className="mt-6 rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-5 py-2 text-sm font-medium text-white">Connect GitHub repository</button></div></div>;
}

function Reviews({ repos, agents, onAgentCreated }) {
  const githubRepos = repos.filter((repo) => repo.status === "ready");
  const [repoId, setRepoId] = useState("");
  const [pulls, setPulls] = useState(null);
  const [focus, setFocus] = useState("");
  const [run, setRun] = useState(null);
  const [lastMessage, setLastMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef(null);

  const activeRepoId = repoId || githubRepos[0]?.id || "";

  useEffect(() => {
    if (!activeRepoId) return undefined;
    let cancelled = false;
    setPulls(null); setError("");
    repositoryPulls(activeRepoId)
      .then((result) => { if (!cancelled) setPulls(result.pulls); })
      .catch((err) => { if (!cancelled) { setPulls([]); setError(err.message); } });
    return () => { cancelled = true; };
  }, [activeRepoId]);

  useEffect(() => () => streamRef.current?.abort(), []);

  async function reviewerAgent() {
    const existing = agents.find((agent) => agent.repositoryId === activeRepoId && agent.mode === "review");
    if (existing) return existing;
    const created = await addAgent({ repositoryId: activeRepoId, name: "Reviewer", mode: "review" });
    onAgentCreated(created.agent);
    return created.agent;
  }

  async function launchReview(pull) {
    if (busy) return;
    setBusy(true); setError(""); setRun(null); setLastMessage("Starting review…");
    streamRef.current?.abort();
    const controller = new AbortController();
    streamRef.current = controller;
    try {
      const agent = await reviewerAgent();
      const created = await createRun(agent.id, {
        prompt: focus.trim() || `Review pull request #${pull.number} (${pull.title}).`,
        mode: "review",
        model: "auto",
        pullRequestNumber: pull.number,
      });
      setRun(created.run);
      await streamRunEvents(created.run.id, (event) => {
        const message = event.payload?.message;
        if (message) setLastMessage(message);
      }, { signal: controller.signal });
      setRun((await getRun(created.run.id)).run);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    } finally { setBusy(false); }
  }

  async function postReview() {
    if (!run || busy) return;
    setBusy(true); setError("");
    try {
      setRun((await publishRun(run.id)).run);
    } catch (err) {
      setError(err.message);
      setRun((await getRun(run.id)).run);
    } finally { setBusy(false); }
  }

  async function declineReview() {
    if (!run || busy) return;
    setBusy(true);
    try { setRun((await cancelRun(run.id)).run); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const result = run?.result || {};
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-400">Repository-aware review</div>
      <h1 className="mt-2 text-3xl font-semibold text-white">Code reviews</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
        The review agent checks out a pull request in an isolated workspace, reads the changed code in
        context, can run the tests, and drafts a review you approve before anything is posted to GitHub.
      </p>
      {error && <div className="mt-5 rounded-lg border border-red-400/20 bg-red-400/[0.05] p-3 text-xs text-red-300">{error}</div>}

      {!githubRepos.length && (
        <div className="mt-8 rounded-xl border border-dashed border-white/[0.08] p-8 text-center text-sm text-slate-600">
          Connect a GitHub repository first.
        </div>
      )}

      {githubRepos.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <select value={activeRepoId} onChange={(e) => setRepoId(e.target.value)}
            className="rounded-lg border border-white/[0.08] bg-[#0b0d12] px-3 py-1.5 text-xs text-slate-200 outline-none">
            {githubRepos.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
          </select>
          <input value={focus} onChange={(e) => setFocus(e.target.value)}
            placeholder="Optional reviewer focus, e.g. concurrency and error handling"
            className="min-w-[260px] flex-1 rounded-lg border border-white/[0.08] bg-transparent px-3 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-blue-400/40" />
        </div>
      )}

      {pulls && (
        <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.07]">
          {pulls.map((pull) => (
            <div key={pull.number} className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <a href={pull.url} target="_blank" rel="noreferrer" className="truncate text-sm text-slate-200 hover:text-blue-300">
                  #{pull.number} {pull.title}
                </a>
                <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                  {pull.author} · {pull.headBranch} → {pull.baseBranch}{pull.draft ? " · draft" : ""}
                </div>
              </div>
              <button onClick={() => launchReview(pull)} disabled={busy}
                className="rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-35">
                Review
              </button>
            </div>
          ))}
          {!pulls.length && <div className="p-6 text-center text-xs text-slate-600">No open pull requests.</div>}
        </div>
      )}

      {(busy || run) && (
        <div className="mt-6 rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-white">
              {run?.pullRequest ? `Review of PR #${run.pullRequest}` : "Review run"}
            </span>
            <span className="font-mono text-[10px] uppercase text-slate-500">{run?.state || "starting"}</span>
          </div>
          {busy && !terminalStates.has(run?.state) && run?.state !== "waiting_for_approval" && (
            <div className="mt-3 text-xs text-slate-500">{lastMessage}</div>
          )}
          {result.review && (
            <>
              <div className="mt-3 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase ${
                  result.verdict === "approve" ? "bg-emerald-400/10 text-emerald-300"
                    : result.verdict === "request_changes" ? "bg-red-400/10 text-red-300" : "bg-amber-400/10 text-amber-300"
                }`}>{String(result.verdict || "").replace("_", " ")}</span>
                <span className="text-[11px] text-slate-500">{(result.findings || []).length} findings</span>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-400">{result.summary}</p>
              <div className="mt-3 space-y-2">
                {(result.findings || []).map((finding, index) => (
                  <div key={index} className="rounded-lg border border-white/[0.06] p-3">
                    <div className="flex items-center gap-2 text-xs text-slate-200">
                      <span className={`h-2 w-2 rounded-full ${
                        finding.severity === "blocker" ? "bg-red-400" : finding.severity === "major" ? "bg-amber-400" : "bg-slate-500"
                      }`} />
                      <span className="font-medium">{finding.title}</span>
                    </div>
                    <div className="mt-1 pl-4 font-mono text-[10px] text-slate-600">{finding.path}{finding.line ? `:${finding.line}` : ""}</div>
                    <div className="mt-1.5 pl-4 text-[11px] leading-5 text-slate-400">{finding.detail}</div>
                  </div>
                ))}
              </div>
              {run.state === "waiting_for_approval" && (
                <div className="mt-4 flex gap-2">
                  <button onClick={postReview} disabled={busy}
                    className="rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
                    Approve & post to GitHub
                  </button>
                  <button onClick={declineReview} disabled={busy}
                    className="rounded-lg border border-white/[0.08] px-4 py-2 text-xs text-slate-400 hover:bg-white/[0.04] disabled:opacity-40">
                    Discard review
                  </button>
                </div>
              )}
              {result.publication?.review?.url && (
                <a href={result.publication.review.url} target="_blank" rel="noreferrer"
                  className="mt-4 block rounded-md border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-center text-xs text-emerald-300">
                  Review posted — open on GitHub
                </a>
              )}
            </>
          )}
          {run?.error && <div className="mt-3 rounded bg-red-400/[0.06] p-2 text-[11px] text-red-300">{run.error}</div>}
        </div>
      )}
    </div>
  );
}

function Automations({ repos }) {
  const readyRepos = repos.filter((repo) => repo.status === "ready");
  const [automations, setAutomations] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState("pr_review");
  const [repoId, setRepoId] = useState("");
  const [prompt, setPromptText] = useState("");
  const [intervalHours, setIntervalHours] = useState(24);
  const [autoPost, setAutoPost] = useState(false);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [mode, setMode] = useState("agent");

  const repoName = (id) => repos.find((repo) => repo.id === id)?.fullName || "removed repository";

  useEffect(() => {
    listAutomations().then((result) => setAutomations(result.automations)).catch((err) => setError(err.message));
  }, []);

  async function create() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await createAutomation({
        kind,
        repositoryId: repoId || readyRepos[0]?.id,
        intervalHours: kind === "scheduled_task" ? Number(intervalHours) : undefined,
        config: { prompt, autoPost, includeDrafts, ...(kind === "scheduled_task" ? { mode } : {}) },
      });
      setAutomations((items) => [result.automation, ...(items || [])]);
      setCreating(false); setPromptText(""); setAutoPost(false); setIncludeDrafts(false);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function toggle(automation) {
    setBusy(true); setError("");
    try {
      const result = await updateAutomation(automation.id, { enabled: !automation.enabled });
      setAutomations((items) => items.map((item) => (item.id === automation.id ? result.automation : item)));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function remove(automation) {
    setBusy(true); setError("");
    try {
      await deleteAutomation(automation.id);
      setAutomations((items) => items.filter((item) => item.id !== automation.id));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-400">Hands-off agents</div>
      <h1 className="mt-2 text-3xl font-semibold text-white">Automations</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
        Review every new pull request automatically, or run recurring maintenance tasks. Automated runs
        obey the same budgets and rate limits as manual ones, and reviews stay approval-gated unless you
        opt an automation into auto-posting.
      </p>
      {error && <div className="mt-5 rounded-lg border border-red-400/20 bg-red-400/[0.05] p-3 text-xs text-red-300">{error}</div>}

      {!creating && (
        <button onClick={() => setCreating(true)} disabled={!readyRepos.length}
          className="mt-6 rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2 text-xs font-semibold text-white disabled:opacity-35">
          New automation
        </button>
      )}

      {creating && (
        <div className="mt-6 rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-600">Type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-[#0b0d12] px-3 py-1.5 text-xs text-slate-200 outline-none">
                <option value="pr_review">Review new pull requests</option>
                <option value="scheduled_task">Scheduled task</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-600">Repository</span>
              <select value={repoId || readyRepos[0]?.id || ""} onChange={(e) => setRepoId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/[0.08] bg-[#0b0d12] px-3 py-1.5 text-xs text-slate-200 outline-none">
                {readyRepos.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
              </select>
            </label>
            {kind === "scheduled_task" && (
              <>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-600">Every (hours)</span>
                  <input type="number" min="1" max="168" value={intervalHours}
                    onChange={(e) => setIntervalHours(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/[0.08] bg-transparent px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-blue-400/40" />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-600">Run mode</span>
                  <select value={mode} onChange={(e) => setMode(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/[0.08] bg-[#0b0d12] px-3 py-1.5 text-xs text-slate-200 outline-none">
                    <option value="agent">Agent (can change code)</option>
                    <option value="review">Review (read-only audit)</option>
                  </select>
                </label>
              </>
            )}
          </div>
          <label className="mt-3 block">
            <span className="text-[10px] uppercase tracking-wide text-slate-600">
              {kind === "pr_review" ? "Reviewer focus (optional)" : "Task prompt"}
            </span>
            <textarea value={prompt} onChange={(e) => setPromptText(e.target.value)} rows={2}
              placeholder={kind === "pr_review"
                ? "e.g. Focus on correctness, security, and missing tests"
                : "e.g. Update dependencies and make sure the test suite passes"}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-transparent px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-blue-400/40" />
          </label>
          {kind === "pr_review" && (
            <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-slate-400">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} />
                Post reviews without asking me
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
                Include draft pull requests
              </label>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <button onClick={create} disabled={busy || (kind === "scheduled_task" && !prompt.trim())}
              className="rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
              Create automation
            </button>
            <button onClick={() => setCreating(false)} className="rounded-lg border border-white/[0.08] px-4 py-2 text-xs text-slate-400">Cancel</button>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-3">
        {(automations || []).map((automation) => (
          <div key={automation.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="flex items-center gap-3">
              <span className={`h-2 w-2 rounded-full ${automation.enabled ? "bg-emerald-400" : "bg-slate-600"}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-slate-200">
                  {automation.kind === "pr_review" ? "Review new pull requests" : "Scheduled task"}
                  <span className="ml-2 text-xs text-slate-500">{repoName(automation.repositoryId)}</span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                  {automation.kind === "scheduled_task"
                    ? `every ${automation.intervalHours}h · next ${automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString() : "—"}`
                    : automation.config?.autoPost ? "auto-posts reviews" : "reviews wait for approval"}
                  {automation.lastTriggeredAt && ` · last ${new Date(automation.lastTriggeredAt).toLocaleString()}`}
                </div>
                {automation.config?.prompt && <div className="mt-1 truncate text-[11px] text-slate-500">{automation.config.prompt}</div>}
                {automation.lastError && <div className="mt-1 text-[11px] text-red-300">{automation.lastError}</div>}
              </div>
              <button onClick={() => toggle(automation)} disabled={busy}
                className="rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/[0.05] disabled:opacity-40">
                {automation.enabled ? "Pause" : "Enable"}
              </button>
              <button onClick={() => remove(automation)} disabled={busy}
                className="rounded border border-red-400/20 px-2.5 py-1 text-[11px] text-red-300 hover:bg-red-400/[0.06] disabled:opacity-40">
                Delete
              </button>
            </div>
          </div>
        ))}
        {automations && !automations.length && !creating && (
          <div className="rounded-xl border border-dashed border-white/[0.08] p-8 text-center text-xs text-slate-600">
            No automations yet.
          </div>
        )}
      </div>
    </div>
  );
}

function Downloads() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-400">Editor integrations</div>
      <h1 className="mt-2 text-3xl font-semibold text-white">Downloads</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
        Bring Thrallo agents into your editor. Authentication uses a personal access token from
        Settings → API tokens.
      </p>
      <div className="mt-8 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.035] to-transparent p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-blue-400/20 bg-blue-500/10 text-lg">⌁</span>
          <div>
            <div className="text-sm font-semibold text-white">Thrallo for VS Code</div>
            <div className="text-xs text-slate-500">Browse agents, launch runs, stream the timeline, review diffs, approve pull requests.</div>
          </div>
        </div>
        <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-xs leading-5 text-slate-400">
          <li>Create an API token in <span className="text-slate-200">Settings → API tokens</span>.</li>
          <li>Get the extension from the <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10px]">editor/vscode</code> directory of the Thrallo repository (package with <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[10px]">npx vsce package</code>, then install the .vsix).</li>
          <li>Run <span className="text-slate-200">Thrallo: Connect</span> in VS Code and paste your token.</li>
        </ol>
        <div className="mt-4 text-[11px] text-slate-600">The extension is marketplace-ready (packaged as thrallo-0.2.0.vsix with a live status-bar run indicator and per-agent run states); public marketplace listing arrives with launch.</div>
      </div>
      <div className="mt-4 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.035] to-transparent p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-violet-400/20 bg-violet-500/10 text-lg">▸</span>
          <div>
            <div className="text-sm font-semibold text-white">Thrallo CLI</div>
            <div className="text-xs text-slate-500">Launch runs, follow the timeline, review PRs, and approve — from your terminal.</div>
          </div>
        </div>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-6 text-slate-300">{`npm install -g github:stuart3190/code-agent   # or run from a clone: node cli/thrallo.mjs
thrallo login          # paste an API token from Settings
thrallo run "fix the flaky retry test" --repo you/repo
thrallo review 42 --repo you/repo`}</pre>
        <div className="mt-3 text-[11px] text-slate-600">Credentials live in ~/.thrallo/config.json (0600). Add --yes to auto-approve publication.</div>
      </div>
    </div>
  );
}

function ComingSoon({ view, caps }) {
  const copy = {
    automations: "Schedule issue triage, dependency updates, and recurring maintenance runs.",
    reviews: "Review pull requests with repository-aware analysis and one-click fix agents.",
    usage: "Track model tokens, sandbox compute, budgets, and subscription allowances.",
    downloads: "Desktop applications, CLI releases, and signed update channels will appear here.",
    settings: "Configure models, GitHub installation, runner policy, network rules, billing, and team access.",
  };
  return <div className="mx-auto max-w-4xl p-8"><div className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.035] to-transparent p-8"><span className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-400">Product track</span><h1 className="mt-3 text-3xl font-semibold capitalize text-white">{view}</h1><p className="mt-3 max-w-xl text-sm leading-6 text-slate-500">{copy[view]}</p><div className="mt-8 grid gap-3 sm:grid-cols-3"><Metric label="Control plane" value="v1 live" /><Metric label="Runtime" value={caps?.runner?.configured ? "connected" : "setup"} /><Metric label="Data plane" value={caps?.store || "memory"} /></div></div></div>;
}

function Metric({ label, value }) { return <div className="rounded-lg border border-white/[0.06] bg-black/10 p-4"><div className="text-[10px] uppercase tracking-wide text-slate-600">{label}</div><div className="mt-1 text-sm text-slate-300">{value}</div></div>; }
function StatusDot({ ok, label, className = "" }) { return <span className={`inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.025] px-2.5 py-1 text-[10px] text-slate-500 ${className}`}><span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400"}`} />{label}</span>; }
function viewLabel(view) { return ({ agents: "Agent workspace", repositories: "Repositories", automations: "Automations", reviews: "Code reviews", usage: "Usage & billing", downloads: "Downloads", ops: "Operations", settings: "Settings" })[view] || "Thrallo"; }
function formatNumber(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function formatCompact(value) { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0)); }
function Splash() { return <div className="grid h-full place-items-center bg-[#07080b]"><Logo className="animate-pulse" /></div>; }
