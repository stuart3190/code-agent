import { useState } from "react";
import { client } from "../lib/backend.js";
import { Logo } from "./AuthGate.jsx";

// Shown when the user arrives via a password-reset email link (PASSWORD_RECOVERY session).
// Sets the new password on the recovery session, then hands control back to the normal app.
export default function ResetPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setErr("Passwords don't match."); return; }
    setBusy(true);
    try {
      const { error } = await client().auth.updateUser({ password });
      if (error) throw error;
      onDone();
    } catch (e2) {
      setErr(e2.message || String(e2));
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <div className="w-full max-w-sm panel p-7">
        <div className="flex items-center gap-2 mb-1">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-slate-100">Thrallo</span>
        </div>
        <p className="text-sm text-slate-400 mb-6">Choose a new password for your account.</p>

        <form onSubmit={submit} className="space-y-3">
          <input className="field" type="password" placeholder="New password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          <input className="field" type="password" placeholder="Confirm new password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Saving…" : "Set new password"}
          </button>
        </form>
      </div>
    </div>
  );
}
