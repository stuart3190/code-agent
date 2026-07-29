import { useEffect, useMemo, useState } from "react";
import {
  deleteCapability, deleteConnectorWorkflow, disconnectConnector, getCapabilityOverview, getConnectorOverview, getConnectorWorkflows,
  saveActionSchedule, saveCapability, saveConnector, saveConnectorWorkflow, saveKnowledgeBase, startConnectorOAuth, testConnector,
} from "../lib/api.js";

const CONFIGURABLE = new Set(["custom_api", "slack_webhook", "discord_webhook"]);
const GOOGLE = new Set(["google_drive", "google_sheets", "gmail", "google_calendar"]);
const OAUTH = new Set([...GOOGLE, "meta"]);

const FEATURE_PACKS = [
  { id: "ai_app", mark: "AI", title: "Smart AI app", description: "Add working chat, text analysis, structured results and image generation.",
    presetIds: ["ai_text", "ai_structured", "ai_image"], credentialProvider: "openai", credentialLabel: "OpenAI API key", credentialUrl: "https://platform.openai.com/api-keys" },
  { id: "ugc_video", mark: "UGC", title: "UGC video maker", description: "Turn uploaded pictures into AI clips, finish them for social media and optimise the images.",
    presetIds: ["replicate_video", "media_finish", "image_convert"], credentialProvider: "replicate", credentialLabel: "Replicate API token", credentialUrl: "https://replicate.com/account/api-tokens" },
  { id: "meta_publishing", mark: "META", title: "Meta publishing", description: "Connect Facebook Pages and ad accounts for scheduled organic posts and paid static ads.",
    presetIds: ["meta_accounts", "meta_page_post", "meta_create_ad"], platformProvider: "meta" },
  { id: "documents", mark: "DOC", title: "Document tools", description: "Extract and merge PDFs, optimise images and create downloadable ZIP files.",
    presetIds: ["pdf_extract", "pdf_merge", "archive", "image_convert"] },
  { id: "knowledge", mark: "KB", title: "Knowledge assistant", description: "Upload private information, search it and build a support bot or learning app around it.",
    presetIds: ["knowledge_ingest", "knowledge_search", "ai_text"], credentialProvider: "openai", credentialLabel: "OpenAI API key", credentialUrl: "https://platform.openai.com/api-keys", knowledgeBase: true },
];

function statusClass(connector) {
  if (connector.connected) return "border-emerald-500/30 bg-emerald-500/5";
  if (connector.status === "error") return "border-red-500/30 bg-red-500/5";
  return "border-line bg-ink-900/70";
}

