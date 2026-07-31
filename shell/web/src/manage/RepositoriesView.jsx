// Repositories — the one place code plumbing is visual (Stuart's Phase 24 merge):
// connect via the GitHub App, watch indexing, search the encrypted index, and per-repo
// drill-in for policies (formerly "agent" settings — agents are an implementation detail),
// open PRs (Review is a sentence to the Lead Agent), and that repo's automations.

import React, { useEffect, useState } from "react";
import {
  listRepositories, addRepository, repositoryIndex, refreshRepositoryIndex,
  searchRepository, searchRepositorySymbols, repositoryPulls,
  githubInstallations, startGithubInstallation, githubInstallationRepositories,
  connectGithubRepository, listAgents, updateAgent, listAutomations, updateAutomation,
  deleteAutomation, getLatestRun,
} from "../lib/codeAgentApi.js";
import { StatusDot, AgentPolicy, SkeletonRows } from "./shared.jsx";

export default function RepositoriesView({ onSentence, onOpenRun }) {
  const [repos, setRepos] = useState(null);
  const [agents, setAgents] = useState([]);
  const [indexes, setIndexes] = useState({});
  const [installations, setInstallations] = useState([]);
  const [available, setAvailable] = useState([]);
  const [open, setOpen] = useState(null); // repo id drilled into
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [manualName, setManualName] = useState("");

  const refresh = async () => {
    const [repoResult, agentResult] = await Promise.all([listRepositories(), listAgents()]);
    setRepos(repoResult.repositories);
    setAgents(agentResult.agents);
    return repoResult.repositories;
  };

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    githubInstallations().then(async (result) => {
      setInstallations(result.installations);
      const installation = result.installations[0];
      if (installation && result.configured) {
        setAvailable((await githubInstallationRepositories(installation.installationId)).repositories);
      }
    }).catch(() => {});
  }, []);

  // Index status with live polling while anything is queued/indexing.
  useEffect(() => {
    if (!repos?.length) return undefined;
    let cancelled = false;
    const load = () => Promise.all(repos.map(async (repo) => {
      try { return [repo.id, (await repositoryIndex(repo.id)).index]; } catch { return [repo.id, null]; }
    })).then((entries) => { if (!cancelled) setIndexes(Object.fromEntries(entries)); });
    load();
    const timer = setInterval(() => {
      if (repos.some((repo) => ["queued", "indexing"].includes(indexes[repo.id]?.status))) load();
    }, 2_000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, Object.values(indexes).map((i) => i?.status).join(",")]);

  async function installGithub() {
    setBusy("install"); setError("");
    try { window.location.assign((await startGithubInstallation()).url); }
    catch (err) { setError(err.message); setBusy(""); }
  }
  async function connectFromGithub(repository) {
    setBusy(`connect-${repository.id}`); setError("");
    try { await connectGithubRepository(installations[0].installationId, repository.id); await refresh(); }
    catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function addManual(e) {
    e.preventDefault();
    if (!manualName.trim()) return;
    setBusy("manual"); setError("");
    try { await addRepository({ fullName: manualName.trim(), private: true }); setManualName(""); await refresh(); }
    catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function reindex(repoId) {
    setBusy(`reindex-${repoId}`); setError("");
    try { const result = await refreshRepositoryIndex(repoId); setIndexes((c) => ({ ...c, [repoId]: result.index })); }
    catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  const connectedIds = new Set((repos || []).map((r) => r.fullName?.toLowerCase()));
  const openRepo = (repos || []).find((r) => r.id === open);

  return (
    <div>
      <h3>Repositories</h3>
      <p className="mg-sub">Connect code through the Thrallo GitHub App. Ask the team anything about it in the conversation — this is just the plumbing.</p>
      {error && <div className="mg-error">{error}</div>}

      {openRepo ? (
        <RepoDetail repo={openRepo} index={indexes[openRepo.id]} agents={agents.filter((a) => a.repositoryId === openRepo.id)}
          onBack={() => setOpen(null)} onSentence={onSentence} onOpenRun={onOpenRun} onAgentsChanged={refresh} />
      ) : (
        <>
          <div className="mg-card">
            {repos === null && <SkeletonRows rows={2} />}
            {repos?.length === 0 && <div className="ct-hint">Nothing connected yet — install the GitHub App below and pick a repository, or add one by name.</div>}
            {(repos || []).map((repo) => (
              <div className="mg-row" key={repo.id}>
                <div style={{ minWidth: 0 }}>
                  {repo.fullName}
                  <div className="ct-hint">
                    {repo.defaultBranch} · {repo.private ? "private" : "public"} · {
                      indexes[repo.id]?.status === "ready"
                        ? `${indexes[repo.id].fileCount} files · ${indexes[repo.id].symbolCount || 0} symbols`
                        : ["queued", "indexing"].includes(indexes[repo.id]?.status)
                          ? `indexing — ${indexes[repo.id]?.progress?.phase || "queued"} ${indexes[repo.id]?.progress?.current || 0}/${indexes[repo.id]?.progress?.total || 0}`
                          : "not indexed yet"}
                  </div>
                  {["queued", "indexing"].includes(indexes[repo.id]?.status) && (
                    <div className="mg-meter" style={{ width: 220 }}>
                      <i style={{ width: `${indexes[repo.id]?.progress?.total ? Math.min((indexes[repo.id].progress.current / indexes[repo.id].progress.total) * 100, 100) : 8}%` }} />
                    </div>
                  )}
                </div>
                <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                  <StatusDot ok={repo.status === "ready"} label={repo.status} />
                  <button className="ct-btn-quiet" disabled={!!busy || ["queued", "indexing"].includes(indexes[repo.id]?.status)}
                    onClick={() => reindex(repo.id)}>{busy === `reindex-${repo.id}` ? "Queuing…" : "Reindex"}</button>
                  <button className="ct-btn-quiet" onClick={() => setOpen(repo.id)}>Open</button>
                </span>
              </div>
            ))}
          </div>

          <div className="mg-label">Connect</div>
          <div className="mg-card">
            {!installations.length ? (
              <div className="mg-row">
                <div>GitHub App<div className="ct-hint">Install once; pick repositories from your account.</div></div>
                <button className="ct-btn" disabled={!!busy} onClick={installGithub}>{busy === "install" ? "Opening…" : "Install"}</button>
              </div>
            ) : (
              <>
                {available.filter((r) => !connectedIds.has(r.fullName?.toLowerCase())).slice(0, 8).map((r) => (
                  <div className="mg-row" key={r.id}>
                    <div>{r.fullName}<div className="ct-hint">{r.private ? "private" : "public"}</div></div>
                    <button className="ct-btn-quiet" disabled={!!busy} onClick={() => connectFromGithub(r)}>
                      {busy === `connect-${r.id}` ? "Connecting…" : "Connect"}
                    </button>
                  </div>
                ))}
                <div className="mg-row">
                  <div className="ct-hint">Missing a repository? Update the GitHub App's repository access.</div>
                  <button className="ct-btn-quiet" disabled={!!busy} onClick={installGithub}>Manage access</button>
                </div>
              </>
            )}
            <form onSubmit={addManual} style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input className="mg-input" placeholder="Or add by name — owner/repo" value={manualName}
                onChange={(e) => setManualName(e.target.value)} />
              <button className="ct-btn-quiet" disabled={!!busy || !manualName.trim()}>{busy === "manual" ? "Adding…" : "Add"}</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

function RepoDetail({ repo, index, agents, onBack, onSentence, onOpenRun, onAgentsChanged }) {
  const [pulls, setPulls] = useState(null);
  const [automations, setAutomations] = useState(null);
  const [latestRun, setLatestRun] = useState(null);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState("code");
  const [searchResults, setSearchResults] = useState(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const primaryAgent = agents[0] || null;

  useEffect(() => {
    repositoryPulls(repo.id).then((r) => setPulls(r.pulls || [])).catch(() => setPulls([]));
    listAutomations().then((r) => setAutomations((r.automations || []).filter((a) => a.repositoryId === repo.id))).catch(() => setAutomations([]));
    if (primaryAgent) getLatestRun(primaryAgent.id).then((r) => setLatestRun(r.run)).catch(() => {});
  }, [repo.id, primaryAgent?.id]);

  async function search(e) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearchBusy(true); setError("");
    try {
      const result = searchMode === "code"
        ? await searchRepository(repo.id, searchQuery)
        : await searchRepositorySymbols(repo.id, searchQuery);
      setSearchResults(searchMode === "code" ? (result.results || []) : (result.symbols || []));
    } catch (err) { setError(err.message); setSearchResults([]); } finally { setSearchBusy(false); }
  }

  async function toggleAutomation(automation) {
    try {
      const result = await updateAutomation(automation.id, { enabled: !automation.enabled });
      setAutomations((c) => c.map((a) => (a.id === automation.id ? result.automation : a)));
    } catch (err) { setError(err.message); }
  }
  async function removeAutomation(automation) {
    try {
      await deleteAutomation(automation.id);
      setAutomations((c) => c.filter((a) => a.id !== automation.id));
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <button className="ct-btn-quiet" onClick={onBack}>← All repositories</button>
      <h3 style={{ marginTop: 10 }}>{repo.fullName}</h3>
      <p className="mg-sub">{repo.defaultBranch} · {repo.private ? "private" : "public"} · {index?.status === "ready" ? `${index.fileCount} files indexed` : index?.status || "not indexed"}</p>
      {error && <div className="mg-error">{error}</div>}

      {latestRun && (
        <div className="mg-card">
          <div className="mg-row">
            <div>Latest run<div className="ct-hint">{String(latestRun.prompt || "").slice(0, 90)} · {latestRun.state}</div></div>
            <button className="ct-btn-quiet" onClick={() => onOpenRun(latestRun.id)}>Open</button>
          </div>
        </div>
      )}

      <div className="mg-label">Open pull requests</div>
      <div className="mg-card">
        {pulls === null && <SkeletonRows rows={2} />}
        {pulls?.length === 0 && <div className="ct-hint">No open pull requests — new ones appear here, and the team can review any of them for you.</div>}
        {(pulls || []).map((pull) => (
          <div className="mg-row" key={pull.number}>
            <div>#{pull.number} {pull.title}<div className="ct-hint">{pull.author ? `by ${pull.author}` : ""}{pull.draft ? " · draft" : ""}</div></div>
            <button className="ct-btn-quiet" onClick={() => onSentence(`Review pull request #${pull.number} on ${repo.fullName}.`)}>Review</button>
          </div>
        ))}
      </div>

      <div className="mg-label">Automations</div>
      <div className="mg-card">
        {automations === null && <SkeletonRows rows={1} />}
        {automations?.length === 0 && (
          <div className="mg-row">
            <div className="ct-hint">None yet — just ask, e.g. “review every new PR here”.</div>
            <button className="ct-btn-quiet" onClick={() => onSentence(`Review every new pull request on ${repo.fullName} automatically.`)}>Ask</button>
          </div>
        )}
        {(automations || []).map((automation) => (
          <div className="mg-row" key={automation.id}>
            <div>{automation.kind === "pr_review" ? "Automatic PR review" : `Scheduled task · every ${automation.intervalHours}h`}
              <div className="ct-hint">{automation.config?.prompt?.slice(0, 80) || (automation.enabled ? "enabled" : "paused")}</div></div>
            <span style={{ display: "flex", gap: 6 }}>
              <button className="ct-btn-quiet" onClick={() => toggleAutomation(automation)}>{automation.enabled ? "Pause" : "Resume"}</button>
              <button className="ct-btn-quiet" onClick={() => removeAutomation(automation)}>Delete</button>
            </span>
          </div>
        ))}
      </div>

      {primaryAgent && (
        <>
          <div className="mg-label">Policies</div>
          <AgentPolicy agent={primaryAgent}
            onChange={(agentId, patch) => updateAgent(agentId, patch).then(onAgentsChanged)} />
        </>
      )}

      <div className="mg-label">Search the index</div>
      <div className="mg-card">
        <form onSubmit={search} style={{ display: "flex", gap: 8 }}>
          <select className="mg-select" style={{ width: 130 }} value={searchMode} onChange={(e) => { setSearchMode(e.target.value); setSearchResults(null); }}>
            <option value="code">Code</option>
            <option value="symbols">Symbols</option>
          </select>
          <input className="mg-input" placeholder="Search source or definitions…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          <button className="ct-btn" disabled={searchBusy || !searchQuery.trim()}>{searchBusy ? "…" : "Search"}</button>
        </form>
        {searchResults !== null && (
          <div style={{ marginTop: 10 }}>
            {!searchResults.length && <div className="ct-hint">No matches.</div>}
            {searchResults.slice(0, 12).map((r, i) => (
              <div key={i} className="mg-row">
                <div style={{ minWidth: 0 }}>
                  <span className="mg-mono">{r.path || r.file}{r.line ? `:${r.line}` : ""}</span>
                  <div className="ct-hint" style={{ whiteSpace: "pre-wrap" }}>{(r.excerpt || r.signature || r.name || "").slice(0, 200)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
