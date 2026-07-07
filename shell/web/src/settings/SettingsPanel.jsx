import { useEffect, useState } from "react";
import { getByok, saveByok, clearByok, deleteAccount } from "../lib/api.js";
import { client } from "../lib/backend.js";
import { SUPPORT_EMAIL } from "../legal/LegalPage.jsx";

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

        <AccountPanel />

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

        <DangerZone />

        <div className="mt-8 pb-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
          <a className="hover:text-slate-400" href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>
          <a className="hover:text-slate-400" href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>
          <a className="hover:text-slate-400" href="/refunds" target="_blank" rel="noreferrer">Refund Policy</a>
          <a className="hover:text-slate-400" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </div>
      </div>
    </div>
  );
}

// Delete account — the confirm phrase is typed (not a window.confirm) because this one erases
// EVERYTHING: subscription, published sites, projects, their end-users' data, and the login.
function DangerZone() {
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const armed = phrase === "DELETE";

  async function destroy() {
    if (!armed || busy) return;
    setBusy(true); setErr(null);
    try {
      await deleteAccount();
      // The auth user is gone server-side; drop the dead local session and start over.
      await client().auth.signOut().catch(() => {});
      window.location.replace("/");
    } catch (e) {
      setErr(e.message || String(e));
      setBusy(false);
    }
  }

  return (
    <div className="panel p-6 mt-6 border-red-900/60">
      <h2 className="text-base font-medium text-red-400">Delete account</h2>
      <p className="text-sm text-slate-400 mt-1">
        Permanently deletes your account: any subscription is cancelled immediately, your published
        sites go offline (site names released, custom domains disconnected), and all your apps —
        including their users and data — are erased along with your remaining credits and sign-in.
        <span className="text-slate-300"> This cannot be undone.</span> Download anything you want to
        keep first.
      </p>
      <div className="mt-4 flex flex-col sm:flex-row gap-2">
        <input className="field font-mono" placeholder='Type "DELETE" to confirm' value={phrase}
          disabled={busy} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
        <button onClick={destroy} disabled={!armed || busy}
          className="whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium bg-red-600 text-white
            hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {busy ? "Deleting…" : "Delete my account"}
        </button>
      </div>
      {err && <div className="mt-3 text-xs text-red-400">{err}</div>}
    </div>
  );
}

// Account: who you're signed in as + change password in place (no email round-trip needed
// while you're already authenticated).
function AccountPanel() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    client().auth.getUser().then(({ data }) => setEmail(data?.user?.email || ""));
  }, []);

  async function changePassword() {
    setErr(null); setMsg(null);
    if (pw.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (pw !== pw2) { setErr("Passwords don't match."); return; }
    setBusy(true);
    try {
      const { error } = await client().auth.updateUser({ password: pw });
      if (error) throw error;
      setPw(""); setPw2("");
      setMsg("Password changed ✓");
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }

  return (
    <div className="panel p-6 mt-6">
      <h2 className="text-base font-medium text-slate-100">Account</h2>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-slate-500">Signed in as</span>
        <span className="font-mono text-slate-200">{email || "…"}</span>
      </div>
      <div className="mt-4">
        <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-2">Change password</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input className="field" type="password" placeholder="New password" value={pw}
            autoComplete="new-password" disabled={busy} onChange={(e) => setPw(e.target.value)} />
          <input className="field" type="password" placeholder="Confirm new password" value={pw2}
            autoComplete="new-password" disabled={busy} onChange={(e) => setPw2(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") changePassword(); }} />
          <button className="btn-primary whitespace-nowrap" onClick={changePassword}
            disabled={busy || !pw || !pw2}>
            {busy ? "Saving…" : "Change password"}
          </button>
        </div>
        {msg && <div className="mt-2 text-xs text-amber-soft">{msg}</div>}
        {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      </div>
    </div>
  );
}