function ConnectorMark({ id }) {
  const marks = { custom_api: "API", google_drive: "DR", google_sheets: "SH", gmail: "GM", google_calendar: "CA", meta: "META",
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
  const [capabilities, setCapabilities] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [packBusy, setPackBusy] = useState("");
  const [packSetup, setPackSetup] = useState("");
  const [packCredentials, setPackCredentials] = useState({});
  const [capabilityDraft, setCapabilityDraft] = useState({ presetId: "ai_text", key: "ai_text", name: "AI text & vision", executionMode: "managed", credential: "", baseUrl: "", apiPath: "/", method: "POST", model: "", endUserUnitCost: 0, freeAllowance: 0, rateLimitPerHour: 20, timeoutSeconds: 300 });
  const [knowledgeDraft, setKnowledgeDraft] = useState({ key: "support", name: "Support knowledge" });
  const [scheduleDraft, setScheduleDraft] = useState({ actionId: "", name: "Daily automation", intervalMinutes: 1440, input: "{}" });

  async function refresh({ quiet = false } = {}) {
    if (!quiet) setBusy(true);
    setError("");
    try {
      const [nextOverview, nextWorkflows, nextCapabilities] = await Promise.all([getConnectorOverview(projectId), getConnectorWorkflows(projectId), getCapabilityOverview(projectId)]);
      setOverview(nextOverview);
      setWorkflows(nextWorkflows);
      setCapabilities(nextCapabilities);
    } catch (err) { setError(err.message || String(err)); }
    finally { if (!quiet) setBusy(false); }
  }

  useEffect(() => { refresh(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!capabilities || capabilityDraft.executionMode !== "managed") return;
    const preset = capabilities.presets?.find((item) => item.id === capabilityDraft.presetId);
    const managedReady = preset?.provider === "openai" ? capabilities.credentials?.managedOpenAI
      : preset?.provider === "replicate" ? capabilities.credentials?.managedReplicate : true;
    if (!managedReady && preset?.modes?.includes("byok")) setCapabilityDraft((value) => ({ ...value, executionMode: "byok" }));
  }, [capabilities, capabilityDraft.executionMode, capabilityDraft.presetId]);

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
  const actionKeys = useMemo(() => new Set((capabilities?.actions || []).map((item) => item.key)), [capabilities]);
  const visibleConnectors = useMemo(() => (overview?.connectors || []).filter((item) => item.connected || item.available || !GOOGLE.has(item.id)), [overview]);
  const hiddenGoogleCount = (overview?.connectors || []).filter((item) => GOOGLE.has(item.id) && !item.connected && !item.available).length;

  function providerReady(provider) {
    if (provider === "openai") return !!(capabilities?.credentials?.managedOpenAI || capabilities?.credentials?.openai);
    if (provider === "replicate") return !!(capabilities?.credentials?.managedReplicate || capabilities?.credentials?.replicate);
    return true;
  }

  function presetProvider(preset) {
    return preset?.provider === "knowledge" ? "openai" : preset?.provider;
  }

  function executionMode(preset) {
    if (preset?.modes?.includes("internal")) return "internal";
    const ready = presetProvider(preset) === "openai" ? capabilities?.credentials?.managedOpenAI
      : presetProvider(preset) === "replicate" ? capabilities?.credentials?.managedReplicate : false;
    if (ready && preset?.modes?.includes("managed")) return "managed";
    return preset?.modes?.includes("byok") ? "byok" : preset?.modes?.[0];
  }

  async function addFeaturePack(pack) {
    const credential = String(packCredentials[pack.id] || "").trim();
    if (pack.credentialProvider && !providerReady(pack.credentialProvider) && !credential) {
      setError(`Paste your ${pack.credentialLabel} first. It is encrypted when saved.`);
      return;
    }
    setBusy(true); setPackBusy(pack.id); setError(""); setNotice("");
    try {
      const definitions = pack.presetIds.map((id) => (capabilities?.presets || []).find((item) => item.id === id));
      if (definitions.some((item) => !item)) throw new Error("This feature pack is not available yet.");
      let credentialSaved = false;
      for (const preset of definitions) {
        const usesPackCredential = presetProvider(preset) === pack.credentialProvider;
        await saveCapability(projectId, {
          presetId: preset.id, key: preset.id, name: preset.name, executionMode: executionMode(preset),
          credential: usesPackCredential && !credentialSaved ? credential : "", config: preset.config || {},
          endUserUnitCost: 0, freeAllowance: 0, rateLimitPerHour: 20, timeoutSeconds: 300,
        });
        if (usesPackCredential && credential) credentialSaved = true;
      }
      if (pack.knowledgeBase) await saveKnowledgeBase(projectId, { key: "app_knowledge", name: "App knowledge" });
      setPackCredentials((value) => ({ ...value, [pack.id]: "" }));
      setPackSetup("");
      setNotice(`${pack.title} is ready. The builder can now wire these features into this app.`);
      await refresh({ quiet: true });
    } catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); setPackBusy(""); }
  }

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

  function choosePreset(presetId) {
    const preset = (capabilities?.presets || []).find((item) => item.id === presetId);
    if (!preset) return;
    const managedReady = preset.provider === "openai" ? capabilities?.credentials?.managedOpenAI
      : preset.provider === "replicate" ? capabilities?.credentials?.managedReplicate : true;
    const mode = preset.modes[0] === "managed" && !managedReady && preset.modes.includes("byok") ? "byok" : preset.modes[0];
    setCapabilityDraft((value) => ({ ...value, presetId, key: preset.id, name: preset.name,
      executionMode: mode, model: preset.config?.model || "" }));
  }

  async function addCapability() {
    const preset = (capabilities?.presets || []).find((item) => item.id === capabilityDraft.presetId);
    if (!preset) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const config = { ...(preset.config || {}) };
      if (capabilityDraft.model) config.model = capabilityDraft.model;
      if (preset.provider === "http") { config.base_url = capabilityDraft.baseUrl; config.path = capabilityDraft.apiPath; config.method = capabilityDraft.method; }
      await saveCapability(projectId, { ...capabilityDraft, config });
      setCapabilityDraft((value) => ({ ...value, credential: "" }));
      setNotice(`${capabilityDraft.name} is ready for generated apps.`);
      await refresh({ quiet: true });
    } catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  async function removeCapability(action) {
    if (!window.confirm(`Remove the runtime action “${action.name}”?`)) return;
    setBusy(true); setError("");
    try { await deleteCapability(projectId, action.id); await refresh({ quiet: true }); }
    catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  async function addKnowledgeBase() {
    setBusy(true); setError("");
    try { await saveKnowledgeBase(projectId, knowledgeDraft); setNotice("Knowledge base is ready."); await refresh({ quiet: true }); }
    catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  async function addSchedule() {
    setBusy(true); setError(""); setNotice("");
    try {
      const actionId = scheduleDraft.actionId || capabilities?.actions?.[0]?.id;
      if (!actionId) throw new Error("Add a runtime action before scheduling it.");
      let input;
      try { input = JSON.parse(scheduleDraft.input || "{}"); } catch { throw new Error("Scheduled input must be valid JSON."); }
      await saveActionSchedule(projectId, { ...scheduleDraft, actionId, input });
      setNotice("Scheduled action is active."); await refresh({ quiet: true });
    } catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 p-4 backdrop-blur-sm sm:p-6">
      <div className="panel max-h-[92vh] w-[66rem] max-w-[98vw] overflow-auto p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-display text-xl font-semibold text-slate-100">Add working features</div>
            <div className="mt-1 max-w-2xl text-xs text-slate-400">Choose what this app should do. Buildr handles the server setup and tells the builder to make the feature work.</div>
          </div>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose} aria-label="Close connector hub">✕</button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-[10px] uppercase tracking-wider">
          <span className="tag bg-emerald-500/10 text-emerald-400">working features</span>
          <span className="tag bg-ink-800 text-slate-300">secure keys</span>
          <span className="tag bg-ink-800 text-slate-300">no coding</span>
        </div>
        {error && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        {notice && <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}
        {oauthUrl && <a className="mt-3 inline-block text-sm text-amber-soft hover:underline" href={oauthUrl} target="_blank" rel="noreferrer">Continue authorization ↗</a>}

        <section className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><div className="font-display text-base font-semibold text-slate-100">What are you building?</div>
              <div className="mt-1 text-xs text-slate-500">You can add more than one pack. Website, login, database and payment features keep working as normal.</div></div>
            <span className="text-[10px] uppercase tracking-wider text-slate-600">one-click setup</span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {FEATURE_PACKS.map((pack) => {
              const installed = pack.presetIds.every((id) => actionKeys.has(id));
              const needsCredential = !!pack.credentialProvider && !providerReady(pack.credentialProvider);
              const connector = pack.connectorProvider ? (overview?.connectors || []).find((item) => item.id === pack.connectorProvider) : null;
              const platformConnector = pack.platformProvider ? (overview?.connectors || []).find((item) => item.id === pack.platformProvider) : null;
              const needsConnector = !!connector && !connector.connected;
              const connectorUnavailable = (needsConnector && !connector.available) || (!!platformConnector && !platformConnector.available);
              const ready = installed && !needsConnector;
              return <div key={pack.id} className={`rounded-xl border p-4 ${ready ? "border-emerald-500/30 bg-emerald-500/5" : "border-line bg-ink-900/70"}`}>
                <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink-800 font-mono text-[10px] font-semibold text-amber-soft">{pack.mark}</span>
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-slate-100">{pack.title}</span>
                    {ready && <span className="text-[9px] uppercase tracking-wider text-emerald-400">ready</span>}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{pack.description}</div></div></div>
                {needsCredential && !installed && packSetup === pack.id && <label className="mt-4 block text-[11px] text-slate-400">One thing needed: {pack.credentialLabel}
                  <input className="input mt-1 w-full font-mono text-xs" type="password" autoComplete="off" value={packCredentials[pack.id] || ""}
                    placeholder={`Paste ${pack.credentialLabel}`} onChange={(e) => setPackCredentials((value) => ({ ...value, [pack.id]: e.target.value }))} />
                  <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-600"><span>Encrypted and never placed in the generated website.</span>
                    <a className="shrink-0 text-amber-soft hover:underline" href={pack.credentialUrl} target="_blank" rel="noreferrer">Get key ↗</a></span>
                </label>}
                {connectorUnavailable && <div className="mt-4 rounded-lg border border-amber/20 bg-amber/5 px-3 py-2 text-[10px] text-amber-soft">One-time Buildr Meta app setup is needed before accounts can connect.</div>}
                <button className={ready ? "btn-ghost mt-4 w-full text-xs" : "btn-primary mt-4 w-full px-4 py-2 text-xs"}
                  disabled={busy || ready || connectorUnavailable || (needsCredential && packSetup === pack.id && !String(packCredentials[pack.id] || "").trim())}
                  onClick={() => needsConnector ? connectOAuth(connector) : needsCredential && packSetup !== pack.id ? setPackSetup(pack.id) : addFeaturePack(pack)}>
                  {ready ? "Added" : connectorUnavailable ? "Meta setup required" : needsConnector ? "Connect Meta" : packBusy === pack.id ? "Adding features…" : needsCredential && packSetup !== pack.id ? `Set up ${pack.title}` : `Add ${pack.title}`}
                </button>
              </div>;
            })}
          </div>
        </section>

        <div className="mt-6 rounded-xl border border-line bg-ink-900/45 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-sm font-medium text-slate-200">Need a custom connection or automation?</div>
            <div className="mt-1 text-[11px] text-slate-500">Only open this if you need your own API, webhook or fine control over a feature.</div></div>
            <button className="btn-ghost text-xs" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide advanced settings" : "Show advanced settings"}</button></div>
        </div>

        {showAdvanced && <>

        <section className="mt-6 rounded-xl border border-amber/25 bg-gradient-to-br from-amber/10 to-ink-900/80 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="font-display text-base font-semibold text-slate-100">Runtime actions</div>
              <div className="mt-1 text-xs text-slate-400">Secure capabilities the builder wires through <span className="font-mono text-amber-soft">actions.invoke()</span>.</div></div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{capabilities?.actions?.length || 0} configured</div>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-4">
            <label className="text-xs text-slate-400">Capability<select className="input mt-1 w-full text-sm" value={capabilityDraft.presetId} onChange={(e) => choosePreset(e.target.value)}>
              {(capabilities?.presets || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="text-xs text-slate-400">Action key<input className="input mt-1 w-full font-mono text-sm" value={capabilityDraft.key} onChange={(e) => setCapabilityDraft((v) => ({ ...v, key: e.target.value }))} /></label>
            <label className="text-xs text-slate-400">Mode<select className="input mt-1 w-full text-sm" value={capabilityDraft.executionMode} onChange={(e) => setCapabilityDraft((v) => ({ ...v, executionMode: e.target.value }))}>
              {((capabilities?.presets || []).find((item) => item.id === capabilityDraft.presetId)?.modes || []).map((mode) => <option key={mode}>{mode}</option>)}</select></label>
            <label className="text-xs text-slate-400">End-user units<input className="input mt-1 w-full text-sm" type="number" min="0" value={capabilityDraft.endUserUnitCost} onChange={(e) => setCapabilityDraft((v) => ({ ...v, endUserUnitCost: Number(e.target.value) }))} /></label>
            <label className="text-xs text-slate-400">Free uses per user<input className="input mt-1 w-full text-sm" type="number" min="0" value={capabilityDraft.freeAllowance} onChange={(e) => setCapabilityDraft((v) => ({ ...v, freeAllowance: Number(e.target.value) }))} /></label>
            <label className="text-xs text-slate-400">Hourly user limit<input className="input mt-1 w-full text-sm" type="number" min="1" max="1000" value={capabilityDraft.rateLimitPerHour} onChange={(e) => setCapabilityDraft((v) => ({ ...v, rateLimitPerHour: Number(e.target.value) }))} /></label>
            <label className="text-xs text-slate-400">Timeout seconds<input className="input mt-1 w-full text-sm" type="number" min="5" max="3600" value={capabilityDraft.timeoutSeconds} onChange={(e) => setCapabilityDraft((v) => ({ ...v, timeoutSeconds: Number(e.target.value) }))} /></label>
            {capabilityDraft.presetId === "safe_http" && <><label className="text-xs text-slate-400 lg:col-span-2">Public HTTPS base URL<input className="input mt-1 w-full font-mono text-sm" value={capabilityDraft.baseUrl} placeholder="https://api.example.com" onChange={(e) => setCapabilityDraft((v) => ({ ...v, baseUrl: e.target.value }))} /></label>
              <label className="text-xs text-slate-400">Method<select className="input mt-1 w-full text-sm" value={capabilityDraft.method} onChange={(e) => setCapabilityDraft((v) => ({ ...v, method: e.target.value }))}>{["GET","POST","PUT","PATCH","DELETE"].map((method) => <option key={method}>{method}</option>)}</select></label>
              <label className="text-xs text-slate-400">Path<input className="input mt-1 w-full font-mono text-sm" value={capabilityDraft.apiPath} placeholder="/v1/items" onChange={(e) => setCapabilityDraft((v) => ({ ...v, apiPath: e.target.value }))} /></label></>}
            {!["media_finish","image_convert"].includes(capabilityDraft.presetId) && capabilityDraft.executionMode === "byok" && <label className="text-xs text-slate-400 lg:col-span-2">Provider credential<input className="input mt-1 w-full font-mono text-sm" type="password" autoComplete="off" value={capabilityDraft.credential} placeholder="Encrypted; blank keeps the saved key" onChange={(e) => setCapabilityDraft((v) => ({ ...v, credential: e.target.value }))} /></label>}
          </div>
          <div className="mt-4 flex justify-end"><button className="btn-primary px-4 py-2 text-xs" disabled={busy} onClick={addCapability}>Add real capability</button></div>
          <div className="mt-5 grid gap-2 md:grid-cols-2">
            {(capabilities?.actions || []).map((action) => <div key={action.id} className="rounded-lg border border-line bg-ink-950/55 p-3">
              <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium text-slate-100">{action.name}</div><div className="mt-1 font-mono text-[10px] text-amber-soft">{action.key}</div></div>
                <span className={`text-[9px] uppercase tracking-wider ${action.enabled ? "text-emerald-400" : "text-slate-600"}`}>{action.execution_mode}</span></div>
              <div className="mt-2 text-[11px] text-slate-500">{action.provider} / {action.operation} · max {Number(action.config?.max_credits || 0).toFixed(2)} credits · {action.end_user_unit_cost} app units</div>
              <button className="mt-3 text-xs text-red-300 hover:text-red-200" disabled={busy} onClick={() => removeCapability(action)}>Remove</button>
            </div>)}
            {!capabilities?.actions?.length && <div className="rounded-lg border border-dashed border-line p-5 text-sm text-slate-500 md:col-span-2">No runtime actions yet. Add one and the builder can create a working app around it.</div>}
          </div>
        </section>

        <section className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-ink-900/70 p-4"><div className="text-sm font-medium text-slate-100">Knowledge bases</div>
            <div className="mt-1 text-xs text-slate-500">Private vector search for support, learning and document apps.</div>
            <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2"><input className="input font-mono text-xs" value={knowledgeDraft.key} onChange={(e) => setKnowledgeDraft((v) => ({ ...v, key: e.target.value }))} />
              <input className="input text-xs" value={knowledgeDraft.name} onChange={(e) => setKnowledgeDraft((v) => ({ ...v, name: e.target.value }))} /><button className="btn-ghost text-xs" disabled={busy} onClick={addKnowledgeBase}>Add</button></div>
            <div className="mt-3 flex flex-wrap gap-2">{(capabilities?.knowledgeBases || []).map((base) => <span key={base.id} className="tag bg-ink-800 text-slate-300">{base.key}</span>)}</div>
          </div>
          <div className="rounded-xl border border-line bg-ink-900/70 p-4"><div className="text-sm font-medium text-slate-100">Recent runtime jobs</div>
            <div className="mt-3 space-y-2">{(capabilities?.jobs || []).slice(0,5).map((job) => <div key={job.id} className="flex items-center gap-3 text-xs"><span className={`h-2 w-2 rounded-full ${job.status === "succeeded" ? "bg-emerald-400" : job.status === "failed" ? "bg-red-400" : "bg-amber-soft"}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{job.action_key}</span><span className="text-slate-500">{job.status} · {job.progress}%</span></div>)}
              {!capabilities?.jobs?.length && <div className="text-xs text-slate-500">Jobs will appear here with live progress and charges.</div>}</div>
          </div>
        </section>

        <section className="mt-5 rounded-xl border border-line bg-ink-900/70 p-4">
          <div className="text-sm font-medium text-slate-100">Scheduled automations</div>
          <div className="mt-1 text-xs text-slate-500">Run a configured action every few minutes, hourly or daily without keeping a browser open.</div>
          <div className="mt-3 grid gap-2 lg:grid-cols-4">
            <select className="input text-xs" value={scheduleDraft.actionId || capabilities?.actions?.[0]?.id || ""} onChange={(e) => setScheduleDraft((v) => ({ ...v, actionId: e.target.value }))}><option value="" disabled>Choose action</option>{(capabilities?.actions || []).map((action) => <option key={action.id} value={action.id}>{action.key}</option>)}</select>
            <input className="input text-xs" value={scheduleDraft.name} onChange={(e) => setScheduleDraft((v) => ({ ...v, name: e.target.value }))} placeholder="Automation name" />
            <input className="input text-xs" type="number" min="5" value={scheduleDraft.intervalMinutes} onChange={(e) => setScheduleDraft((v) => ({ ...v, intervalMinutes: Number(e.target.value) }))} aria-label="Interval in minutes" />
            <button className="btn-ghost text-xs" disabled={busy || !capabilities?.actions?.length} onClick={addSchedule}>Add schedule</button>
            <textarea className="input min-h-20 font-mono text-xs lg:col-span-4" value={scheduleDraft.input} onChange={(e) => setScheduleDraft((v) => ({ ...v, input: e.target.value }))} aria-label="Scheduled JSON input" />
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">{(capabilities?.schedules || []).map((schedule) => <div key={schedule.id} className="rounded-lg border border-line bg-ink-950/50 px-3 py-2 text-xs text-slate-300"><span className="font-medium">{schedule.name}</span><span className="ml-2 text-slate-500">every {schedule.schedule} min · next {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "pending"}</span></div>)}</div>
        </section>

        <div className="mt-8 border-t border-line pt-6"><div className="font-display text-base font-semibold text-slate-100">Connections and event workflows</div><div className="mt-1 text-xs text-slate-500">OAuth data sources, notifications, Stripe and GitHub stay available alongside runtime actions.</div></div>

        {busy && !overview ? <div className="mt-8 text-sm text-slate-400">Loading connectors…</div> : (
          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleConnectors.map((connector) => {
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
                    ) : OAUTH.has(connector.id) ? (
                      <button className="btn-ghost text-xs" disabled={busy || (!connector.available && !connector.connected)} onClick={() => connector.connected ? runTest(connector.id) : connectOAuth(connector)}>
                        {!connector.available && !connector.connected ? "Platform setup needed" : connector.connected ? "Test" : "Connect"}
                      </button>
                    ) : (
                      <button className="btn-ghost text-xs" disabled={busy} onClick={() => configure(connector)}>{connector.connected ? "Settings" : "Connect"}</button>
                    )}
                    {connector.connected && (CONFIGURABLE.has(connector.id) || OAUTH.has(connector.id)) && (
                      <button className="text-xs text-red-300 hover:text-red-200" disabled={busy} onClick={() => removeConnector(connector.id)}>Disconnect</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!!hiddenGoogleCount && <div className="mt-3 rounded-lg border border-line bg-ink-900/45 px-3 py-2 text-[11px] text-slate-500">Google Drive, Sheets, Gmail and Calendar are hidden because Google connection setup is not enabled on Buildr yet. They will only appear when they can actually connect.</div>}

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
        </>}
      </div>
    </div>
  );
}
