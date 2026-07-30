import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./lib/useSession.js";
import { backend } from "./lib/backend.js";
import {
  addAgent, addRepository, cancelRun, capabilities, createRun, getLatestRun, getRun,
  connectGithubRepository, githubInstallationRepositories, githubInstallations,
  listAgents, listRepositories, publishRun, repositoryIndex, retryRun, runArtifacts,
  searchRepository, startGithubInstallation,
  streamRunEvents, usageSummary,
} from "./lib/codeAgentApi.js";
import Landing from "./landing/Landing.jsx";
import ResetPassword from "./auth/ResetPassword.jsx";
import { Logo } from "./auth/AuthGate.jsx";
import AiProviderSettings from "./settings/AiProviderSettings.jsx";

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
            {nav.map(([id, label, icon]) => (
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
                onPublish={publishCurrentRun}
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
            {view === "usage" && <Usage />}
            {view === "settings" && <AiProviderSettings />}
            {!["agents", "repositories", "usage", "settings"].includes(view) && <ComingSoon view={view} caps={caps} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function AgentWorkspace({ repos, agents, selectedAgent, onSelect, events, run, prompt, setPrompt, onRun, onCancel, busy, caps, artifacts, onRetry, onPublish, onConnect }) {
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
          <RunSummary run={run} onRetry={onRetry} onPublish={onPublish} onDecline={onCancel} busy={busy} />
          {artifacts.map((artifact) => (
            <div key={artifact.name} className="mt-3 overflow-hidden rounded-lg border border-white/[0.07]">
              <div className="border-b border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-slate-400">{artifact.name}</div>
              <pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap p-3 font-mono text-[10px] leading-5 text-slate-500">{artifact.content || "No content"}</pre>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Usage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { usageSummary().then(setData).catch((err) => setError(err.message)); }, []);
  const totals = data?.totals || {};
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-400">Metered execution</div>
      <h1 className="mt-2 text-3xl font-semibold text-white">Usage</h1>
      <p className="mt-2 text-sm text-slate-500">Model tokens and sandbox compute recorded by completed agent runs.</p>
      {error && <div className="mt-5 rounded-lg border border-red-400/20 bg-red-400/[0.05] p-3 text-xs text-red-300">{error}</div>}
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
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchComplete, setSearchComplete] = useState(false);

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
      const result = await searchRepository(searchRepoId, searchQuery);
      setSearchResults(result.results);
      setIndexes((current) => ({ ...current, [searchRepoId]: result.index }));
    } catch (err) {
      setSearchResults([]);
      setSearchError(err.message);
    } finally { setSearchBusy(false); setSearchComplete(true); }
  }
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-400">GitHub first</div>
          <h1 className="mt-2 text-3xl font-semibold text-white">Repository control</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Connect a repository to create a persistent agent. Private repository access uses the server-side GitHub token until the GitHub App installation flow lands.</p>
          <div className="mt-8 grid gap-3">
            {repos.map((repo) => (
              <div key={repo.id} className="flex items-center gap-4 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-white/[0.05] font-mono text-slate-400">⌘</span>
                <div><div className="text-sm text-slate-200">{repo.fullName}</div><div className="mt-1 text-[11px] text-slate-600">{repo.defaultBranch} · {repo.private ? "private" : "public"}</div></div>
                <div className="ml-auto flex flex-col items-end gap-1">
                  <StatusDot ok={repo.status === "ready"} label={repo.status} />
                  <span className={`font-mono text-[9px] uppercase ${
                    indexes[repo.id]?.status === "ready" ? "text-emerald-400/70" : "text-slate-700"
                  }`}>
                    {indexes[repo.id]?.status === "ready"
                      ? `${indexes[repo.id].fileCount} files indexed`
                      : indexes[repo.id]?.status === "indexing" ? "indexing" : "index after first run"}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {repos.length > 0 && (
            <form onSubmit={searchCode} className="mt-8 rounded-2xl border border-white/[0.08] bg-[#0e1117] p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-400">Encrypted hybrid index</div>
                  <h2 className="mt-1 text-lg font-semibold text-white">Search your codebase</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Find exact identifiers and semantically related code across an indexed repository.</p>
                </div>
                <span className="rounded-full border border-white/[0.08] px-2 py-1 font-mono text-[9px] text-slate-600">PRIVATE</span>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-[220px_1fr_auto]">
                <select className="field" value={searchRepoId} onChange={(event) => {
                  setSearchRepoId(event.target.value); setSearchResults([]); setSearchError(""); setSearchComplete(false);
                }}>
                  {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
                </select>
                <input className="field" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Where is authentication handled?" />
                <button disabled={searchBusy || !searchQuery.trim() || indexes[searchRepoId]?.status !== "ready"}
                  className="btn-primary !px-5 disabled:opacity-40">
                  {searchBusy ? "Searching…" : "Search"}
                </button>
              </div>
              {searchError && <p className="mt-3 text-xs text-red-300">{searchError}</p>}
              {indexes[searchRepoId]?.status !== "ready" && (
                <p className="mt-3 text-[10px] text-amber-300/60">Run this repository&apos;s agent once to build the first index.</p>
              )}
              {searchComplete && !searchError && searchResults.length === 0 && (
                <p className="mt-3 text-xs text-slate-600">No matching code was found.</p>
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

function RunSummary({ run, onRetry, onPublish, onDecline, busy }) {
  if (!run) return <div className="rounded-lg border border-dashed border-white/[0.08] p-5 text-center text-xs text-slate-700">Run output will appear here</div>;
  const color = run.state === "succeeded" ? "text-emerald-300" : run.state === "failed" ? "text-red-300" : "text-blue-300";
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between"><span className="text-xs text-slate-500">Run status</span><span className={`font-mono text-[10px] uppercase ${color}`}>{run.state}</span></div>
      {run.workBranch && <div className="mt-2 truncate font-mono text-[10px] text-slate-600">{run.workBranch}</div>}
      {run.error && <div className="mt-3 rounded bg-red-400/[0.06] p-2 text-[11px] leading-5 text-red-300">{run.error}</div>}
      {run.state === "waiting_for_approval" && (
        <div className="mt-3 space-y-2">
          <div className="rounded border border-amber-300/15 bg-amber-300/[0.05] p-2 text-[11px] leading-5 text-amber-200/75">
            Review the diff below. Publishing will commit this branch, push it, and open a pull request.
          </div>
          <button onClick={onPublish} disabled={busy}
            className="w-full rounded-md bg-gradient-to-r from-blue-500 to-violet-500 px-2 py-2 text-[11px] font-semibold text-white disabled:opacity-40">
            {busy ? "Publishingâ€¦" : "Approve & open pull request"}
          </button>
          <button onClick={onDecline} disabled={busy}
            className="w-full rounded-md border border-white/[0.08] px-2 py-1.5 text-[11px] text-slate-400 hover:bg-white/[0.04] disabled:opacity-40">
            Decline & discard workspace
          </button>
        </div>
      )}
      {run.result?.publication?.pullRequest?.url && (
        <a href={run.result.publication.pullRequest.url} target="_blank" rel="noreferrer"
          className="mt-3 block rounded-md border border-emerald-400/20 bg-emerald-400/[0.06] px-2 py-2 text-center text-[11px] text-emerald-300">
          Open pull request #{run.result.publication.pullRequest.number}
        </a>
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
function viewLabel(view) { return ({ agents: "Agent workspace", repositories: "Repositories", automations: "Automations", reviews: "Code reviews", usage: "Usage & billing", downloads: "Downloads", settings: "Settings" })[view] || "Thrallo"; }
function formatNumber(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function Splash() { return <div className="grid h-full place-items-center bg-[#07080b]"><Logo className="animate-pulse" /></div>; }
