import { useState } from "react";
import { backend, backendConfigured } from "../lib/backend.js";

// Sign up / sign in on the EXISTING Phase 3 backend SDK — auth.signUp / auth.signIn. No auth is
// rebuilt here; owner-scoping/RLS is enforced DB-side. The shell just authenticates.
export default function AuthGate() {
  const [mode, setMode] = useState("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      if (mode === "signup") await backend().auth.signUp({ email, password });
      else await backend().auth.signIn({ email, password });
      // useSession's onAuthStateChange picks the session up.
    } catch (e2) {
      setErr(e2.message || String(e2));
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <div className="w-full max-w-sm panel p-7">
        <div className="flex items-center gap-2 mb-1">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-slate-100">Buildr101</span>
        </div>
        <p className="text-sm text-slate-400 mb-6">Describe an app. Watch it build. Keep iterating.</p>

        {!backendConfigured && (
          <div className="mb-4 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber-soft">
            Supabase not configured — set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in shell/web/.env
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          <input className="field" type="email" placeholder="you@example.com" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <input className="field" type="password" placeholder="password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button className="btn-primary w-full" disabled={busy || !backendConfigured}>
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>

        <button className="mt-4 text-xs text-slate-400 hover:text-slate-200"
          onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setErr(null); }}>
          {mode === "signup" ? "Have an account? Sign in" : "New here? Create an account"}
        </button>
      </div>
    </div>
  );
}

export function Logo({ className = "" }) {
  return (
    <span className={`inline-grid place-items-center h-7 w-7 rounded-md bg-amber text-ink-950 font-bold ${className}`}>◆</span>
  );
}
