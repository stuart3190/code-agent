import { useEffect, useState } from "react";
import { backend, backendConfigured, client } from "../lib/backend.js";

// The auth CARD — sign up / sign in / forgot on the EXISTING Phase 3 backend SDK
// (auth.signUp / auth.signIn). No auth is rebuilt here; owner-scoping/RLS is enforced DB-side.
// The card is embedded by the Landing page (the logged-out experience); `mode` is lifted so the
// landing nav's "Sign in" can drive it. When Supabase "Confirm email" is ON, signUp returns a
// user but NO session — we detect that and show the check-your-email notice (with confirmation
// OFF the session lands immediately and behavior is unchanged).
export function AuthCard({ mode, onMode }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);

  // A mode switch (from the tabs here OR the landing nav) clears stale errors/notices.
  useEffect(() => { setErr(null); setNotice(null); }, [mode]);

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
          onMode("signin");
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
    <div className="relative w-full max-w-sm rounded-2xl border border-line bg-ink-900/90 shadow-panel backdrop-blur px-7 pb-7 pt-6 overflow-hidden">
      {/* hairline accent along the top — the card is the page's single point of conversion */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-400/70 to-violet-400/70" />

      {mode === "signup" && (
        <span className="tag mb-4 bg-blue-400/10 text-blue-300">Developer preview · no card</span>
      )}
      <h2 className="text-lg font-semibold tracking-tight text-slate-100 font-display">
        {mode === "forgot" ? "Reset your password"
          : mode === "signup" ? "Create your free account" : "Welcome back"}
      </h2>
      <p className="mt-1 mb-5 text-xs text-slate-500">
        {mode === "forgot"
          ? "Enter your email and we'll send you a reset link."
          : mode === "signup" ? "Connect a repository and launch your first agent." : "Sign in to return to your coding agents."}
      </p>

      {!backendConfigured && (
        <div className="mb-4 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber-soft">
          Authentication setup required — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
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
          <input className="field" type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"} required />
        )}
        {err && <div className="text-xs text-red-400">{err}</div>}
        <button className="btn-primary w-full" disabled={busy || !backendConfigured}>
          {busy
            ? mode === "signup" ? "Creating account…" : mode === "signin" ? "Signing in…" : "Sending link…"
            : mode === "signup" ? "Create Thrallo account" : mode === "signin" ? "Sign in" : "Send reset link"}
        </button>
      </form>

      <div className="mt-4 flex items-center justify-between text-xs">
        <button className="text-slate-400 hover:text-slate-200"
          onClick={() => onMode(mode === "signup" ? "signin" : "signup")}>
          {mode === "signup" ? "Have an account? Sign in" : "New here? Create an account"}
        </button>
        {mode !== "forgot" ? (
          <button className="text-slate-400 hover:text-slate-200" onClick={() => onMode("forgot")}>
            Forgot password?
          </button>
        ) : (
          <button className="text-slate-400 hover:text-slate-200" onClick={() => onMode("signin")}>
            Back to sign in
          </button>
        )}
      </div>
    </div>
  );
}

// Standalone gate (self-managed mode) — kept as the default export so anything that renders
// <AuthGate /> directly still gets a working centered card. The real logged-out experience is
// the Landing page, which embeds <AuthCard /> itself.
export default function AuthGate() {
  const [mode, setMode] = useState("signup");
  return (
    <div className="min-h-full grid place-items-center p-6">
      <AuthCard mode={mode} onMode={setMode} />
    </div>
  );
}

// Thrallo mark: paired brackets around an active execution cursor.
export function Logo({ className = "" }) {
  return (
    <span className={`inline-grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-500 shadow-[0_0_20px_rgba(79,70,229,.25)] ${className}`}>
      <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
        <path d="M6.25 3.4 2.8 6.85l3.45 3.45M10.75 6.7l3.45 3.45-3.45 3.45" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="m9.65 3-2.3 11" stroke="white" strokeOpacity=".65" strokeWidth="1.25" strokeLinecap="round"/>
      </svg>
    </span>
  );
}
