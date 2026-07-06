import { useEffect, useRef, useState } from "react";
import { downloadProject, generate, publishProject, startPreview } from "../lib/api.js";
import { saveProject, saveKnowledge, savePublishedUrl } from "../lib/projects.js";

// The core loop: describe -> generate -> preview -> iterate. Wired to the REAL engine via the
// server's /api/generate (the only Codex-spending action; fires only on the button click below).
export default function Builder({ project, onProjectChange, onAfterTurn }) {
  const [tree, setTree] = useState(project.tree || null);
  const [prompts, setPrompts] = useState(project.prompts || []);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [text, setText] = useState("");
  // Plan mode: toggle ON → the button runs a plan-only pass; the resulting plan is held in
  // pendingPlan (session state — not persisted until a build saves the prompts history; reopening
  // an un-built project drops a held plan) and fed into the next build so it steers generation.
  const [planMode, setPlanMode] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  // The "Fix it" loop: { kind: "runtime" | "build", message, stack } — runtime errors arrive from
  // the preview iframe's devReporter via postMessage; build errors from the done payload's stderr.
  const [appErr, setAppErr] = useState(null);
  const [publishMsg, setPublishMsg] = useState(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState(project.publishedUrl || null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  // Project knowledge: standing instructions (brand, tone, constraints) sent with every turn.
  const [knowledge, setKnowledge] = useState(project.knowledge || "");
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [knowledgeMsg, setKnowledgeMsg] = useState(null);
  // Visual edits: click an element in the preview -> the next change is scoped to it.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedEl, setSelectedEl] = useState(null); // { tag, text, outerHTML, path }
  const logRef = useRef(null);
  const iframeRef = useRef(null);

  const hasApp = !!tree;
  const mode = hasApp ? "iterate" : "build";

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

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

  async function run(promptOverride) {
    const prompt = (typeof promptOverride === "string" ? promptOverride : text).trim();
    if (!prompt || busy) return;
    const effectiveMode = !hasApp && planMode ? "plan" : mode;
    // A selected element scopes a USER-TYPED iterate to that exact spot in the UI (cheaper, more
    // accurate). Composed prompts (Fix it) skip the scoping — they carry their own context.
    const scopedPrompt = effectiveMode === "iterate" && selectedEl && typeof promptOverride !== "string"
      ? `The user selected this element in the running app (path: ${selectedEl.path}):\n\`\`\`html\n${selectedEl.outerHTML}\n\`\`\`\n\nApply this change to that element: ${prompt}`
      : prompt;
    setBusy(true); setErr(null); setResult(null); setLog([]); setAppErr(null);
    try {
      const done = await generate(
        { projectId: project.id, prompt: scopedPrompt, mode: effectiveMode,
          tree: effectiveMode === "iterate" ? tree : undefined,
          plan: effectiveMode === "build" && pendingPlan ? pendingPlan : undefined,
          knowledge: knowledge.trim() || undefined },
        (name, data) => { if (name === "log") setLog((l) => [...l, data.line]); }
      );
      if (!done) throw new Error("no result");

      if (effectiveMode === "plan") {
        // Plan-only turn: show the plan, hold it for the next build press, auto-revert the toggle
        // so the toggle and button text always agree ("Generate app" is the next action).
        // DEFERRED: clarifying-question popups slot in HERE — between the plan arriving and the
        // auto-revert — pausing to ask the user before the plan is considered final.
        setLog((l) => [...l, "", "── PLAN ──", done.finalText || "(empty plan)"]);
        setPrompts((p) => [...p, {
          prompt, mode: "plan", finalText: done.finalText, at: new Date().toISOString(),
          need: done.need, model: done.decision?.model,
        }]);
        setPendingPlan(done.finalText || null);
        setPlanMode(false);
        setResult(done);
        return; // no tree/preview/save — the description stays in the box for "Generate app"
      }

      // Each non-plan turn snapshots the full tree so any version can be reverted to
      // (capSnapshots keeps the most recent SNAPSHOT_KEEP snapshots; older entries stay
      // in history but drop their tree).
      const nextPrompts = capSnapshots([...prompts, {
        prompt, mode: effectiveMode, finalText: done.finalText, at: new Date().toISOString(),
        need: done.need, model: done.decision?.model, buildOk: done.build?.ok,
        planUsed: effectiveMode === "build" && !!pendingPlan,
        tree: done.tree,
      }]);
      setTree(done.tree);
      setPrompts(nextPrompts);
      setResult(done);
      if (done.build?.ok === false) {
        setAppErr({ kind: "build", message: "The app failed to build.", stack: done.build.stderr || "" });
      }
      if (done.preview?.url) { setPreviewUrl(done.preview.url); }
      else if (iframeRef.current) { try { iframeRef.current.contentWindow?.location.reload(); } catch {} }
      if (typeof promptOverride !== "string") setText("");
      setPendingPlan(null); // the build consumed the plan
      setSelectedEl(null); // the iterate consumed the selection

      const name = project.name && project.name !== "Untitled app" ? project.name : deriveName(prompt);
      const saved = await saveProject(project.id, { name, tree: done.tree, prompts: nextPrompts, previewRef: done.preview?.url || null });
      onProjectChange?.({ id: project.id, ...saved });
      onAfterTurn?.();
    } catch (e) {
      setErr(e.payload?.error === "insufficient_balance"
        ? "No credits — buy a tier or top-up (right panel) to generate."
        : (e.message || String(e)));
    } finally { setBusy(false); }
  }

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

  // One-click repair: feed the captured error back into an iterate turn (normal metered spend).
  function fixIt() {
    if (!appErr || busy || !hasApp) return;
    const p = appErr.kind === "build"
      ? `The app fails to build. Fix the root cause of this build error:\n\n${appErr.stack || appErr.message}`
      : `The running app throws this runtime error:\n\n${appErr.message}${appErr.stack ? `\n\nStack:\n${appErr.stack}` : ""}\n\nFind and fix the root cause (do not just swallow the error).`;
    run(p);
  }

  async function doPublish() {
    if (!hasApp || publishBusy) return;
    setPublishBusy(true);
    setPublishMsg(null);
    try {
      const r = await publishProject(project.id, tree);
      setPublishedUrl(r.url);
      setPublishMsg(`Published ✓`);
      await savePublishedUrl(project.id, r.url).catch(() => {});
    } catch (e) {
      setPublishMsg(e.message || String(e));
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

  return (
    <div className="h-full grid grid-rows-[3.5rem_1fr]">
      {/* header */}
      <div className="relative flex items-center justify-between px-5 border-b border-line">
        <div className="min-w-0">
          <div className="font-medium text-slate-100 truncate">{project.name}</div>
          <div className="text-[11px] font-mono text-slate-500">{hasApp ? "iterating" : "new app"} · {prompts.length} turn{prompts.length === 1 ? "" : "s"}</div>
        </div>
        <div className="flex items-center gap-2">
          {publishMsg && <span className="text-[11px] text-slate-500 max-w-[16rem] truncate" title={publishMsg}>{publishMsg}</span>}
          {publishedUrl && (
            <a className="text-[11px] font-mono text-lime hover:underline max-w-[18rem] truncate"
              href={publishedUrl} target="_blank" rel="noreferrer" title={publishedUrl}>
              {publishedUrl.replace(/^https:\/\//, "").replace(/\/$/, "")} ↗
            </a>
          )}
          <button className="btn-ghost text-xs" onClick={() => { setShowKnowledge((v) => !v); setKnowledgeMsg(null); }}
            title="Standing instructions (brand, tone, constraints) applied to every build and change">
            Knowledge{knowledge.trim() ? " ●" : ""}
          </button>
          <button className="btn-ghost text-xs" onClick={doDownload} disabled={!hasApp || busy || downloadBusy}
            title={hasApp ? "Download project ZIP" : "Generate an app before downloading"}>
            {downloadBusy ? "Downloading..." : "Download"}
          </button>
          <button className="btn-ghost text-xs" onClick={doPublish} disabled={!hasApp || busy || publishBusy}
            title={hasApp ? (publishedUrl ? "Republish the current version" : "Publish this app to a public URL") : "Generate an app before publishing"}>
            {publishBusy ? "Publishing…" : publishedUrl ? "Republish" : "Publish"}
          </button>
        </div>
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
                  try { await saveKnowledge(project.id, knowledge.trim() || null); setKnowledgeMsg("Saved ✓"); }
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
        {/* build band — describe · turns · engine, laid out across the width so it stays short */}
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
              <div className="mt-2 flex items-center justify-between text-[11px] text-lime">
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
                    : p.mode === "plan" ? `${p.model} · ${p.need != null ? `${Number(p.need).toFixed(3)} cr` : "—"} · plan`
                    : `${p.model} · ${p.need != null ? `${Number(p.need).toFixed(3)} cr` : "—"} · build ${p.buildOk ? "PASS" : "FAIL"}${p.planUsed ? " (from plan)" : ""}`}
                </div>
              </div>
            ))}
          </div>

          {/* live engine log */}
          <div className="flex flex-col min-h-0 border-t lg:border-t-0 border-line">
            <div className="px-4 pt-3 text-[11px] font-mono uppercase tracking-wider text-slate-500">Engine</div>
            <pre ref={logRef} className="overflow-auto px-4 py-2 text-[11px] leading-relaxed font-mono text-slate-400 whitespace-pre-wrap" style={{ height: "9rem" }}>
{log.length === 0 ? "idle — click Generate to run the engine (spends 1 build)" : log.join("\n")}
            </pre>
            {result && (
              <div className="px-4 py-2 border-t border-line text-[11px] font-mono text-slate-400">
                {result.byok ? (
                  <><span className="text-lime">BYOK</span> — {result.telemetry?.total} tok on {result.decision?.model}, billed to your key (no credits)</>
                ) : (
                  <>debited <span className="text-amber">{Number(result.need).toFixed(4)} cr</span> ({result.decision?.model}, {result.telemetry?.total} tok) ·
                  balance <span className="text-lime">{result.balance?.total?.toFixed(3)} cr</span></>
                )} · {result.mode === "plan" ? "plan (no build)" : `build ${result.build?.ok ? "PASS" : "FAIL"}`}
              </div>
            )}
          </div>
        </div>

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

// Keep full-tree snapshots on only the most recent N history entries (history itself is never
// trimmed — older entries just drop their tree, so the jsonb column stays bounded).
const SNAPSHOT_KEEP = 20;
function capSnapshots(list) {
  const withTree = list.reduce((acc, p, i) => (p.tree ? [...acc, i] : acc), []);
  const drop = new Set(withTree.slice(0, Math.max(0, withTree.length - SNAPSHOT_KEEP)));
  if (drop.size === 0) return list;
  return list.map((p, i) => (drop.has(i) ? { ...p, tree: undefined } : p));
}
