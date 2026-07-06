import { useState } from "react";
import { backend, backendConfigured, client } from "../lib/backend.js";

// Sign up / sign in on the EXISTING Phase 3 backend SDK — auth.signUp / auth.signIn. No auth is
// rebuilt here; owner-scoping/RLS is enforced DB-side. The shell just authenticates.
// Modes: signup · signin · forgot (send a password-reset email). When Supabase "Confirm email" is
// ON, signUp returns a user but NO session — we detect that and show the check-your-email notice
// (with confirmation OFF the session lands immediately and behavior is unchanged).
export default function AuthGate() {
  const [mode, setMode] = useState("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);

  function switchMode(next) {
    setMode(next); setErr(null); setNotice(null);
  }

  async function submit(e) {
    e.preventDefault();
    setErr(null); setNotice(null); setBusy(true);
    try {
      if (mode === "forgot") {
        const { error } = await client().auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (error) throw error;
        setNotice(`If an account exists for ${email}, a password-reset link is on its way. Open it in this browser to choose a new password.`);
      } else if (mode === "signup") {
        await backend().auth.signUp({ email, password });
        // With "Confirm email" ON there is no session yet — tell the user to activate the account.
        const { data } = await client().auth.getSession();
        if (!data?.session) {
          setNotice(`Almost there — we sent a confirmation link to ${email}. Click it to activate your account, then sign in.`);
          setMode("signin");
        }
        // With confirmation OFF the session exists; useSession's onAuthStateChange takes over.
      } else {
        await backend().auth.signIn({ email, password });
        // useSession's onAuthStateChange picks the session up.
      }
    } catch (e2) {
      const msg = e2.message || String(e2);
      // Supabase's "Email not confirmed" is the one sign-in error the user can self-fix.
      setErr(msg === "Email not confirmed"
        ? "Your email isn't confirmed yet — click the link in your confirmation email, then sign in."
        : msg);
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <div className="w-full max-w-sm panel p-7">
        <div className="flex items-center gap-2 mb-1">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-slate-100">Buildr101</span>
        </div>
        <p className="text-sm text-slate-400 mb-6">
          {mode === "forgot"
            ? "Enter your email and we'll send you a reset link."
            : "Describe an app. Watch it build. Keep iterating."}
        </p>

        {!backendConfigured && (
          <div className="mb-4 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber-soft">
            Supabase not configured — set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in shell/web/.env
          </div>
        )}

        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            {notice}
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          <input className="field" type="email" placeholder="you@example.com" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          {mode !== "forgot" && (
            <input className="field" type="password" placeholder="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"} required />
          )}
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button className="btn-primary w-full" disabled={busy || !backendConfigured}>
            {busy ? "…" : mode === "signup" ? "Create account" : mode === "signin" ? "Sign in" : "Send reset link"}
          </button>
        </form>

        <div className="mt-4 flex items-center justify-between text-xs">
          <button className="text-slate-400 hover:text-slate-200"
            onClick={() => switchMode(mode === "signup" ? "signin" : "signup")}>
            {mode === "signup" ? "Have an account? Sign in" : "New here? Create an account"}
          </button>
          {mode !== "forgot" && (
            <button className="text-slate-400 hover:text-slate-200" onClick={() => switchMode("forgot")}>
              Forgot password?
            </button>
          )}
          {mode === "forgot" && (
            <button className="text-slate-400 hover:text-slate-200" onClick={() => switchMode("signin")}>
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Logo({ className = "" }) {
  return (
    <span className={`inline-grid place-items-center h-7 w-7 rounded-md bg-amber text-ink-950 font-bold ${className}`}>◆</span>
  );
}
