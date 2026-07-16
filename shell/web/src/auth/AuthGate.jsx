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
        // Ad conversion signal (Meta pixel, hostname-guarded in index.html) — the account now
        // exists whether or not email confirmation gates the session.
        window.fbq?.("track", "CompleteRegistration");
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
      <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber/70 to-transparent" />

      {mode === "signup" && (
        <span className="tag bg-amber/15 text-amber-soft mb-4">30 free credits · no card</span>
      )}
      <h2 className="text-lg font-semibold tracking-tight text-slate-100 font-display">
        {mode === "forgot" ? "Reset your password"
          : mode === "signup" ? "Create your free account" : "Welcome back"}
      </h2>
      <p className="mt-1 mb-5 text-xs text-slate-500">
        {mode === "forgot"
          ? "Enter your email and we'll send you a reset link."
          : mode === "signup" ? "Describe your first app right after this." : "Sign in to get back to your apps."}
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
          <input className="field" type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"} required />
        )}
        {err && <div className="text-xs text-red-400">{err}</div>}
        <button className="btn-primary w-full" disabled={busy || !backendConfigured}>
          {busy
            ? mode === "signup" ? "Creating account…" : mode === "signin" ? "Signing in…" : "Sending link…"
            : mode === "signup" ? "Start building free" : mode === "signin" ? "Sign in" : "Send reset link"}
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

// Brand mark: three stacked layers assembling upward — apps being built, floor by floor.
export function Logo({ className = "" }) {
  return (
    <span className={`inline-grid place-items-center h-7 w-7 rounded-md bg-amber ${className}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="10.5" width="12" height="3" rx="1.5" fill="#0a0c0f" />
        <rect x="2" y="6.5" width="9" height="3" rx="1.5" fill="#0a0c0f" fillOpacity="0.75" />
        <rect x="2" y="2.5" width="6" height="3" rx="1.5" fill="#0a0c0f" fillOpacity="0.5" />
      </svg>
    </span>
  );
}
