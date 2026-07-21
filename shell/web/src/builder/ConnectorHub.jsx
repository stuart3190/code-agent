import { useEffect, useMemo, useState } from "react";
import {
  deleteConnectorWorkflow, disconnectConnector, getConnectorOverview, getConnectorWorkflows,
  saveConnector, saveConnectorWorkflow, startConnectorOAuth, testConnector,
} from "../lib/api.js";

const CONFIGURABLE = new Set(["custom_api", "slack_webhook", "discord_webhook"]);
const GOOGLE = new Set(["google_drive", "google_sheets", "gmail", "google_calendar"]);

function statusClass(connector) {
  if (connector.connected) return "border-emerald-500/30 bg-emerald-500/5";
  if (connector.status === "error") return "border-red-500/30 bg-red-500/5";
  return "border-line bg-ink-900/70";
}

function ConnectorMark({ id }) {
  const marks = { custom_api: "API", google_drive: "DR", google_sheets: "SH", gmail: "GM", google_calendar: "CA",
    slack_webhook: "SL", discord_webhook: "DI", app_actions: "EV", stripe_connect: "ST", github: "GH" };
  return <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-800 font-mono text-[10px] font-semibold text-amber-soft">{marks[id] || "CN"}</span>;
}

export default function ConnectorHub({ projectId, githubAllowed, onClose, onOpenPayments, onOpenGithub, onOpenDelivery }) {
  const [overview, setOverview] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [active, setActive] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [oauthUrl, setOauthUrl] = useState("");
  const [draft, setDraft] = useState({ label: "", baseUrl: "", contextPath: "/", headerName: "Authorization", token: "", webhookUrl: "", useInBuilder: true });
  const [workflowDraft, setWorkflowDraft] = useState({ name: "", triggerEvent: "lead.created", actionProvider: "app_email" });

  async function refresh({ quiet = false } = {}) {
    if (!quiet) setBusy(true);
    setError("");
    try {
      const [nextOverview, nextWorkflows] = await Promise.all([getConnectorOverview(projectId), getConnectorWorkflows(projectId)]);
      setOverview(nextOverview);
      setWorkflows(nextWorkflows);
    } catch (err) { setError(err.message || String(err)); }
    finally { if (!quiet) setBusy(false); }
  }

  useEffect(() => { refresh(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== window.location.origin || !event.data?.__buildrConnector) return;
      if (event.data.ok) { setNotice(`${event.data.provider?.replaceAll("_", " ") || "Connector"} connected.`); refresh({ quiet: true }); }
      else setError(event.data.error || "Connection failed.");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = useMemo(() => new Set((overview?.connectors || []).filter((item) => item.connected).map((item) => item.id)), [overview]);

  function configure(connector) {
    setActive(connector.id); setError(""); setNotice(""); setOauthUrl("");
    setDraft({
      label: connector.config?.label || "", baseUrl: connector.config?.base_url || "",
      contextPath: connector.config?.context_path || "/", headerName: connector.config?.header_name || "Authorization",
      token: "", webhookUrl: "", useInBuilder: connector.config?.use_in_builder !== false,
    });
  }

  async function connectOAuth(connector) {
    setError(""); setNotice(""); setOauthUrl("");
    const popup = window.open("", "buildr-connector-oauth", "popup,width=620,height=760");
    setBusy(true);
    try {
      const result = await startConnectorOAuth(projectId, connector.id);
      if (popup) popup.location.href = result.authorizationUrl;
      else setOauthUrl(result.authorizationUrl);
    } catch (err) { popup?.close(); setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  async function saveActive() {
    if (!active) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await saveConnector(projectId, { provider: active, ...draft });
      setDraft((value) => ({ ...value, token: "", webhookUrl: "" }));
      setNotice("Connector saved. Connecting and testing do not use credits.");
      await refresh({ quiet: true });
    } catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  async function runTest(provider) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await testConnector(projectId, provider);
      setNotice(result.detail || "Connection test passed.");
      await refresh({ quiet: true });
    } catch (err) { setError(err.message || String(err)); await refresh({ quiet: true }); }
    finally { setBusy(false); }
  }

  async function removeConnector(provider) {
    if (!window.confirm("Disconnect this connector and erase its stored credential?")) return;
    setBusy(true); setError(""); setNotice("");
    try { await disconnectConnector(projectId, provider); setActive(null); setNotice("Connector disconnected."); await refresh({ quiet: true }); }
    catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  function openBuiltIn(kind) {
    onClose();
    if (kind === "stripe_connect") onOpenPayments();
    else if (kind === "github") onOpenGithub();
    else onOpenDelivery();
  }

  async function addWorkflow() {
    setBusy(true); setError(""); setNotice("");
    try {
      await saveConnectorWorkflow(projectId, workflowDraft);
      setWorkflowDraft({ name: "", triggerEvent: "lead.created", actionProvider: "app_email" });
      setNotice("Workflow is live. Workflow deliveries do not use credits.");
      await refresh({ quiet: true });
    } catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  async function toggleWorkflow(workflow) {
    setBusy(true); setError("");
    try {
      await saveConnectorWorkflow(projectId, { id: workflow.id, name: workflow.name, triggerEvent: workflow.trigger_event,
        actionProvider: workflow.action_provider, enabled: !workflow.enabled });
      await refresh({ quiet: true });
    } catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  async function removeWorkflow(workflow) {
    if (!window.confirm(`Delete workflow “${workflow.name}”?`)) return;
    setBusy(true); setError("");
    try { await deleteConnectorWorkflow(projectId, workflow.id); await refresh({ quiet: true }); }
    catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 p-4 backdrop-blur-sm sm:p-6">
      <div className="panel max-h-[92vh] w-[66rem] max-w-[98vw] overflow-auto p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-display text-xl font-semibold text-slate-100">Connector Hub</div>
            <div className="mt-1 max-w-2xl text-xs text-slate-400">Connect data and automate app events. Connections and direct actions cost 0 credits; AI building keeps the normal credit meter.</div>
          </div>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose} aria-label="Close connector hub">✕</button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-[10px] uppercase tracking-wider">
          <span className="tag bg-emerald-500/10 text-emerald-400">0-credit setup</span>
          <span className="tag bg-ink-800 text-slate-300">encrypted secrets</span>
          <span className="tag bg-ink-800 text-slate-300">read-only AI access</span>
          <span className="tag bg-ink-800 text-slate-300">write actions need your workflow</span>
        </div>
        {error && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        {notice && <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}
        {oauthUrl && <a className="mt-3 inline-block text-sm text-amber-soft hover:underline" href={oauthUrl} target="_blank" rel="noreferrer">Continue Google authorization ↗</a>}

        {busy && !overview ? <div className="mt-8 text-sm text-slate-400">Loading connectors…</div> : (
          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(overview?.connectors || []).map((connector) => {
              const lockedGithub = connector.id === "github" && !githubAllowed;
              return (
                <div key={connector.id} className={`rounded-xl border p-4 ${statusClass(connector)}`}>
                  <div className="flex items-start gap-3">
                    <ConnectorMark id={connector.id} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="text-sm font-medium text-slate-100">{connector.name}</span>
                        {connector.connected && <span className="text-[9px] uppercase tracking-wider text-emerald-400">connected</span>}</div>
                      <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{connector.description}</div>
                      {connector.config?.account_email && <div className="mt-1 truncate font-mono text-[10px] text-slate-400">{connector.config.account_email}</div>}
                      {connector.lastError && <div className="mt-2 line-clamp-2 text-[10px] text-red-300">{connector.lastError}</div>}
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {["app_actions", "stripe_connect", "github"].includes(connector.id) ? (
                      <button className="btn-ghost text-xs" disabled={lockedGithub} onClick={() => openBuiltIn(connector.id)}>
                        {lockedGithub ? "Paid plan" : connector.connected ? "Manage" : "Open setup"}
                      </button>
                    ) : GOOGLE.has(connector.id) ? (
                      <button className="btn-ghost text-xs" disabled={busy || (!connector.available && !connector.connected)} onClick={() => connector.connected ? runTest(connector.id) : connectOAuth(connector)}>
                        {!connector.available && !connector.connected ? "Platform setup needed" : connector.connected ? "Test" : "Connect"}
                      </button>
                    ) : (
                      <button className="btn-ghost text-xs" disabled={busy} onClick={() => configure(connector)}>{connector.connected ? "Settings" : "Connect"}</button>
                    )}
                    {connector.connected && (CONFIGURABLE.has(connector.id) || GOOGLE.has(connector.id)) && (
                      <button className="text-xs text-red-300 hover:text-red-200" disabled={busy} onClick={() => removeConnector(connector.id)}>Disconnect</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {active && (
          <section className="mt-7 rounded-xl border border-amber/25 bg-ink-900/70 p-4">
            <div className="flex items-center justify-between gap-3"><div className="text-sm font-medium text-slate-100">Configure {(overview?.connectors || []).find((item) => item.id === active)?.name}</div>
              <button className="text-xs text-slate-500 hover:text-slate-300" onClick={() => setActive(null)}>Close</button></div>
            {active === "custom_api" ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-slate-400">Connection name<input className="input mt-1 w-full text-sm" value={draft.label} placeholder="My CRM" onChange={(e) => setDraft((v) => ({ ...v, label: e.target.value }))} /></label>
                <label className="text-xs text-slate-400">HTTPS base URL<input className="input mt-1 w-full text-sm" value={draft.baseUrl} placeholder="https://api.example.com" onChange={(e) => setDraft((v) => ({ ...v, baseUrl: e.target.value }))} /></label>
                <label className="text-xs text-slate-400">Read endpoint<input className="input mt-1 w-full font-mono text-sm" value={draft.contextPath} placeholder="/v1/search" onChange={(e) => setDraft((v) => ({ ...v, contextPath: e.target.value }))} /></label>
                <label className="text-xs text-slate-400">Authentication<select className="input mt-1 w-full text-sm" value={draft.headerName} onChange={(e) => setDraft((v) => ({ ...v, headerName: e.target.value }))}><option>Authorization</option><option>X-API-Key</option></select></label>
                <label className="text-xs text-slate-400 sm:col-span-2">API token<input className="input mt-1 w-full font-mono text-sm" type="password" autoComplete="off" value={draft.token} placeholder={connected.has(active) ? "Leave blank to keep current token" : "Token"} onChange={(e) => setDraft((v) => ({ ...v, token: e.target.value }))} /></label>
                <label className="flex items-center gap-2 text-xs text-slate-400 sm:col-span-2"><input type="checkbox" checked={draft.useInBuilder} onChange={(e) => setDraft((v) => ({ ...v, useInBuilder: e.target.checked }))} /> Allow read-only use when a build prompt needs this data</label>
              </div>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-slate-400">Connection name<input className="input mt-1 w-full text-sm" value={draft.label} onChange={(e) => setDraft((v) => ({ ...v, label: e.target.value }))} /></label>
                <label className="text-xs text-slate-400">Incoming webhook URL<input className="input mt-1 w-full font-mono text-sm" type="password" autoComplete="off" value={draft.webhookUrl} placeholder={connected.has(active) ? "Leave blank to keep current URL" : "https://…"} onChange={(e) => setDraft((v) => ({ ...v, webhookUrl: e.target.value }))} /></label>
              </div>
            )}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {connected.has(active) && <button className="btn-ghost text-xs" disabled={busy} onClick={() => runTest(active)}>Send test</button>}
              <button className="btn-primary px-4 py-2 text-xs" disabled={busy} onClick={saveActive}>{busy ? "Saving…" : "Save connector"}</button>
            </div>
          </section>
        )}

        <section className="mt-8 border-t border-line pt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><div className="font-display text-base font-semibold text-slate-100">Event workflows</div>
              <div className="mt-1 text-xs text-slate-500">Route events emitted by your generated app. No AI call and no credits per delivery.</div></div>
            <button className="btn-ghost text-xs" onClick={onOpenDelivery}>Configure email, SMS & signed webhook</button>
          </div>
          <div className="mt-4 grid gap-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
            <input className="input text-sm" placeholder="Workflow name" value={workflowDraft.name} onChange={(e) => setWorkflowDraft((v) => ({ ...v, name: e.target.value }))} />
            <input className="input font-mono text-sm" placeholder="booking.created or *" value={workflowDraft.triggerEvent} onChange={(e) => setWorkflowDraft((v) => ({ ...v, triggerEvent: e.target.value }))} />
            <select className="input text-sm" value={workflowDraft.actionProvider} onChange={(e) => setWorkflowDraft((v) => ({ ...v, actionProvider: e.target.value }))}>
              <option value="app_email">Send owner email</option><option value="app_sms">Send owner SMS</option><option value="signed_webhook">Call signed webhook</option>
              {connected.has("slack_webhook") && <option value="slack_webhook">Post to Slack</option>}
              {connected.has("discord_webhook") && <option value="discord_webhook">Post to Discord</option>}
            </select>
            <button className="btn-primary px-4 text-xs" disabled={busy || !workflowDraft.name.trim()} onClick={addWorkflow}>Add workflow</button>
          </div>
          <div className="mt-4 space-y-2">
            {!workflows.length && <div className="rounded-lg border border-dashed border-line px-4 py-5 text-sm text-slate-500">No workflows yet. Generated apps can emit events with <span className="font-mono text-slate-400">notifications.emit()</span>.</div>}
            {workflows.map((workflow) => (
              <div key={workflow.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-ink-900/70 px-3 py-3">
                <button className={`h-5 w-9 rounded-full p-0.5 transition ${workflow.enabled ? "bg-emerald-500" : "bg-ink-700"}`} aria-label={workflow.enabled ? "Disable workflow" : "Enable workflow"} onClick={() => toggleWorkflow(workflow)} disabled={busy}>
                  <span className={`block h-4 w-4 rounded-full bg-white transition ${workflow.enabled ? "translate-x-4" : "translate-x-0"}`} />
                </button>
                <div className="min-w-0 flex-1"><div className="text-sm text-slate-200">{workflow.name}</div><div className="mt-0.5 font-mono text-[10px] text-slate-500">{workflow.trigger_event} → {workflow.action_provider.replaceAll("_", " ")}</div></div>
                {workflow.last_error && <span className="max-w-64 truncate text-[10px] text-red-300" title={workflow.last_error}>{workflow.last_error}</span>}
                {workflow.last_run_at && <span className="text-[10px] text-slate-600">Last run {new Date(workflow.last_run_at).toLocaleString()}</span>}
                <button className="text-xs text-red-300 hover:text-red-200" disabled={busy} onClick={() => removeWorkflow(workflow)}>Delete</button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

