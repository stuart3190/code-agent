import { useEffect, useRef, useState } from "react";
import { downloadProject, downloadAndroid, createBuild, watchBuild, activeBuild, cancelBuild, publishProject, unpublishProject, startPreview, listDomains, connectDomain, removeDomain, getFeatures, startQaRun, waitForQaRun, openQaArtifact, getPaymentOverview, beginStripeOnboarding, savePaymentProduct, deletePaymentProduct, getBrandOverview, applyProjectBrand, getOwnerConsole, setConsoleUserStatus, deleteConsoleRecord, getGithubOverview, connectGithub, exportGithub, disconnectGithub, getIntegrationOverview, saveIntegrationSettings, getProjectAnalytics, getEnvironmentControl, deployTestEnvironment, runReleaseAction, listTemplates, createTemplate, remixTemplate, deleteTemplate } from "../lib/api.js";
import { createProject, saveProject, saveKnowledge, savePublishedUrl, renameProject } from "../lib/projects.js";
import ConnectorHub from "./ConnectorHub.jsx";

// The core loop: describe -> generate -> preview -> iterate. Generation is a detached SERVER-side
// job (/api/generate returns a jobId immediately): the build survives navigating away, and this
// component just observes its coarse phase stream — reattaching on open if one is already running.
export default function Builder({ project, initialPrompt, onProjectChange, onAfterTurn }) {
  const [tree, setTree] = useState(project.tree || null);
  const [prompts, setPrompts] = useState(project.prompts || []);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [text, setText] = useState(initialPrompt || "");
  // Plan mode: toggle ON → the button runs a plan-only pass; the resulting plan is held in
  // pendingPlan (session state — not persisted until a build saves the prompts history; reopening
  // an un-built project drops a held plan) and fed into the next build so it steers generation.
  const [planMode, setPlanMode] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  // The observed background job: coarse phase + id (for cancel) + the running job's mode.
  const [phase, setPhase] = useState(null);
  const [activeJobId, setActiveJobId] = useState(null);
  const [runningMode, setRunningMode] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  // The "Fix it" loop: { kind: "runtime" | "build", message } — runtime errors arrive from the
  // preview iframe's devReporter via postMessage; build failures set a generic message and the
  // SERVER composes the fix prompt from its stored stderr (it never reaches the browser).
  const [appErr, setAppErr] = useState(null);
  const [publishMsg, setPublishMsg] = useState(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState(project.publishedUrl || null);
  // First-publish dialog: pick the site name (<name>.app.buildr101.com).
  const [showPublish, setShowPublish] = useState(false);
  const [siteName, setSiteName] = useState("");
  const [publishErr, setPublishErr] = useState(null);
  // Inline project rename (pencil next to the title).
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name || "");
  // Site menu (consolidates the published-site actions so the header never overflows).
  const [showSite, setShowSite] = useState(false);
  const [showTools, setShowTools] = useState(false);
  // Custom domain popover: connect the user's own domain to the published site.
  const [showDomain, setShowDomain] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [domainInfo, setDomainInfo] = useState(null); // { domains: [...], ip }
  const [domainMsg, setDomainMsg] = useState(null);
  const [domainBusy, setDomainBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [androidBusy, setAndroidBusy] = useState(false);
  const [androidElapsed, setAndroidElapsed] = useState(0);
  const [featureAccess, setFeatureAccess] = useState(null);
  const [qaBusy, setQaBusy] = useState(false);
  const [qaRun, setQaRun] = useState(null);
  const [showQa, setShowQa] = useState(false);
  const [showPayments, setShowPayments] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentData, setPaymentData] = useState(null);
  const [paymentError, setPaymentError] = useState("");
  const [productDraft, setProductDraft] = useState({ name: "", description: "", currency: "gbp", price: "", usageUnits: "" });
  const [showBrand, setShowBrand] = useState(false);
  const [brandBusy, setBrandBusy] = useState(false);
  const [brandData, setBrandData] = useState(null);
  const [brandError, setBrandError] = useState("");
  const [brandKitName, setBrandKitName] = useState("");
  const [brandDraft, setBrandDraft] = useState({
    primary: "#7c3aed", accent: "#f59e0b", background: "#0f172a", surface: "#1e293b", text: "#f8fafc", font: "modern", radius: 12,
  });
  const [showConsole, setShowConsole] = useState(false);
  const [consoleBusy, setConsoleBusy] = useState(false);
  const [consoleData, setConsoleData] = useState(null);
  const [consoleError, setConsoleError] = useState("");
  const [showGithub, setShowGithub] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubData, setGithubData] = useState(null);
  const [githubError, setGithubError] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubPrivate, setGithubPrivate] = useState(true);
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [showConnectorHub, setShowConnectorHub] = useState(false);
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [integrationData, setIntegrationData] = useState(null);
  const [integrationError, setIntegrationError] = useState("");
  const [integrationSecret, setIntegrationSecret] = useState("");
  const [integrationDraft, setIntegrationDraft] = useState({ webhookUrl: "", email: "", phone: "" });
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [showEnvironments, setShowEnvironments] = useState(false);
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [environmentData, setEnvironmentData] = useState(null);
  const [environmentError, setEnvironmentError] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templateError, setTemplateError] = useState("");
  const [templateDraft, setTemplateDraft] = useState({ name: "", description: "", category: "saas" });
  // Project knowledge: standing instructions (brand, tone, constraints) sent with every turn.
  const [knowledge, setKnowledge] = useState(project.knowledge || "");
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [knowledgeMsg, setKnowledgeMsg] = useState(null);
  // Automatic premium art direction by default; existing apps are only redesigned explicitly.
  const [showDesign, setShowDesign] = useState(false);
  const [stylePreset, setStylePreset] = useState(project.designProfile?.preset || "auto");
  const [styleNotes, setStyleNotes] = useState(project.designProfile?.notes || "");
  // Visual edits: click an element in the preview -> the next change is scoped to it.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedEl, setSelectedEl] = useState(null); // { tag, text, outerHTML, path }
  const iframeRef = useRef(null);
  const persistedRef = useRef(!project.transient);

  async function ensurePersisted(name = project.name || "Untitled app") {
    if (persistedRef.current) return project;
    const saved = await createProject(name, project.id);
    persistedRef.current = true;
    onProjectChange?.({ ...saved, transient: false });
    return saved;
  }

  const hasApp = !!tree;
  const mode = hasApp ? "iterate" : "build";

  useEffect(() => {
    let active = true;
    getFeatures().then((result) => { if (active) setFeatureAccess(result.features); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Build-band disclosure: once an app is previewing, the band collapses to a slim one-line
  // composer so the preview owns the window. It auto-opens while a build runs (live timeline),
  // auto-collapses on a passing build, and stays open after a FAIL (the log is the evidence).
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => { if (busy) setDetailsOpen(true); }, [busy]);
  useEffect(() => { if (result?.buildOk) setDetailsOpen(false); }, [result]);

  // Publish/download outcomes surface as a self-dismissing toast (bottom-right).
  useEffect(() => {
    if (!publishMsg) return;
    const t = setTimeout(() => setPublishMsg(null), 6000);
    return () => clearTimeout(t);
  }, [publishMsg]);

  // Listen for the preview's devReporter. Only trust messages from the current preview's origin.
  useEffect(() => {
    if (!previewUrl) return;
    let origin;
    try { origin = new URL(previewUrl).origin; } catch { return; }
    const onMessage = (e) => {
      if (e.origin !== origin) return;
      const d = e.data;
      if (!d) return;
      if (d.__buildr === "runtime-error") {
        setAppErr((cur) => cur || { kind: "runtime", message: d.message, stack: d.stack });
      } else if (d.__buildr === "element-selected") {
        setSelectedEl({ tag: d.tag, text: d.text, outerHTML: d.outerHTML, path: d.path });
        setSelectMode(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [previewUrl]);

  // Toggle select mode inside the preview (the devReporter bridge listens for this).
  function toggleSelectMode() {
    if (!previewUrl || !iframeRef.current) return;
    const next = !selectMode;
    setSelectMode(next);
    try {
      iframeRef.current.contentWindow?.postMessage({ __buildr: "select-mode", on: next }, new URL(previewUrl).origin);
    } catch { setSelectMode(false); }
  }

  // Reopening a saved (already-built) project: bring its live preview back up (no Codex spend).
  useEffect(() => {
    let active = true;
    if (project.tree && !previewUrl) {
      startPreview({ projectId: project.id, tree: project.tree })
        .then((r) => { if (active && r.url) setPreviewUrl(r.url); })
        .catch(() => {});
    }
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Adopt a finished job's result: plan → hold the plan; build → new tree + history + SAVE (the
  // projects row stays client-written under RLS — the server only stores the job result). History
  // entries carry jobId so reattach can tell "already applied" from "finished while I was away".
  async function applyFinishedJob(job, promptLabel, { planUsed = false, clearComposer = false, background = false } = {}) {
    const r = job.result || {};
    if (job.mode === "plan") {
      // Plan-only turn: show the plan, hold it for the next build press, auto-revert the toggle
      // so the toggle and button text always agree ("Generate app" is the next action).
      // DEFERRED: clarifying-question popups slot in HERE — between the plan arriving and the
      // auto-revert — pausing to ask the user before the plan is considered final.
      setPrompts((p) => [...p, {
        prompt: promptLabel, mode: "plan", finalText: r.finalText, at: new Date().toISOString(),
        need: r.need, jobId: job.jobId,
      }]);
      setPendingPlan(r.finalText || null);
      setPlanMode(false);
      setResult({ mode: "plan", ...r });
      return; // no tree/preview/save — the description stays in the box for "Generate app"
    }

    // Each non-plan turn snapshots the full tree so any version can be reverted to (capSnapshots
    // keeps the most recent SNAPSHOT_KEEP snapshots; older entries just drop their tree).
    const nextPrompts = capSnapshots([...prompts, {
      prompt: promptLabel, mode: job.mode, finalText: r.finalText, at: new Date().toISOString(),
      need: r.need, buildOk: r.buildOk, planUsed, jobId: job.jobId, tree: r.tree,
    }]);
    setTree(r.tree);
    setPrompts(nextPrompts);
    setResult({ mode: job.mode, ...r });
    if (r.qualityWarnings?.length) setPublishMsg(r.qualityWarnings.join(" "));
    if (r.buildOk === false) {
      setAppErr({ kind: "build", message: "The app failed to build — “Fix it” sends the error back to the builder." });
    }
    if (r.previewUrl) { setPreviewUrl(r.previewUrl); }
    else if (iframeRef.current) { try { iframeRef.current.contentWindow?.location.reload(); } catch {} }
    if (clearComposer) setText("");
    setPendingPlan(null); // the build consumed the plan
    setSelectedEl(null); // the iterate consumed the selection

    // Background completions keep the current name — the label is a status line, not a prompt.
    const name = project.name && project.name !== "Untitled app" ? project.name
      : background ? (project.name || "Untitled app") : deriveName(promptLabel);
    const saved = await saveProject(project.id, {
      name, tree: r.tree, prompts: nextPrompts, previewRef: r.previewUrl || null,
      designProfile: r.designProfile ?? project.designProfile ?? undefined,
    });
    onProjectChange?.({ id: project.id, ...saved });
    onAfterTurn?.();
  }

  async function run(promptOverride, opts = {}) {
    const fixBuild = opts.fixBuild === true;
    const redesign = opts.redesign === true;
    const prompt = fixBuild ? "" : (typeof promptOverride === "string" ? promptOverride : text).trim();
    if ((!prompt && !fixBuild) || busy) return;
    const effectiveMode = fixBuild ? "iterate" : !hasApp && planMode ? "plan" : mode;
    // A selected element scopes a USER-TYPED iterate to that exact spot in the UI (cheaper, more
    // accurate). Composed prompts (Fix it) skip the scoping — they carry their own context.
    const scopedPrompt = effectiveMode === "iterate" && selectedEl && typeof promptOverride !== "string" && !fixBuild
      ? `The user selected this element in the running app (path: ${selectedEl.path}):\n\`\`\`html\n${selectedEl.outerHTML}\n\`\`\`\n\nApply this change to that element: ${prompt}`
      : prompt;
    setBusy(true); setErr(null); setResult(null); setAppErr(null);
    setPhase("queued"); setRunningMode(redesign ? "redesign" : effectiveMode);
    // Name a new project from its first prompt AT BUILD START — so a build that finishes while the
    // user has navigated away (a detached background job) still lands with a real name instead of
    // staying "Untitled app" (the completion handler only has a status label, not the prompt).
    try {
      // A New app is local-only until the first meaningful action. Planning also persists because
      // the detached server job must be tied to an owner-scoped project row.
      const firstName = effectiveMode === "build" && prompt ? deriveName(prompt) : (project.name || "Untitled app");
      await ensurePersisted(firstName);
      if (!project.transient && effectiveMode === "build" && prompt && (!project.name || project.name === "Untitled app")) {
        renameProject(project.id, firstName)
          .then((saved) => onProjectChange?.({ ...project, ...saved }))
          .catch(() => {});
      }
      const { jobId } = await createBuild({
        projectId: project.id, prompt: fixBuild ? undefined : scopedPrompt, mode: effectiveMode,
        tree: effectiveMode === "iterate" ? tree : undefined,
        plan: effectiveMode === "build" && pendingPlan ? pendingPlan : undefined,
        knowledge: knowledge.trim() || undefined,
        fixBuild: fixBuild || undefined,
        style: { preset: stylePreset, notes: styleNotes.trim() },
        designProfile: !redesign ? project.designProfile || undefined : undefined,
        redesign: redesign || undefined,
      });
      setActiveJobId(jobId);
      const job = await watchBuild(jobId, (ph) => setPhase(ph));
      if (job.status !== "complete") {
        throw new Error(job.error || "The build hit an unexpected error — please try again.");
      }
      await applyFinishedJob(job, fixBuild ? "⚙ Fix the build error" : prompt, {
        planUsed: effectiveMode === "build" && !!pendingPlan,
        clearComposer: typeof promptOverride !== "string" && !fixBuild,
      });
    } catch (e) {
      setErr(e.payload?.error === "insufficient_balance"
        ? (e.payload?.hint || "You're out of credits — pick a plan or top up in the right-hand panel, then try again.")
        : (e.message || String(e)));
    } finally { setBusy(false); setPhase(null); setActiveJobId(null); setRunningMode(null); }
  }

  // Stop the observed build: the server flags the job and the runner halts at the next safe
  // point. The watch resolves with the job's "Cancelled by user." ending — no state to unwind here.
  async function doCancelBuild() {
    if (!activeJobId) return;
    try { await cancelBuild(activeJobId); } catch { /* already finished is fine */ }
  }

  // Reattach on open: a build may be running for this project (started here or in another tab),
  // or may have finished while we were away. Observe the former; adopt-and-save the latter.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const job = await activeBuild(project.id);
        if (!active || !job) return;
        const applied = (project.prompts || []).some((p) => p.jobId === job.jobId);
        if (job.status === "queued" || job.status === "running") {
          setBusy(true); setActiveJobId(job.jobId); setRunningMode(job.mode);
          setPhase(job.phase || "queued"); setDetailsOpen(true);
          const end = await watchBuild(job.jobId, (ph) => { if (active) setPhase(ph); });
          if (!active) return;
          if (end.status === "complete") {
            await applyFinishedJob(end, "⟳ Build finished in the background", { background: true });
          } else {
            setErr(end.error || "The build hit an unexpected error — please try again.");
          }
          setBusy(false); setPhase(null); setActiveJobId(null); setRunningMode(null);
        } else if (job.status === "complete" && job.mode !== "plan" && job.result?.tree && !applied) {
          await applyFinishedJob(job, "⟳ Build finished while you were away", { background: true });
        } else if (job.status === "complete" && job.mode === "plan" && job.result?.finalText && !hasApp && !pendingPlan) {
          // A plan that finished while we were away: restore it as the held plan (no history
          // entry — plan turns only persist once a build saves them, same as before).
          setPendingPlan(job.result.finalText);
          setResult({ mode: "plan", ...job.result });
        } else if (job.status === "interrupted" && !applied) {
          // Surface the invisible death (a failed/cancelled build was seen live by whoever ran it).
          setErr(job.error || "The build was interrupted — please rebuild.");
        }
      } catch { /* reattach is best-effort; the composer still works without it */ }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Revert the app to an earlier turn's snapshot. NON-destructive (Lovable-style): later turns
  // stay in history; the revert itself is appended as a new entry carrying the same snapshot.
  async function revertTo(i) {
    const snap = prompts[i]?.tree;
    if (!snap || busy) return;
    setErr(null); setAppErr(null); setResult(null);
    const entry = {
      prompt: `⟲ Reverted to turn ${i + 1} (${new Date(prompts[i].at).toLocaleTimeString()})`,
      mode: "revert", at: new Date().toISOString(), buildOk: prompts[i].buildOk, tree: snap,
    };
    const nextPrompts = capSnapshots([...prompts, entry]);
    setTree(snap);
    setPrompts(nextPrompts);
    try {
      const r = await startPreview({ projectId: project.id, tree: snap }).catch(() => null);
      if (r?.url) setPreviewUrl(r.url);
      else if (iframeRef.current) { try { iframeRef.current.contentWindow?.location.reload(); } catch {} }
      const saved = await saveProject(project.id, { name: project.name, tree: snap, prompts: nextPrompts, previewRef: previewUrl });
      onProjectChange?.({ id: project.id, ...saved });
    } catch (e) {
      setErr(e.message || String(e));
    }
  }

  async function openDomains() {
    setShowDomain((v) => !v);
    setDomainMsg(null);
    try { setDomainInfo(await listDomains(project.id)); } catch (e) { setDomainMsg(e.message); }
  }

  async function doConnectDomain(domain) {
    if (domainBusy) return;
    setDomainBusy(true); setDomainMsg(null);
    try {
      const r = await connectDomain(project.id, domain);
      setDomainMsg(r.hint);
      setDomainInput("");
      setDomainInfo(await listDomains(project.id));
    } catch (e) { setDomainMsg(e.message); } finally { setDomainBusy(false); }
  }

  async function doRemoveDomain(domain) {
    if (domainBusy) return;
    setDomainBusy(true); setDomainMsg(null);
    try {
      await removeDomain(project.id, domain);
      setDomainInfo(await listDomains(project.id));
      setDomainMsg(`${domain} disconnected.`);
    } catch (e) { setDomainMsg(e.message); } finally { setDomainBusy(false); }
  }

  // One-click repair (normal metered spend). Build failures: the stderr lives server-side on the
  // job record, so the server composes the prompt (fixBuild flag). Runtime errors come from the
  // preview iframe itself and are composed here as before.
  function fixIt() {
    if (!appErr || busy || !hasApp) return;
    if (appErr.kind === "build") return run(null, { fixBuild: true });
    run(`The running app throws this runtime error:\n\n${appErr.message}${appErr.stack ? `\n\nStack:\n${appErr.stack}` : ""}\n\nFind and fix the root cause (do not just swallow the error).`);
  }

  async function testApp() {
    if (!hasApp || busy || qaBusy) return;
    setQaBusy(true);
    setShowQa(true);
    setQaRun({ status: "queued", passed_count: 0, issue_count: 0 });
    try {
      const started = await startQaRun(project.id);
      const finished = await waitForQaRun(started.id, setQaRun);
      setQaRun(finished);
    } catch (error) {
      setQaRun({ status: "failed", error: error.message || String(error) });
    } finally {
      setQaBusy(false);
    }
  }

  async function openPayments() {
    setShowPayments(true);
    setPaymentBusy(true);
    setPaymentError("");
    try { setPaymentData(await getPaymentOverview(project.id)); }
    catch (error) { setPaymentError(error.message || String(error)); }
    finally { setPaymentBusy(false); }
  }

  async function connectStripe() {
    setPaymentError("");
    try { await beginStripeOnboarding(project.id); }
    catch (error) { setPaymentError(error.message || String(error)); }
  }

  async function addPaymentProduct() {
    const value = Number(productDraft.price);
    if (!Number.isFinite(value) || value <= 0) return setPaymentError("Enter a valid price.");
    setPaymentBusy(true);
    setPaymentError("");
    try {
      await savePaymentProduct(project.id, {
        name: productDraft.name,
        description: productDraft.description,
        currency: productDraft.currency,
        unitAmount: Math.round(value * 100),
        usageUnits: Math.max(0, Math.floor(Number(productDraft.usageUnits || 0))),
      });
      setProductDraft({ name: "", description: "", currency: "gbp", price: "", usageUnits: "" });
      setPaymentData(await getPaymentOverview(project.id));
    } catch (error) { setPaymentError(error.message || String(error)); }
    finally { setPaymentBusy(false); }
  }

  async function removePaymentProduct(productId) {
    if (!window.confirm("Delete this payment product? Existing order history will be kept.")) return;
    setPaymentBusy(true);
    setPaymentError("");
    try {
      await deletePaymentProduct(project.id, productId);
      setPaymentData(await getPaymentOverview(project.id));
    } catch (error) { setPaymentError(error.message || String(error)); }
    finally { setPaymentBusy(false); }
  }

  async function openBrandEditor() {
    setShowBrand(true);
    setBrandBusy(true);
    setBrandError("");
    try {
      const overview = await getBrandOverview(project.id);
      setBrandData(overview);
      setBrandDraft((value) => ({ ...value, ...(overview.current?.config || {}) }));
    } catch (error) { setBrandError(error.message || String(error)); }
    finally { setBrandBusy(false); }
  }

  async function saveBrand(config = brandDraft, options = {}) {
    setBrandBusy(true);
    setBrandError("");
    try {
      const result = await applyProjectBrand(project.id, config, {
        ...options,
        kitName: options.brandKitId ? undefined : brandKitName.trim() || undefined,
      });
      setTree(result.tree);
      setBrandDraft(result.config);
      setBrandKitName("");
      onProjectChange?.({ ...project, tree: result.tree });
      const preview = await startPreview({ projectId: project.id, tree: result.tree }).catch(() => null);
      if (preview?.url) {
        const refreshedUrl = new URL(preview.url);
        refreshedUrl.searchParams.set("buildrStyle", Date.now().toString());
        setPreviewUrl(refreshedUrl.toString());
      }
      else if (iframeRef.current) { try { iframeRef.current.contentWindow?.location.reload(); } catch {} }
      setBrandData(await getBrandOverview(project.id));
      setPublishMsg("Visual style applied with no credits used.");
    } catch (error) { setBrandError(error.message || String(error)); }
    finally { setBrandBusy(false); }
  }

  async function refreshOwnerConsole(open = false) {
    if (open) setShowConsole(true);
    setConsoleBusy(true);
    setConsoleError("");
    try { setConsoleData(await getOwnerConsole(project.id)); }
    catch (error) { setConsoleError(error.message || String(error)); }
    finally { setConsoleBusy(false); }
  }

  async function toggleAppUser(user) {
    setConsoleBusy(true);
    setConsoleError("");
    try {
      await setConsoleUserStatus(project.id, user.id, user.status === "active" ? "disabled" : "active");
      setConsoleData(await getOwnerConsole(project.id));
    } catch (error) { setConsoleError(error.message || String(error)); }
    finally { setConsoleBusy(false); }
  }

  async function removeAppRecord(record) {
    if (!window.confirm(`Delete this ${record.type} record? This cannot be undone.`)) return;
    setConsoleBusy(true);
    setConsoleError("");
    try {
      await deleteConsoleRecord(project.id, record.id);
      setConsoleData(await getOwnerConsole(project.id));
    } catch (error) { setConsoleError(error.message || String(error)); }
    finally { setConsoleBusy(false); }
  }

  async function openGithubPanel() {
    setShowGithub(true);
    setGithubBusy(true);
    setGithubError("");
    try { setGithubData(await getGithubOverview(project.id)); }
    catch (error) { setGithubError(error.message || String(error)); }
    finally { setGithubBusy(false); }
  }

  async function saveGithubConnection() {
    setGithubBusy(true);
    setGithubError("");
    try {
      await connectGithub(project.id, githubToken.trim());
      setGithubToken("");
      setGithubData(await getGithubOverview(project.id));
    } catch (error) { setGithubError(error.message || String(error)); }
    finally { setGithubBusy(false); }
  }

  async function pushGithub() {
    setGithubBusy(true);
    setGithubError("");
    try {
      const result = await exportGithub(project.id, { repoName: githubRepo.trim() || project.name, private: githubPrivate });
      setGithubData(await getGithubOverview(project.id));
      setPublishMsg(result.initial ? "GitHub repository created." : "Latest app synced to GitHub.");
    } catch (error) { setGithubError(error.message || String(error)); }
    finally { setGithubBusy(false); }
  }

  async function openIntegrationPanel() {
    setShowIntegrations(true);
    setIntegrationBusy(true);
    setIntegrationError("");
    setIntegrationSecret("");
    try {
      const overview = await getIntegrationOverview(project.id);
      setIntegrationData(overview);
      setIntegrationDraft({ webhookUrl: overview.config.webhook_url || "", email: overview.config.email || "", phone: overview.config.phone || "" });
    } catch (error) { setIntegrationError(error.message || String(error)); }
    finally { setIntegrationBusy(false); }
  }

  async function saveIntegrations() {
    setIntegrationBusy(true);
    setIntegrationError("");
    try {
      const result = await saveIntegrationSettings(project.id, integrationDraft);
      setIntegrationSecret(result.signingSecret || "");
      setIntegrationData(await getIntegrationOverview(project.id));
      setPublishMsg("App integrations updated.");
    } catch (error) { setIntegrationError(error.message || String(error)); }
    finally { setIntegrationBusy(false); }
  }

  async function openAnalytics() {
    setShowAnalytics(true);
    setAnalyticsBusy(true);
    setAnalyticsError("");
    try { setAnalyticsData(await getProjectAnalytics(project.id)); }
    catch (error) { setAnalyticsError(error.message || String(error)); }
    finally { setAnalyticsBusy(false); }
  }

  async function refreshEnvironments(open = false) {
    if (open) setShowEnvironments(true);
    setEnvironmentBusy(true);
    setEnvironmentError("");
    try { setEnvironmentData(await getEnvironmentControl(project.id)); }
    catch (error) { setEnvironmentError(error.message || String(error)); }
    finally { setEnvironmentBusy(false); }
  }

  async function deployTest() {
    setEnvironmentBusy(true); setEnvironmentError("");
    try {
      const result = await deployTestEnvironment(project.id);
      if (result.url) setPreviewUrl(result.url);
      setEnvironmentData(await getEnvironmentControl(project.id));
      setPublishMsg("Current build deployed to the test environment.");
    } catch (error) { setEnvironmentError(error.message || String(error)); }
    finally { setEnvironmentBusy(false); }
  }

  async function releaseAction(release, action) {
    const prompt = action === "rollback" ? "Roll the live site back to this release? Your editor will keep its current version." : "Promote this test release to the live site?";
    if (!window.confirm(prompt)) return;
    setEnvironmentBusy(true); setEnvironmentError("");
    try {
      const result = await runReleaseAction(project.id, release.id, action);
      if (result.url) { setPublishedUrl(result.url); await savePublishedUrl(project.id, result.url).catch(() => {}); }
      setEnvironmentData(await getEnvironmentControl(project.id));
      setPublishMsg(action === "rollback" ? "Live site rolled back." : "Test release promoted to live.");
    } catch (error) { setEnvironmentError(error.message || String(error)); }
    finally { setEnvironmentBusy(false); }
  }

  async function openTemplates() {
    setShowTemplates(true); setTemplateBusy(true); setTemplateError("");
    setTemplateDraft((value) => ({ ...value, name: value.name || `${project.name || "App"} template` }));
    try { setTemplates(await listTemplates()); }
    catch (error) { setTemplateError(error.message || String(error)); }
    finally { setTemplateBusy(false); }
  }

  async function saveCurrentTemplate() {
    setTemplateBusy(true); setTemplateError("");
    try {
      await createTemplate(project.id, templateDraft);
      setTemplates(await listTemplates());
      setTemplateDraft((value) => ({ ...value, name: "", description: "" }));
      setPublishMsg("Reusable template saved.");
    } catch (error) { setTemplateError(error.message || String(error)); }
    finally { setTemplateBusy(false); }
  }

  async function remixSavedTemplate(template) {
    setTemplateBusy(true); setTemplateError("");
    try {
      const remixed = await remixTemplate(template.id, `${template.name} remix`);
      setShowTemplates(false);
      onProjectChange?.(remixed);
    } catch (error) { setTemplateError(error.message || String(error)); }
    finally { setTemplateBusy(false); }
  }

  async function commitRename() {
    const name = nameDraft.trim();
    setEditingName(false);
    if (!name || name === project.name) { setNameDraft(project.name || ""); return; }
    try {
      if (project.transient) {
        await ensurePersisted(name);
        return;
      }
      const saved = await renameProject(project.id, name);
      onProjectChange?.({ ...project, ...saved });
    } catch (e) {
      setNameDraft(project.name || "");
      setPublishMsg(e.message || String(e));
    }
  }

  async function doUnpublish() {
    if (!publishedUrl || publishBusy) return;
    if (!window.confirm("Take the published site offline? Its URL will stop working (you can republish any time).")) return;
    setPublishBusy(true);
    setPublishMsg(null);
    try {
      await unpublishProject(project.id);
      setPublishedUrl(null);
      setPublishMsg("Unpublished — the site is offline");
      await savePublishedUrl(project.id, null).catch(() => {});
    } catch (e) {
      setPublishMsg(e.message || String(e));
    } finally {
      setPublishBusy(false);
    }
  }

  async function doPublish(name) {
    if (!hasApp || publishBusy) return;
    setPublishBusy(true);
    setPublishMsg(null);
    try {
      const r = await publishProject(project.id, tree, name);
      const firstPublish = !publishedUrl;
      setPublishedUrl(r.url);
      setShowPublish(false);
      setPublishMsg(`Published ✓ ${r.url.replace(/^https:\/\//, "").replace(/\/$/, "")}${firstPublish ? " — connect your own domain via Site ▾" : ""}`);
      await savePublishedUrl(project.id, r.url).catch(() => {});
    } catch (e) {
      // Name conflicts keep the dialog open so the user can pick another.
      if (showPublish) setPublishErr(e.message || String(e));
      else setPublishMsg(e.message || String(e));
    } finally {
      setPublishBusy(false);
    }
  }

  async function doDownload() {
    if (!hasApp || downloadBusy) return;
    setDownloadBusy(true);
    setPublishMsg(null);
    try {
      const r = await downloadProject(project.id);
      setPublishMsg(`Downloaded ${r.filename}`);
    } catch (e) {
      setPublishMsg(e.message || String(e));
    } finally {
      setDownloadBusy(false);
    }
  }

  async function doDownloadAndroid() {
    if (androidBusy) return;
    setAndroidBusy(true);
    setPublishMsg(null);
    try {
      const r = await downloadAndroid(project.id, tree);
      setPublishMsg(`Downloaded ${r.filename} — see the README inside for Play Store steps.`);
    } catch (e) {
      setPublishMsg(e.message || String(e));
    } finally {
      setAndroidBusy(false);
    }
  }

  // Tick an elapsed counter while the Android build runs — the ticking clock + spinner are the
  // "it's alive" signal that stops people refreshing a request that legitimately takes minutes.
  useEffect(() => {
    if (!androidBusy) { setAndroidElapsed(0); return; }
    const t = setInterval(() => setAndroidElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [androidBusy]);

  return (
    <div className="relative h-full grid grid-rows-[3.5rem_1fr] grid-cols-[minmax(0,1fr)]">
      {/* grid-cols must be an explicit minmax(0,1fr): the implicit auto column would grow to fit a
          long project name and push the header actions past the viewport instead of truncating */}
      {publishMsg && (
        <div className="fixed bottom-4 right-4 z-40 panel px-4 py-2.5 text-sm text-slate-200 shadow-panel flex items-center gap-3">
          <span className="max-w-[24rem] truncate" title={publishMsg}>{publishMsg}</span>
          <button className="text-slate-500 hover:text-slate-300" onClick={() => setPublishMsg(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      {showQa && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[42rem] max-w-[96vw] max-h-[86vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-lg font-semibold text-slate-100">Test and Fix</div>
                <div className="mt-1 text-xs text-slate-400">
                  {qaBusy ? "Checking routes, browser errors, images and responsive layout…"
                    : qaRun?.status === "passed" ? "Everything tested cleanly."
                      : qaRun?.status === "issues_found" ? `${qaRun.issue_count} issue${qaRun.issue_count === 1 ? "" : "s"} found.`
                        : qaRun?.error || "Testing stopped."}
                </div>
              </div>
              {!qaBusy && <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowQa(false)} aria-label="Close test report">✕</button>}
            </div>
            {qaBusy && (
              <div className="mt-6 flex items-center gap-3 text-sm text-slate-300">
                <div className="h-4 w-4 rounded-full border-2 border-amber border-t-transparent animate-spin" />
                <span className="font-mono text-xs uppercase tracking-wider">{qaRun?.status || "queued"}</span>
              </div>
            )}
            {!qaBusy && qaRun?.report && (
              <>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-line bg-ink-900 p-3">
                    <div className="text-2xl font-semibold text-slate-100">{qaRun.passed_count}</div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">pages checked</div>
                  </div>
                  <div className="rounded-lg border border-line bg-ink-900 p-3">
                    <div className={`text-2xl font-semibold ${qaRun.issue_count ? "text-amber-soft" : "text-emerald-400"}`}>{qaRun.issue_count}</div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">issues</div>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  {(qaRun.report.issues || []).map((issue, index) => (
                    <div key={`${issue.type}-${index}`} className="rounded-lg border border-line bg-ink-900/70 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="tag bg-ink-800 text-slate-300">{issue.viewport}</span>
                        <span className="font-mono text-amber-soft">{issue.type.replaceAll("_", " ")}</span>
                        <span className="ml-auto text-slate-500 truncate">{issue.url}</span>
                      </div>
                      <div className="mt-1 text-sm text-slate-300 break-words">{issue.message}</div>
                    </div>
                  ))}
                </div>
                {!!qaRun.report.screenshots?.length && (
                  <div className="mt-4">
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">Screenshots</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {qaRun.report.screenshots.map((shot) => (
                        <button key={shot.file} className="btn-ghost text-xs" onClick={() => openQaArtifact(qaRun.id, shot.file)}>
                          {shot.viewport} {shot.url}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <button className="btn-ghost text-xs" onClick={() => setShowQa(false)}>Close</button>
                  {qaRun.report.fixPrompt && (
                    <button className="btn-primary text-xs px-3 py-1" disabled={busy}
                      onClick={() => { const prompt = qaRun.report.fixPrompt; setShowQa(false); run(prompt); }}>
                      Fix everything
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showPayments && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[48rem] max-w-[96vw] max-h-[88vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-lg font-semibold text-slate-100">App payments</div>
                <div className="mt-1 text-xs text-slate-400">Connect Stripe, create fixed-price products, and use their IDs in your app.</div>
              </div>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowPayments(false)} aria-label="Close payments">✕</button>
            </div>
            {paymentBusy && !paymentData && <div className="mt-6 text-sm text-slate-400">Loading payment setup…</div>}
            {paymentError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{paymentError}</div>}
            {paymentData && (
              <>
                <div className="mt-5 rounded-xl border border-line bg-ink-900/70 p-4 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-slate-200">Stripe account</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {paymentData.account?.chargesEnabled ? "Connected and ready to take payments"
                        : paymentData.account ? "Onboarding needs to be completed" : "Not connected"}
                    </div>
                  </div>
                  <button className="btn-primary text-xs px-3 py-1" onClick={connectStripe}>
                    {paymentData.account ? "Continue setup" : "Connect Stripe"}
                  </button>
                </div>
                <div className="mt-5 grid gap-2 sm:grid-cols-[1.2fr_.7fr_.7fr_.55fr_auto]">
                  <input className="input text-sm" placeholder="Product name" value={productDraft.name}
                    onChange={(event) => setProductDraft((value) => ({ ...value, name: event.target.value }))} />
                  <input className="input text-sm" inputMode="decimal" placeholder="Price" value={productDraft.price}
                    onChange={(event) => setProductDraft((value) => ({ ...value, price: event.target.value }))} />
                  <input className="input text-sm" inputMode="numeric" placeholder="Usage units" value={productDraft.usageUnits}
                    onChange={(event) => setProductDraft((value) => ({ ...value, usageUnits: event.target.value }))} />
                  <select className="input text-sm" value={productDraft.currency}
                    onChange={(event) => setProductDraft((value) => ({ ...value, currency: event.target.value }))}>
                    <option value="gbp">GBP</option><option value="usd">USD</option><option value="eur">EUR</option>
                  </select>
                  <button className="btn-primary text-xs px-3" disabled={paymentBusy || !productDraft.name.trim()} onClick={addPaymentProduct}>Add</button>
                </div>
                <input className="input mt-2 w-full text-sm" placeholder="Short description (optional)" value={productDraft.description}
                  onChange={(event) => setProductDraft((value) => ({ ...value, description: event.target.value }))} />
                <div className="mt-5 space-y-2">
                  {paymentData.products.length === 0 && <div className="text-sm text-slate-500">No products yet.</div>}
                  {paymentData.products.map((product) => (
                    <div key={product.id} className="rounded-lg border border-line bg-ink-900/70 px-3 py-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-slate-200 truncate">{product.name}</div>
                        <div className="mt-1 font-mono text-[11px] text-slate-500 select-all">{product.id}</div>
                        {product.usage_units > 0 && <div className="mt-1 text-[10px] text-emerald-400">Grants {product.usage_units.toLocaleString()} app units</div>}
                      </div>
                      <div className="text-sm font-medium uppercase text-slate-300">{product.currency} {(product.unit_amount / 100).toFixed(2)}</div>
                      <button className="btn-ghost text-xs" disabled={paymentBusy} onClick={() => removePaymentProduct(product.id)}>Delete</button>
                    </div>
                  ))}
                </div>
                {!!paymentData.orders.length && (
                  <div className="mt-6">
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">Recent orders</div>
                    <div className="mt-2 space-y-1">
                      {paymentData.orders.slice(0, 8).map((order) => (
                        <div key={order.id} className="flex items-center gap-3 text-xs text-slate-400 py-1">
                          <span className="tag bg-ink-800 text-slate-300">{order.status}</span>
                          <span className="truncate">{order.customer_email || "Customer"}</span>
                          <span className="ml-auto uppercase">{order.currency} {(order.amount_total / 100).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-5 rounded-lg bg-ink-900 px-3 py-2 font-mono text-[11px] text-slate-400">
                  {`await payments.checkout({ productId: "${paymentData.products[0]?.id || "PRODUCT_ID"}" })`}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showBrand && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[46rem] max-w-[96vw] max-h-[88vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-lg font-semibold text-slate-100">Visual style</div>
                <div className="mt-1 text-xs text-slate-400">Change the app's brand tokens instantly. This does not use credits.</div>
              </div>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowBrand(false)} aria-label="Close visual style">✕</button>
            </div>
            {brandError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{brandError}</div>}
            {brandBusy && !brandData ? <div className="mt-6 text-sm text-slate-400">Loading visual settings…</div> : (
              <>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {[["primary", "Primary"], ["accent", "Accent"], ["background", "Background"], ["surface", "Surface"], ["text", "Text"]].map(([key, label]) => (
                    <label key={key} className="rounded-lg border border-line bg-ink-900 p-3 text-[11px] text-slate-400">
                      <span>{label}</span>
                      <input type="color" className="mt-2 block h-9 w-full cursor-pointer rounded border-0 bg-transparent" value={brandDraft[key]}
                        onChange={(event) => setBrandDraft((value) => ({ ...value, [key]: event.target.value }))} />
                      <span className="mt-1 block font-mono text-[10px]">{brandDraft[key]}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-slate-400">Typography
                    <select className="input mt-1 w-full text-sm" value={brandDraft.font}
                      onChange={(event) => setBrandDraft((value) => ({ ...value, font: event.target.value }))}>
                      <option value="modern">Modern sans</option><option value="editorial">Editorial serif</option>
                      <option value="friendly">Friendly rounded</option><option value="technical">Technical mono</option>
                    </select>
                  </label>
                  <label className="text-xs text-slate-400">Corner radius: {brandDraft.radius}px
                    <input type="range" min="0" max="32" className="mt-3 w-full accent-amber" value={brandDraft.radius}
                      onChange={(event) => setBrandDraft((value) => ({ ...value, radius: Number(event.target.value) }))} />
                  </label>
                </div>
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <label className="min-w-52 flex-1 text-xs text-slate-400">Save as reusable kit (optional)
                    <input className="input mt-1 w-full text-sm" placeholder="e.g. Acme dark" value={brandKitName}
                      onChange={(event) => setBrandKitName(event.target.value)} />
                  </label>
                  <button className="btn-primary px-4 py-2 text-xs" disabled={brandBusy} onClick={() => saveBrand()}>
                    {brandBusy ? "Applying…" : "Apply style"}
                  </button>
                </div>
                {!!brandData?.kits?.length && (
                  <div className="mt-6">
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">Your brand kits</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {brandData.kits.map((kit) => (
                        <button key={kit.id} className="btn-ghost text-xs flex items-center gap-2" disabled={brandBusy}
                          onClick={() => saveBrand(kit.config, { brandKitId: kit.id })}>
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: kit.config.primary }} />{kit.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {showConsole && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[58rem] max-w-[96vw] max-h-[90vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-lg font-semibold text-slate-100">App owner console</div>
                <div className="mt-1 text-xs text-slate-400">Users, data and payments for this app.</div>
              </div>
              <div className="flex items-center gap-2">
                <button className="btn-ghost text-xs" onClick={() => refreshOwnerConsole()} disabled={consoleBusy}>Refresh</button>
                <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowConsole(false)} aria-label="Close owner console">✕</button>
              </div>
            </div>
            {consoleError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{consoleError}</div>}
            {consoleBusy && !consoleData ? <div className="mt-6 text-sm text-slate-400">Loading app data…</div> : consoleData && (
              <>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[["Users", consoleData.stats.users], ["Active", consoleData.stats.activeUsers], ["Records", consoleData.stats.records], ["Paid orders", consoleData.stats.paidOrders]].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-line bg-ink-900 p-3">
                      <div className="text-2xl font-semibold text-slate-100">{value}</div>
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
                    </div>
                  ))}
                </div>
                {!!Object.keys(consoleData.stats.revenueByCurrency).length && (
                  <div className="mt-3 text-sm text-emerald-400">
                    Paid revenue: {Object.entries(consoleData.stats.revenueByCurrency).map(([currency, amount]) => `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`).join(" · ")}
                  </div>
                )}
                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                  <section>
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">App users</div>
                    <div className="mt-2 max-h-72 space-y-2 overflow-auto">
                      {!consoleData.users.length && <div className="text-sm text-slate-500">No users have signed up yet.</div>}
                      {consoleData.users.map((user) => (
                        <div key={user.id} className="flex items-center gap-3 rounded-lg border border-line bg-ink-900/70 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-slate-200">{user.email}</div>
                            <div className="text-[10px] text-slate-500">Joined {new Date(user.created_at).toLocaleDateString()}</div>
                          </div>
                          <span className={`tag ${user.status === "active" ? "text-emerald-400" : "text-red-300"}`}>{user.status}</span>
                          <button className="btn-ghost text-xs" disabled={consoleBusy} onClick={() => toggleAppUser(user)}>
                            {user.status === "active" ? "Disable" : "Enable"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section>
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">Recent data</div>
                    <div className="mt-2 max-h-72 space-y-2 overflow-auto">
                      {!consoleData.records.length && <div className="text-sm text-slate-500">No app records yet.</div>}
                      {consoleData.records.slice(0, 50).map((record) => (
                        <div key={record.id} className="rounded-lg border border-line bg-ink-900/70 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="tag text-amber-soft">{record.type}</span>
                            <span className="ml-auto text-[10px] text-slate-500">{new Date(record.created_at).toLocaleString()}</span>
                            <button className="text-xs text-red-300 hover:text-red-200" disabled={consoleBusy} onClick={() => removeAppRecord(record)}>Delete</button>
                          </div>
                          <pre className="mt-2 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-slate-400">{JSON.stringify(record.data)}</pre>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showGithub && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[38rem] max-w-[96vw] max-h-[88vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-lg font-semibold text-slate-100">GitHub export and sync</div>
                <div className="mt-1 text-xs text-slate-400">Paid plans only. Tokens are encrypted at rest and never returned to the browser.</div>
              </div>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowGithub(false)} aria-label="Close GitHub">✕</button>
            </div>
            {githubError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{githubError}</div>}
            {githubBusy && !githubData ? <div className="mt-6 text-sm text-slate-400">Loading GitHub setup…</div> : githubData && !githubData.connected ? (
              <div className="mt-5">
                <div className="text-sm text-slate-300">Create a fine-grained token with repository Contents read/write permission, then paste it here.</div>
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-amber-soft hover:underline">Create token on GitHub ↗</a>
                <input className="input mt-4 w-full font-mono text-sm" type="password" autoComplete="off" placeholder="github_pat_…"
                  value={githubToken} onChange={(event) => setGithubToken(event.target.value)} />
                <button className="btn-primary mt-3 px-4 py-2 text-xs" disabled={githubBusy || !githubToken.trim()} onClick={saveGithubConnection}>Connect GitHub</button>
              </div>
            ) : githubData && (
              <div className="mt-5">
                <div className="rounded-lg border border-line bg-ink-900/70 p-4">
                  <div className="text-sm text-slate-200">Connected as <span className="font-mono text-amber-soft">{githubData.login}</span></div>
                  {githubData.repository && <a href={githubData.repositoryUrl} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-slate-400 hover:text-slate-200">{githubData.repository} ↗</a>}
                  {githubData.lastCommitAt && <div className="mt-1 text-[10px] text-slate-500">Last synced {new Date(githubData.lastCommitAt).toLocaleString()}</div>}
                </div>
                {!githubData.repository && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
                    <input className="input text-sm" placeholder={project.name || "Repository name"} value={githubRepo}
                      onChange={(event) => setGithubRepo(event.target.value)} />
                    <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={githubPrivate} onChange={(event) => setGithubPrivate(event.target.checked)} /> Private</label>
                  </div>
                )}
                <div className="mt-4 flex items-center gap-2">
                  <button className="btn-primary px-4 py-2 text-xs" disabled={githubBusy} onClick={pushGithub}>
                    {githubBusy ? "Pushing…" : githubData.repository ? "Sync latest" : "Create repository"}
                  </button>
                  <button className="btn-ghost text-xs text-red-300" disabled={githubBusy} onClick={async () => {
                    if (!window.confirm("Disconnect GitHub from this project? The repository will not be deleted.")) return;
                    setGithubBusy(true); setGithubError("");
                    try { await disconnectGithub(project.id); setGithubData(await getGithubOverview(project.id)); }
                    catch (error) { setGithubError(error.message || String(error)); }
                    finally { setGithubBusy(false); }
                  }}>Disconnect</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {showConnectorHub && (
        <ConnectorHub
          projectId={project.id}
          githubAllowed={!!featureAccess?.github_export?.allowed}
          onClose={() => setShowConnectorHub(false)}
          onOpenPayments={() => { setShowConnectorHub(false); openPayments(); }}
          onOpenGithub={() => { setShowConnectorHub(false); openGithubPanel(); }}
          onOpenDelivery={() => { setShowConnectorHub(false); openIntegrationPanel(); }}
        />
      )}
      {showIntegrations && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[44rem] max-w-[96vw] max-h-[88vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-lg font-semibold text-slate-100">App integrations</div>
                <div className="mt-1 text-xs text-slate-400">Deliver app events by signed webhook, email, or SMS.</div>
              </div>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowIntegrations(false)} aria-label="Close integrations">✕</button>
            </div>
            {integrationError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{integrationError}</div>}
            {integrationBusy && !integrationData ? <div className="mt-6 text-sm text-slate-400">Loading integrations…</div> : integrationData && (
              <>
                <div className="mt-5 space-y-4">
                  <label className="block text-xs text-slate-400">Webhook URL
                    <input className="input mt-1 w-full text-sm" placeholder="https://your-api.com/webhooks/buildr" value={integrationDraft.webhookUrl}
                      onChange={(event) => setIntegrationDraft((value) => ({ ...value, webhookUrl: event.target.value }))} />
                    <span className="mt-1 block text-[10px] text-slate-500">Public HTTPS only. Requests are signed with HMAC-SHA256 and retried up to three times.</span>
                  </label>
                  <label className="block text-xs text-slate-400">Owner alert email
                    <input className="input mt-1 w-full text-sm" type="email" placeholder="alerts@example.com" value={integrationDraft.email}
                      onChange={(event) => setIntegrationDraft((value) => ({ ...value, email: event.target.value }))} />
                    {!integrationData.providers.email && <span className="mt-1 block text-[10px] text-amber-soft">Email provider is not configured on the platform yet.</span>}
                  </label>
                  <label className="block text-xs text-slate-400">Owner SMS number
                    <input className="input mt-1 w-full text-sm" type="tel" placeholder="+447700900000" value={integrationDraft.phone}
                      onChange={(event) => setIntegrationDraft((value) => ({ ...value, phone: event.target.value }))} />
                    {!integrationData.providers.sms && <span className="mt-1 block text-[10px] text-amber-soft">SMS is ready in code but needs Twilio credentials before delivery is enabled.</span>}
                  </label>
                </div>
                {integrationSecret && (
                  <div className="mt-4 rounded-lg border border-amber/30 bg-amber/10 p-3">
                    <div className="text-xs font-medium text-amber-soft">Copy this signing secret now. It will not be shown again.</div>
                    <div className="mt-2 select-all break-all font-mono text-xs text-slate-200">{integrationSecret}</div>
                  </div>
                )}
                <div className="mt-5 rounded-lg bg-ink-900 px-3 py-3 font-mono text-[11px] text-slate-400 space-y-1">
                  <div>{`await notifications.emit("booking.created", { id: booking.id })`}</div>
                  <div>{`await notifications.emailSelf({ subject: "Receipt", text: "Thanks" })`}</div>
                  <div>{`await notifications.notifySelf({ title: "Done", body: "Saved" })`}</div>
                </div>
                <div className="mt-4 flex justify-end"><button className="btn-primary px-4 py-2 text-xs" disabled={integrationBusy} onClick={saveIntegrations}>{integrationBusy ? "Saving…" : "Save integrations"}</button></div>
              </>
            )}
          </div>
        </div>
      )}
      {showAnalytics && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[58rem] max-w-[96vw] max-h-[90vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-lg font-semibold text-slate-100">Analytics and errors</div>
                <div className="mt-1 text-xs text-slate-400">First-party activity from the last 14 days. No IP addresses or user-agent strings are stored.</div>
              </div>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowAnalytics(false)} aria-label="Close analytics">✕</button>
            </div>
            {analyticsError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{analyticsError}</div>}
            {analyticsBusy && !analyticsData ? <div className="mt-6 text-sm text-slate-400">Loading analytics…</div> : analyticsData && (
              <>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[["Sessions", analyticsData.totals.sessions], ["Page views", analyticsData.totals.pageViews], ["Events", analyticsData.totals.events], ["Errors", analyticsData.totals.errors]].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-line bg-ink-900 p-3"><div className={`text-2xl font-semibold ${label === "Errors" && value ? "text-red-300" : "text-slate-100"}`}>{value}</div><div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div></div>
                  ))}
                </div>
                <div className="mt-6 rounded-xl border border-line bg-ink-900/70 p-4">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500">Daily sessions</div>
                  <div className="mt-4 flex h-32 items-end gap-1">
                    {analyticsData.daily.map((day) => {
                      const max = Math.max(1, ...analyticsData.daily.map((item) => item.sessions));
                      return <div key={day.date} className="group relative flex-1 rounded-t bg-amber/70 hover:bg-amber" style={{ height: `${Math.max(3, day.sessions / max * 100)}%` }} title={`${day.date}: ${day.sessions} sessions, ${day.pageViews} views`} />;
                    })}
                  </div>
                  <div className="mt-2 flex justify-between text-[9px] text-slate-600"><span>{analyticsData.daily[0]?.date}</span><span>{analyticsData.daily.at(-1)?.date}</span></div>
                </div>
                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                  <section>
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">Top pages</div>
                    <div className="mt-2 space-y-2">
                      {!analyticsData.pages.length && <div className="text-sm text-slate-500">No live page views yet.</div>}
                      {analyticsData.pages.slice(0, 10).map((page) => <div key={page.path} className="flex gap-3 text-sm"><span className="truncate text-slate-300">{page.path}</span><span className="ml-auto font-mono text-slate-500">{page.count}</span></div>)}
                    </div>
                  </section>
                  <section>
                    <div className="text-[11px] uppercase tracking-wider text-slate-500">Recent client errors</div>
                    <div className="mt-2 max-h-52 space-y-2 overflow-auto">
                      {!analyticsData.errors.length && <div className="text-sm text-emerald-400">No client errors recorded.</div>}
                      {analyticsData.errors.map((error) => <div key={error.id} className="rounded-lg border border-red-500/20 bg-red-500/5 p-2"><div className="text-xs text-red-300 break-words">{error.properties?.message || "Client error"}</div><div className="mt-1 text-[10px] text-slate-500">{error.path} · {new Date(error.created_at).toLocaleString()}</div></div>)}
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showEnvironments && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[52rem] max-w-[96vw] max-h-[90vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div><div className="font-display text-lg font-semibold text-slate-100">Test and live environments</div><div className="mt-1 text-xs text-slate-400">Deploy safely to test, promote when ready, or restore an earlier live release.</div></div>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowEnvironments(false)} aria-label="Close environments">✕</button>
            </div>
            {environmentError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{environmentError}</div>}
            {environmentBusy && !environmentData ? <div className="mt-6 text-sm text-slate-400">Loading releases…</div> : environmentData && (
              <>
                <div className="mt-5 flex items-center justify-between rounded-xl border border-line bg-ink-900/70 p-4">
                  <div><div className="text-sm text-slate-200">Test environment</div><div className="mt-1 text-xs text-slate-500">Deploying here does not change the public live site.</div></div>
                  <button className="btn-primary px-4 py-2 text-xs" onClick={deployTest} disabled={environmentBusy}>{environmentBusy ? "Deploying…" : "Deploy current to test"}</button>
                </div>
                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                  {["test", "live"].map((environment) => {
                    const current = environmentData.environments.find((item) => item.environment === environment)?.config?.current_release_id;
                    const releases = environmentData.releases.filter((release) => release.environment === environment);
                    return <section key={environment}>
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">{environment} releases</div>
                      <div className="mt-2 max-h-80 space-y-2 overflow-auto">
                        {!releases.length && <div className="text-sm text-slate-500">No {environment} releases yet.</div>}
                        {releases.map((release) => <div key={release.id} className="rounded-lg border border-line bg-ink-900/70 p-3">
                          <div className="flex items-center gap-2"><span className={`tag ${release.id === current ? "text-emerald-400" : "text-slate-400"}`}>{release.id === current ? "current" : release.status}</span><span className="ml-auto text-[10px] text-slate-500">{new Date(release.created_at).toLocaleString()}</span></div>
                          <div className="mt-2 flex gap-2">
                            {environment === "test" && release.status === "ready" && <button className="btn-ghost text-xs" disabled={environmentBusy} onClick={() => releaseAction(release, "promote")}>Promote live</button>}
                            {environment === "live" && release.status === "ready" && release.id !== current && <button className="btn-ghost text-xs" disabled={environmentBusy} onClick={() => releaseAction(release, "rollback")}>Rollback here</button>}
                          </div>
                        </div>)}
                      </div>
                    </section>;
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showTemplates && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[52rem] max-w-[96vw] max-h-[90vh] overflow-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div><div className="font-display text-lg font-semibold text-slate-100">Templates and remixing</div><div className="mt-1 text-xs text-slate-400">Save strong starting points and clone them into independent new projects.</div></div>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowTemplates(false)} aria-label="Close templates">✕</button>
            </div>
            {templateError && <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{templateError}</div>}
            <div className="mt-5 rounded-xl border border-line bg-ink-900/70 p-4">
              <div className="text-sm font-medium text-slate-200">Save this app as a private template</div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_.55fr]">
                <input className="input text-sm" placeholder="Template name" value={templateDraft.name} onChange={(event) => setTemplateDraft((value) => ({ ...value, name: event.target.value }))} />
                <select className="input text-sm" value={templateDraft.category} onChange={(event) => setTemplateDraft((value) => ({ ...value, category: event.target.value }))}>
                  <option value="saas">SaaS</option><option value="business">Business</option><option value="commerce">Commerce</option><option value="dashboard">Dashboard</option><option value="other">Other</option>
                </select>
              </div>
              <input className="input mt-2 w-full text-sm" placeholder="What makes this template useful?" value={templateDraft.description} onChange={(event) => setTemplateDraft((value) => ({ ...value, description: event.target.value }))} />
              <button className="btn-primary mt-3 px-4 py-2 text-xs" disabled={templateBusy || !templateDraft.name.trim()} onClick={saveCurrentTemplate}>Save template</button>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {!templateBusy && !templates.length && <div className="text-sm text-slate-500">No templates yet. Save this app to create your first one.</div>}
              {templates.map((template) => <div key={template.id} className="rounded-xl border border-line bg-ink-900/70 p-4">
                <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-slate-200">{template.name}</div><div className="mt-1 text-xs text-slate-500">{template.description || "Reusable app starting point"}</div></div><span className="tag text-amber-soft">{template.category}</span></div>
                <div className="mt-4 flex items-center gap-2"><button className="btn-primary px-3 py-1 text-xs" disabled={templateBusy} onClick={() => remixSavedTemplate(template)}>Remix</button>{template.owner && <button className="btn-ghost text-xs text-red-300" disabled={templateBusy} onClick={async () => {
                  if (!window.confirm(`Delete the template “${template.name}”?`)) return;
                  setTemplateBusy(true); try { await deleteTemplate(template.id); setTemplates(await listTemplates()); } catch (error) { setTemplateError(error.message || String(error)); } finally { setTemplateBusy(false); }
                }}>Delete</button>}<span className="ml-auto text-[10px] text-slate-600">{template.times_remixed} remixes</span></div>
              </div>)}
            </div>
          </div>
        </div>
      )}
      {androidBusy && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-sm p-6">
          <div className="panel w-[27rem] max-w-[92vw] p-8 text-center">
            <div className="mx-auto mb-6 h-11 w-11 rounded-full border-2 border-line border-t-amber animate-spin" />
            <div className="font-display text-lg font-semibold text-slate-100">Building your Android app</div>
            <div className="mt-2 text-sm text-slate-400 min-h-[2.5em]">{androidStage(androidElapsed)}</div>
            <div className="mt-1 font-mono text-xs text-slate-500">{fmtElapsed(androidElapsed)} elapsed</div>
            <div className="mt-6 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2.5 text-xs text-amber-soft leading-relaxed">
              This usually takes 2–3 minutes. Keep this tab open — don't refresh or close it. Your
              download starts automatically when it's ready.
            </div>
          </div>
        </div>
      )}
      {/* header */}
      <div className="relative flex items-center justify-between px-5 border-b border-line">
        <div className="min-w-0">
          {editingName ? (
            <input className="field py-0.5 px-1.5 text-sm font-medium w-64 max-w-full" value={nameDraft} autoFocus
              maxLength={80}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setNameDraft(project.name || ""); setEditingName(false); } }} />
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-medium text-slate-100 truncate">{project.name}</span>
              <button className="text-slate-600 hover:text-amber shrink-0" title="Rename project" aria-label="Rename project"
                onClick={() => { setNameDraft(project.name || ""); setEditingName(true); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
            </div>
          )}
          <div className="text-[11px] font-mono text-slate-500">{hasApp ? "iterating" : "new app"} · {prompts.length} turn{prompts.length === 1 ? "" : "s"}</div>
        </div>
        {/* min-w-0 + overflow-x-auto (NOT on the header itself — that would clip the absolute
            popovers below) so the strip touch-drags left on narrow screens instead of cutting off */}
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-none pl-2">
          <button className="btn-ghost text-xs shrink-0" onClick={() => { setShowKnowledge((v) => !v); setKnowledgeMsg(null); setShowSite(false); setShowTools(false); setShowDesign(false); }}
            title="Standing instructions (brand, tone, constraints) applied to every build and change">
            Knowledge{knowledge.trim() ? " ●" : ""}
          </button>
          <button className="btn-ghost text-xs shrink-0" onClick={() => { setShowDesign((v) => !v); setShowKnowledge(false); setShowSite(false); setShowTools(false); }}
            title="Choose automatic or guided premium art direction">
            Design{project.designProfile ? " active" : ""}
          </button>
          {featureAccess?.test_fix?.allowed && (
            <button className="btn-ghost text-xs shrink-0" onClick={testApp} disabled={!hasApp || busy || qaBusy}
              title={hasApp ? "Test routes, errors and responsive layout" : "Generate an app before testing"}>
              {qaBusy ? "Testing…" : "Test app"}
            </button>
          )}
          <button className={`btn-ghost text-xs shrink-0 ${showTools ? "border-amber/50 bg-ink-800 text-slate-100" : ""}`}
            onClick={() => { setShowTools((value) => !value); setShowKnowledge(false); setShowDesign(false); setShowSite(false); }}
            disabled={!hasApp || busy || !featureAccess} title="Style, extend and operate this app">
            Tools <span className="text-[9px] text-slate-500">▾</span>
          </button>
          <button className="btn-ghost text-xs shrink-0" onClick={doDownload} disabled={!hasApp || busy || downloadBusy}
            title={hasApp ? "Download project ZIP" : "Generate an app before downloading"}>
            {downloadBusy ? "Downloading..." : "Download"}
          </button>
          {!publishedUrl ? (
            <button className="btn-ghost text-xs shrink-0" disabled={!hasApp || busy || publishBusy}
              title={hasApp ? "Publish this app to a public URL" : "Generate an app before publishing"}
              onClick={() => { setSiteName(clientSlugify(project.name)); setPublishErr(null); setShowPublish(true); }}>
              {publishBusy ? "Publishing…" : "Publish"}
            </button>
          ) : (
            <button className="btn-ghost text-xs shrink-0" onClick={() => { setShowSite((v) => !v); setShowKnowledge(false); setShowDesign(false); setShowTools(false); setShowDomain(false); }}
              title="Your live site — republish, domain, unpublish">
              {publishBusy ? "Publishing…" : <>Site <span className="text-amber-soft">●</span> ▾</>}
            </button>
          )}
        </div>
        {showTools && (
          <>
            <button className="fixed inset-0 z-10 cursor-default" onClick={() => setShowTools(false)} aria-label="Close tools menu" />
            <div className="absolute right-4 top-full z-30 mt-1 w-[43rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-ink-900 shadow-2xl">
              <div className="flex items-center justify-between border-b border-line bg-ink-850/70 px-4 py-3">
                <div><div className="text-sm font-medium text-slate-100">App tools</div><div className="mt-0.5 text-[10px] text-slate-500">Style, extend and operate without crowding your workspace.</div></div>
                <span className="tag bg-amber/10 text-amber-soft">project</span>
              </div>
              <div className="grid gap-px bg-line sm:grid-cols-3">
                <section className="bg-ink-900 p-2">
                  <div className="px-2 pb-1.5 pt-1 text-[9px] font-mono uppercase tracking-[0.18em] text-slate-600">Create</div>
                  {featureAccess?.visual_editor?.allowed && <ToolAction mark="VS" title="Visual style" detail="Colours, type and radius · 0 credits" onClick={() => { setShowTools(false); openBrandEditor(); }} />}
                  {featureAccess?.templates?.allowed && <ToolAction mark="TM" title="Templates" detail="Save and remix starting points" onClick={() => { setShowTools(false); openTemplates(); }} />}
                </section>
                <section className="bg-ink-900 p-2">
                  <div className="px-2 pb-1.5 pt-1 text-[9px] font-mono uppercase tracking-[0.18em] text-slate-600">Extend</div>
                  {featureAccess?.integrations?.allowed && <ToolAction mark="CP" title="Capabilities" detail="AI, media, APIs, data and workflows" onClick={() => { setShowTools(false); setShowConnectorHub(true); }} accent />}
                  {featureAccess?.saas_runtime?.allowed && <ToolAction mark="£" title="Payments" detail="Stripe products and checkout" onClick={() => { setShowTools(false); openPayments(); }} />}
                  {featureAccess?.github_export?.allowed && <ToolAction mark="GH" title="GitHub" detail="Export and sync source" onClick={() => { setShowTools(false); openGithubPanel(); }} />}
                </section>
                <section className="bg-ink-900 p-2">
                  <div className="px-2 pb-1.5 pt-1 text-[9px] font-mono uppercase tracking-[0.18em] text-slate-600">Operate</div>
                  {featureAccess?.owner_console?.allowed && <ToolAction mark="CO" title="Console" detail="Users, records and orders" onClick={() => { setShowTools(false); refreshOwnerConsole(true); }} />}
                  {featureAccess?.analytics?.allowed && <ToolAction mark="AN" title="Analytics" detail="Traffic, events and errors" onClick={() => { setShowTools(false); openAnalytics(); }} />}
                  {featureAccess?.environments?.allowed && <ToolAction mark="EN" title="Environments" detail="Test, promote and roll back" onClick={() => { setShowTools(false); refreshEnvironments(true); }} />}
                </section>
              </div>
            </div>
          </>
        )}
        {showSite && publishedUrl && (
          <div className="absolute right-4 top-full mt-1 z-20 w-[20rem] panel p-1.5 shadow-xl">
            <a className="block px-3 py-2 rounded-lg text-xs font-mono text-amber-soft hover:bg-ink-850 truncate"
              href={publishedUrl} target="_blank" rel="noreferrer" title={publishedUrl}>
              {publishedUrl.replace(/^https:\/\//, "").replace(/\/$/, "")} ↗
            </a>
            <button className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-ink-850"
              disabled={busy || publishBusy}
              onClick={() => { setShowSite(false); doPublish(); }}>
              Republish current version
            </button>
            <button className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-ink-850"
              onClick={() => { setShowSite(false); openDomains(); }}>
              Custom domain…
            </button>
            <button className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-ink-850 disabled:opacity-50"
              disabled={androidBusy || busy || publishBusy}
              onClick={() => { setShowSite(false); doDownloadAndroid(); }}
              title="Build a signed Android app (APK + AAB) from your published site">
              {androidBusy ? "Building Android app…" : "Download Android app"}
            </button>
            <button className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-400/90 hover:bg-ink-850"
              disabled={publishBusy}
              onClick={() => { setShowSite(false); doUnpublish(); }}>
              Unpublish site
            </button>
          </div>
        )}
        {showDomain && (
          <div className="absolute right-4 top-full mt-1 z-20 w-[26rem] panel p-4 shadow-xl">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500">Custom domain</span>
              <span className="tag bg-amber/15 text-amber-soft">Pro</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Serve this site on your own domain. Point an A record for it to{" "}
              <span className="font-mono text-slate-300">{domainInfo?.ip || "51.195.136.189"}</span>, then connect it —
              HTTPS is automatic.
            </p>
            {(domainInfo?.domains || []).map((d) => (
              <div key={d.domain} className="mt-2 flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-slate-200 truncate">{d.domain}</span>
                <span className={`tag ${d.verified_at ? "bg-amber/15 text-amber-soft" : "bg-ink-800 text-slate-400"}`}>
                  {d.verified_at ? "live" : "waiting for DNS"}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  {!d.verified_at && (
                    <button className="text-slate-400 hover:text-amber" disabled={domainBusy}
                      onClick={() => doConnectDomain(d.domain)}>Check</button>
                  )}
                  <button className="text-slate-500 hover:text-red-400" disabled={domainBusy}
                    onClick={() => doRemoveDomain(d.domain)} title="Disconnect">✕</button>
                </div>
              </div>
            ))}
            <div className="mt-3 flex items-center gap-2">
              <input className="field flex-1" placeholder="yourbusiness.com" value={domainInput}
                onChange={(e) => setDomainInput(e.target.value.trim().toLowerCase())}
                onKeyDown={(e) => { if (e.key === "Enter" && domainInput) doConnectDomain(domainInput); }} />
              <button className="btn-primary text-xs px-3 py-1" disabled={domainBusy || !domainInput}
                onClick={() => doConnectDomain(domainInput)}>
                {domainBusy ? "Connecting…" : "Connect"}
              </button>
            </div>
            {domainMsg && <div className="mt-2 text-xs text-slate-300">{domainMsg}</div>}
            <div className="flex justify-end mt-2">
              <button className="btn-ghost text-xs" onClick={() => setShowDomain(false)}>Close</button>
            </div>
          </div>
        )}
        {showPublish && (
          <div className="absolute right-4 top-full mt-1 z-20 w-[24rem] panel p-4 shadow-xl">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500">Publish</span>
              <span className="tag bg-amber/15 text-amber-soft">Paid plans</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Pick your site's address — lowercase letters, numbers and dashes.</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Want your own domain (yourbusiness.com)? Publish first, then open <span className="text-slate-300">Site ▾ → Custom domain</span>.
            </p>
            <div className="mt-2 flex items-center gap-1">
              <input className="field flex-1" value={siteName} maxLength={40} autoFocus
                onChange={(e) => { setSiteName(clientSlugify(e.target.value, true)); setPublishErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && siteName.length >= 3) doPublish(siteName); }} />
              <span className="text-[11px] font-mono text-slate-500 shrink-0">.app.buildr101.com</span>
            </div>
            {publishErr && <div className="mt-2 text-xs text-red-400">{publishErr}</div>}
            <div className="flex items-center justify-end gap-2 mt-3">
              <button className="btn-ghost text-xs" onClick={() => setShowPublish(false)}>Cancel</button>
              <button className="btn-primary text-xs px-3 py-1" disabled={publishBusy || siteName.length < 3}
                onClick={() => doPublish(siteName)}>
                {publishBusy ? "Publishing…" : "Publish site"}
              </button>
            </div>
          </div>
        )}
        {showDesign && (
          <div className="absolute right-4 top-full mt-1 z-20 w-[27rem] max-w-[calc(100vw-2rem)] panel p-4 shadow-xl">
            <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500">Premium design direction</div>
            <p className="text-xs text-slate-400 mt-1">
              Automatic chooses a product-specific layout, palette and font pair. A preset guides the art direction without forcing every app into one template.
            </p>
            {project.designProfile && (
              <div className="mt-3 rounded-lg border border-line bg-ink-900/60 px-3 py-2 text-xs text-slate-300">
                Current direction: <span className="text-amber-soft">{project.designProfile.family}</span>
                <span className="text-slate-500"> / {project.designProfile.category}</span>
              </div>
            )}
            <label className="block mt-3 text-[11px] text-slate-500">Style preset</label>
            <select className="field mt-1" value={stylePreset} onChange={(e) => setStylePreset(e.target.value)} disabled={busy}>
              <option value="auto">Automatic</option>
              <option value="editorial-luxury">Editorial luxury</option>
              <option value="bold-expressive">Bold expressive</option>
              <option value="warm-organic">Warm organic</option>
              <option value="clean-saas">Clean SaaS</option>
              <option value="technical-dark">Technical dark</option>
              <option value="playful">Playful</option>
            </select>
            <label className="block mt-3 text-[11px] text-slate-500">Optional custom direction</label>
            <textarea className="field mt-1 h-20 resize-none" value={styleNotes} maxLength={500} disabled={busy}
              onChange={(e) => setStyleNotes(e.target.value)}
              placeholder="e.g. refined Japanese editorial feel, warm paper tones, avoid gradients" />
            <div className="flex items-center justify-between gap-3 mt-3">
              <span className="text-[11px] text-slate-500">
                {hasApp ? "Normal edits preserve the current look." : "Used when this app is generated."}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button className="btn-ghost text-xs" onClick={() => setShowDesign(false)}>Close</button>
                {hasApp && (
                  <button className="btn-primary text-xs px-3 py-1" disabled={busy}
                    onClick={() => { setShowDesign(false); run("Give this app a complete premium visual redesign using the selected design direction.", { redesign: true }); }}>
                    Redesign app
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {showKnowledge && (
          <div className="absolute right-4 top-full mt-1 z-20 w-[26rem] panel p-4 shadow-xl">
            <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500">Project knowledge</div>
            <p className="text-xs text-slate-400 mt-1">
              Standing instructions applied to every build and change — brand, tone, constraints.
              e.g. “Company is Zed Accounting. Brand colour crimson. UK dates. Formal tone.”
            </p>
            <textarea className="field mt-2 h-32 resize-none" value={knowledge} maxLength={4000}
              onChange={(e) => setKnowledge(e.target.value)} placeholder="No knowledge set — builds use only your prompts." />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-slate-500">{knowledgeMsg || `${knowledge.length}/4000`}</span>
              <div className="flex items-center gap-2">
                <button className="btn-ghost text-xs" onClick={() => setShowKnowledge(false)}>Close</button>
                <button className="btn-primary text-xs px-3 py-1" onClick={async () => {
                  try {
                    await ensurePersisted();
                    await saveKnowledge(project.id, knowledge.trim() || null);
                    setKnowledgeMsg("Saved ✓");
                  }
                  catch (e) { setKnowledgeMsg(e.message || String(e)); }
                }}>Save</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* body: build band on top, wide landscape preview stacked below. minmax floor keeps the
          preview from being crushed on short/narrow viewports — the body scrolls instead. */}
      <div className="grid grid-rows-[auto_minmax(24rem,1fr)] min-h-0 overflow-y-auto">
        {/* build band — describe · turns · engine. Once the app is previewing it collapses to a
            slim composer (detailsOpen) so the preview owns the window. */}
        {hasApp && !detailsOpen ? (
        <div className="border-b border-line">
          <div className="flex items-center gap-3 px-4 py-2">
            <input className="field !py-1.5 flex-1 min-w-0" value={text} disabled={busy}
              placeholder="Describe a change — e.g. make the header sticky"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
            <button className="btn-primary shrink-0" onClick={() => run()} disabled={busy || !text.trim()}>
              Apply change
            </button>
            {result && (
              <span className="hidden xl:block shrink-0 text-[11px] font-mono text-slate-500" title="Last turn">
                {result.mode === "plan" ? "plan" : `build ${result.buildOk ? "PASS" : "FAIL"}`}
                {result.need > 0 ? ` · ${Number(result.need).toFixed(2)} cr` : ""}
              </span>
            )}
            <button className="shrink-0 text-[11px] font-mono text-slate-500 hover:text-slate-300"
              title="Show turn history and the build log" onClick={() => setDetailsOpen(true)}>
              details ▾
            </button>
          </div>
          {selectedEl && (
            <div className="px-4 pb-2 flex items-center justify-between text-[11px] text-amber">
              <span className="truncate" title={selectedEl.outerHTML}>
                ◎ Selected: &lt;{selectedEl.tag}&gt;{selectedEl.text ? ` “${selectedEl.text.slice(0, 40)}${selectedEl.text.length > 40 ? "…" : ""}”` : ""} — your next change targets it
              </span>
              <button className="text-slate-500 hover:text-red-400 shrink-0 ml-2" title="Clear selection"
                onClick={() => setSelectedEl(null)}>✕</button>
            </div>
          )}
          {err && <div className="px-4 pb-2 text-xs text-red-400">{err}</div>}
        </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[24rem_16rem_minmax(0,1fr)] border-b border-line">
          <div className="p-4 lg:border-r border-line">
            <label className="text-[11px] font-mono uppercase tracking-wider text-slate-500">
              {hasApp ? "Describe a change" : "Describe your app"}
            </label>
            <textarea className="field mt-2 h-28 resize-none" value={text} disabled={busy}
              placeholder={hasApp ? "e.g. add a dark-mode toggle in the header" : "e.g. a notes app with tags and search"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }} />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-slate-500">⌘/Ctrl + Enter</span>
              <div className="flex items-center gap-3">
                {!hasApp && (
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none"
                    title="Plan first (small metered pass, no build); Generate then builds against the plan">
                    <input type="checkbox" className="accent-amber-500" checked={planMode} disabled={busy}
                      onChange={(e) => setPlanMode(e.target.checked)} />
                    Plan mode
                  </label>
                )}
                <button className="btn-primary" onClick={() => run()} disabled={busy || !text.trim()}>
                  {busy ? (planMode && !hasApp ? "Planning…" : "Building…")
                    : hasApp ? "Apply change" : planMode ? "Plan app" : "Generate app"}
                </button>
              </div>
            </div>
            {selectedEl && (
              <div className="mt-2 flex items-center justify-between text-[11px] text-amber">
                <span className="truncate" title={selectedEl.outerHTML}>
                  ◎ Selected: &lt;{selectedEl.tag}&gt;{selectedEl.text ? ` “${selectedEl.text.slice(0, 40)}${selectedEl.text.length > 40 ? "…" : ""}”` : ""} — your next change targets it
                </span>
                <button className="text-slate-500 hover:text-red-400 shrink-0 ml-2" title="Clear selection"
                  onClick={() => setSelectedEl(null)}>✕</button>
              </div>
            )}
            {pendingPlan && !hasApp && !busy && (
              <div className="mt-2 flex items-center justify-between text-[11px] text-amber-soft">
                <span>Plan ready — “Generate app” will build against it.</span>
                <button className="text-slate-500 hover:text-red-400" title="Discard plan"
                  onClick={() => setPendingPlan(null)}>✕</button>
              </div>
            )}
            {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
          </div>

          {/* turn history */}
          <div className="px-4 py-3 space-y-2 overflow-auto lg:border-r border-t lg:border-t-0 border-line" style={{ maxHeight: "12rem" }}>
            {prompts.length === 0 && <div className="text-xs text-slate-500">No turns yet.</div>}
            {prompts.map((p, i) => (
              <div key={i} className="text-xs group">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-slate-300 min-w-0">▸ {p.prompt}</div>
                  {p.tree && i !== prompts.length - 1 && (
                    <button className="shrink-0 text-slate-600 hover:text-amber opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Revert the app to this version (later turns stay in history)"
                      disabled={busy} onClick={() => revertTo(i)}>⟲</button>
                  )}
                </div>
                <div className="text-slate-500 font-mono text-[10px] mt-0.5">
                  {p.mode === "revert" ? "⟲ revert"
                    : p.mode === "plan" ? `${p.need != null ? `${Number(p.need).toFixed(3)} cr` : "—"} · plan`
                    : `${p.need != null ? `${Number(p.need).toFixed(3)} cr` : "—"} · build ${p.buildOk ? "PASS" : "FAIL"}${p.planUsed ? " (from plan)" : ""}`}
                </div>
              </div>
            ))}
          </div>

          {/* live build status — the coarse phase timeline (engine internals stay server-side) */}
          <div className="flex flex-col min-h-0 border-t lg:border-t-0 border-line">
            <div className="px-4 pt-3 flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500">Build</span>
              {busy && activeJobId && (
                <button className="text-[11px] font-mono text-red-400/80 hover:text-red-300"
                  title="Stop this build — it halts at the next safe point" onClick={doCancelBuild}>
                  cancel ■
                </button>
              )}
              {hasApp && !busy && (
                <button className="text-[11px] font-mono text-slate-500 hover:text-slate-300"
                  title="Collapse to a slim bar — the preview gets the room" onClick={() => setDetailsOpen(false)}>
                  hide ▴
                </button>
              )}
            </div>
            <div className="overflow-auto px-4 py-2" style={{ height: "9rem" }}>
              <PhaseTimeline phase={phase} busy={busy} mode={runningMode} lastResult={result} />
              {result?.mode === "plan" && result.finalText && (
                <div className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300 border-t border-line pt-2">{result.finalText}</div>
              )}
            </div>
            {result && (
              <div className="px-4 py-2 border-t border-line text-[11px] font-mono text-slate-400">
                {result.need > 0 ? (
                  <>used <span className="text-amber">{Number(result.need).toFixed(4)} cr</span>
                  {result.balance != null && <> · balance <span className="text-slate-100">{Number(result.balance).toFixed(3)} cr</span></>}</>
                ) : (
                  <>no credits used</>
                )} · {result.mode === "plan" ? "plan (no build)" : `build ${result.buildOk ? "PASS" : "FAIL"}`}
              </div>
            )}
          </div>
        </div>
        )}

        {/* preview */}
        <div className="min-w-0 bg-ink-950 flex flex-col">
          <div className="flex items-center justify-between px-4 h-9 border-b border-line">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono text-slate-500">preview{previewUrl ? "" : " · not running"}</span>
              {previewUrl && hasApp && (
                <button onClick={toggleSelectMode} disabled={busy}
                  className={`text-[11px] font-mono px-2 py-0.5 rounded border transition-colors ${selectMode
                    ? "border-amber text-amber bg-amber/10"
                    : "border-line text-slate-500 hover:text-amber hover:border-amber/50"}`}
                  title="Click an element in the preview to target your next change at it">
                  {selectMode ? "◎ click an element…" : "◎ select element"}
                </button>
              )}
            </div>
            {previewUrl && <a className="text-[11px] text-slate-500 hover:text-amber font-mono" href={previewUrl} target="_blank" rel="noreferrer">{previewUrl} ↗</a>}
          </div>
          {appErr && (
            <div className="flex items-center gap-3 px-4 py-2 border-b border-red-900/60 bg-red-950/40">
              <span className="text-[11px] font-mono text-red-400 shrink-0">{appErr.kind === "build" ? "build error" : "runtime error"}</span>
              <span className="text-xs text-red-200/90 truncate min-w-0" title={`${appErr.message}\n\n${appErr.stack || ""}`}>{appErr.message}</span>
              <button className="btn-primary text-xs px-3 py-1 shrink-0" onClick={fixIt} disabled={busy}
                title="Send this error to the builder and fix it (normal build spend)">
                {busy ? "Fixing…" : "Fix it"}
              </button>
              <button className="text-slate-500 hover:text-slate-300 shrink-0" title="Dismiss" onClick={() => setAppErr(null)}>✕</button>
            </div>
          )}
          <div className="flex-1 min-h-0 grid place-items-stretch">
            {previewUrl ? (
              <iframe ref={iframeRef} title="preview" src={previewUrl} className="w-full h-full bg-white" />
            ) : (
              <div className="grid place-items-center text-sm text-slate-500">
                {hasApp ? "Starting preview…" : "Your running app will appear here after you generate it."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function deriveName(prompt) {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ToolAction({ mark, title, detail, onClick, accent = false }) {
  return (
    <button className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-ink-800" onClick={onClick}>
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border font-mono text-[9px] font-semibold ${accent
        ? "border-amber/30 bg-amber/10 text-amber-soft" : "border-line bg-ink-850 text-slate-500 group-hover:text-slate-300"}`}>{mark}</span>
      <span className="min-w-0"><span className="block text-xs font-medium text-slate-200">{title}</span><span className="mt-0.5 block truncate text-[9px] text-slate-600">{detail}</span></span>
    </button>
  );
}

// Android build progress — honest, elapsed-driven stages (the request is a plain long POST with no
// server progress events, so these track the known phases by time rather than real signals).
function androidStage(s) {
  if (s < 6) return "Preparing your app's signing key…";
  if (s < 20) return "Publishing app verification…";
  if (s < 100) return "Compiling and signing the Android app (APK + AAB)…";
  return "Almost there — packaging your download…";
}
function fmtElapsed(s) {
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// The job's coarse phase stream rendered as a timeline. This is ALL the server sends — engine
// internals (models, tools, file paths, token counts) never reach the browser.
const PHASE_LABELS = {
  queued: "Waiting for a build slot",
  preparing: "Getting things ready",
  planning: "Drafting the plan",
  designing: "Frontend designer mapping every screen",
  building: "Building your app",
  "quality-checking": "Checking every screen and mobile layout",
  polishing: "Polishing the complete frontend system",
  finalizing: "Finishing up — compiling and starting the preview",
};

function PhaseTimeline({ phase, busy, mode, lastResult }) {
  if (!phase) {
    if (lastResult) {
      return (
        <div className={`text-xs flex items-center gap-2 ${lastResult.mode !== "plan" && lastResult.buildOk === false ? "text-red-400" : "text-amber-soft"}`}>
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${lastResult.mode !== "plan" && lastResult.buildOk === false ? "bg-red-400" : "bg-amber"}`} />
          {lastResult.mode === "plan" ? "Plan ready" : lastResult.buildOk ? "Done — your app is live in the preview" : "Build failed — use “Fix it” above the preview"}
        </div>
      );
    }
    return <div className="text-[11px] font-mono text-slate-500">Idle — describe your app and generate (spends 1 build).</div>;
  }
  const order = mode === "plan"
    ? ["queued", "preparing", "planning"]
    : mode === "iterate"
      ? ["queued", "preparing", "building", "finalizing"]
      : ["queued", "preparing", "designing", "building", "quality-checking", ...(phase === "polishing" ? ["polishing"] : []), "finalizing"];
  const idx = Math.max(0, order.indexOf(phase));
  const steps = order.slice(0, idx + 1);
  return (
    <ol className="space-y-1 text-xs">
      {steps.map((p, i) => {
        const last = i === steps.length - 1;
        const label = p === "building" && mode === "iterate" ? "Applying your change" : PHASE_LABELS[p];
        return (
          <li key={p} className={`flex items-center gap-2 ${last ? "text-slate-200" : "text-slate-400"}`}>
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${last && busy ? "bg-amber animate-pulse" : "bg-amber"}`} />
            <span className="truncate">{label}{last && busy ? "…" : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Mirror of the server's slugify (the server re-validates; this is just live input shaping).
// `typing` keeps a trailing dash while the user is mid-word.
function clientSlugify(name, typing = false) {
  const s = String(name || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return typing ? s.replace(/^-+/, "") : s.replace(/^-+|-+$/g, "");
}

// Keep full-tree snapshots on only the most recent N history entries (history itself is never
// trimmed — older entries just drop their tree, so the jsonb column stays bounded).
const SNAPSHOT_KEEP = 20;
function capSnapshots(list) {
  const withTree = list.reduce((acc, p, i) => (p.tree ? [...acc, i] : acc), []);
  const drop = new Set(withTree.slice(0, Math.max(0, withTree.length - SNAPSHOT_KEEP)));
  if (drop.size === 0) return list;
  return list.map((p, i) => (drop.has(i) ? { ...p, tree: undefined } : p));
}
