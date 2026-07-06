import { useEffect, useState } from "react";
import { getByok, saveByok, clearByok } from "../lib/api.js";

// Settings tab — BYOK (bring-your-own-key). Lets a user store an Anthropic API key so generation
// runs on their own inference account (no platform credits debited). The raw key is write-only: it
// is sent to the server on Save and never read back — status shows only a masked hint.
export default function SettingsPanel() {
  const [status, setStatus] = useState(null); // { set, provider?, hint? }
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try { setStatus(await getByok()); } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  async function save() {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true); setErr(null);
    try {
      const s = await saveByok(k);
      setStatus({ set: true, provider: s.provider, hint: s.hint });
      setKey(""); // never keep the raw key around after saving
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await clearByok(); setStatus({ set: false }); setKey(""); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">Account and provider settings.</p>

        <div className="panel p-6 mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium text-slate-100">Bring your own key</h2>
            {!loading && (
              <span className={`tag ${status?.set ? "bg-amber/15 text-amber-soft" : "bg-ink-800 text-slate-400"}`}>
                {status?.set ? "key set" : "no key"}
              </span>
            )}
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Use your own Anthropic API key for generation. When set, builds run on your account and
            <span className="text-slate-300"> your provider bills you directly — no platform credits are used.</span>
          </p>

          {status?.set && (
            <div className="mt-4 flex items-center gap-2 text-[13px] font-mono text-slate-300">
              <span className="text-slate-500">current:</span>
              <span className="text-amber-soft">{status.hint}</span>
              <span className="text-slate-500">· {status.provider}</span>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <input className="field font-mono" type="password" autoComplete="off" spellCheck={false}
              placeholder={status?.set ? "Enter a new key to replace" : "sk-ant-…"}
              value={key} disabled={busy} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
            <button className="btn-primary whitespace-nowrap" onClick={save} disabled={busy || !key.trim()}>
              {busy ? "…" : status?.set ? "Replace" : "Save key"}
            </button>
            {status?.set && (
              <button className="btn-ghost whitespace-nowrap" onClick={remove} disabled={busy}>Remove</button>
            )}
          </div>

          {err && <div className="mt-3 text-xs text-red-400">{err}</div>}
          <div className="mt-3 text-[11px] text-slate-500">
            Stored encrypted, tied to your account, and never shown again in full. Clear it any time to
            switch back to platform credits.
          </div>
        </div>
      </div>
    </div>
  );
}
