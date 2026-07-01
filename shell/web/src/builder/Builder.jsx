import { useEffect, useRef, useState } from "react";
import { generate, startPreview } from "../lib/api.js";
import { saveProject } from "../lib/projects.js";
import { publish } from "../publish/publishStub.js";

// The core loop: describe -> generate -> preview -> iterate. Wired to the REAL engine via the
// server's /api/generate (the only Codex-spending action; fires only on the button click below).
export default function Builder({ project, onProjectChange, onAfterTurn }) {
  const [tree, setTree] = useState(project.tree || null);
  const [prompts, setPrompts] = useState(project.prompts || []);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [publishMsg, setPublishMsg] = useState(null);
  const logRef = useRef(null);
  const iframeRef = useRef(null);

  const hasApp = !!tree;
  const mode = hasApp ? "iterate" : "build";

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

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

  async function run() {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true); setErr(null); setResult(null); setLog([]);
    try {
      const done = await generate(
        { projectId: project.id, prompt, mode, tree: mode === "iterate" ? tree : undefined },
        (name, data) => { if (name === "log") setLog((l) => [...l, data.line]); }
      );
      if (!done) throw new Error("no result");
      const nextPrompts = [...prompts, {
        prompt, mode, finalText: done.finalText, at: new Date().toISOString(),
        need: done.need, model: done.decision?.model, buildOk: done.build?.ok,
      }];
      setTree(done.tree);
      setPrompts(nextPrompts);
      setResult(done);
      if (done.preview?.url) { setPreviewUrl(done.preview.url); }
      else if (iframeRef.current) { try { iframeRef.current.contentWindow?.location.reload(); } catch {} }
      setText("");

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

  async function doPublish() {
    const r = await publish(project);
    setPublishMsg(r.message);
  }

  return (
    <div className="h-full grid grid-rows-[3.5rem_1fr]">
      {/* header */}
      <div className="flex items-center justify-between px-5 border-b border-line">
        <div className="min-w-0">
          <div className="font-medium text-slate-100 truncate">{project.name}</div>
          <div className="text-[11px] font-mono text-slate-500">{hasApp ? "iterating" : "new app"} · {prompts.length} turn{prompts.length === 1 ? "" : "s"}</div>
        </div>
        <div className="flex items-center gap-2">
          {publishMsg && <span className="text-[11px] text-slate-500 max-w-[16rem] truncate" title={publishMsg}>{publishMsg}</span>}
          <button className="btn-ghost text-xs" onClick={doPublish} title="Deferred — no-op stub">Publish ⓘ</button>
        </div>
      </div>

      {/* body: builder column | preview */}
      <div className="grid grid-cols-[23rem_1fr] min-h-0">
        {/* builder column */}
        <div className="border-r border-line flex flex-col min-h-0">
          <div className="p-4 border-b border-line">
            <label className="text-[11px] font-mono uppercase tracking-wider text-slate-500">
              {hasApp ? "Describe a change" : "Describe your app"}
            </label>
            <textarea className="field mt-2 h-28 resize-none" value={text} disabled={busy}
              placeholder={hasApp ? "e.g. add a dark-mode toggle in the header" : "e.g. a notes app with tags and search"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }} />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-slate-500">⌘/Ctrl + Enter</span>
              <button className="btn-primary" onClick={run} disabled={busy || !text.trim()}>
                {busy ? "Building…" : hasApp ? "Apply change" : "Generate app"}
              </button>
            </div>
            {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
          </div>

          {/* turn history */}
          <div className="px-4 py-3 space-y-2 overflow-auto border-b border-line" style={{ maxHeight: "12rem" }}>
            {prompts.length === 0 && <div className="text-xs text-slate-500">No turns yet.</div>}
            {prompts.map((p, i) => (
              <div key={i} className="text-xs">
                <div className="text-slate-300">▸ {p.prompt}</div>
                <div className="text-slate-500 font-mono text-[10px] mt-0.5">
                  {p.model} · {p.need != null ? `${Number(p.need).toFixed(3)} cr` : "—"} · build {p.buildOk ? "PASS" : "FAIL"}
                </div>
              </div>
            ))}
          </div>

          {/* live engine log */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-4 pt-3 text-[11px] font-mono uppercase tracking-wider text-slate-500">Engine</div>
            <pre ref={logRef} className="flex-1 overflow-auto px-4 py-2 text-[11px] leading-relaxed font-mono text-slate-400 whitespace-pre-wrap">
{log.length === 0 ? "idle — click Generate to run the engine (spends 1 build)" : log.join("\n")}
            </pre>
            {result && (
              <div className="px-4 py-2 border-t border-line text-[11px] font-mono text-slate-400">
                debited <span className="text-amber">{Number(result.need).toFixed(4)} cr</span> ({result.decision?.model}, {result.telemetry?.total} tok) ·
                balance <span className="text-lime">{result.balance?.total?.toFixed(3)} cr</span> · build {result.build?.ok ? "PASS" : "FAIL"}
              </div>
            )}
          </div>
        </div>

        {/* preview */}
        <div className="min-w-0 bg-ink-950 flex flex-col">
          <div className="flex items-center justify-between px-4 h-9 border-b border-line">
            <span className="text-[11px] font-mono text-slate-500">preview{previewUrl ? "" : " · not running"}</span>
            {previewUrl && <a className="text-[11px] text-slate-500 hover:text-amber font-mono" href={previewUrl} target="_blank" rel="noreferrer">{previewUrl} ↗</a>}
          </div>
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
