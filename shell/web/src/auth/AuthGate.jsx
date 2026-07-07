import { useState } from "react";
import { backend, backendConfigured, client } from "../lib/backend.js";
import showcase from "../assets/showcase-barber.png";

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
    <div className="min-h-full grid lg:grid-cols-2">
      {/* storefront — the product proof (hidden on small screens) */}
      <div className="hidden lg:flex flex-col justify-center px-14 xl:px-20 py-12 border-r border-line/60">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-slate-100 font-display">Buildr101</span>
        </div>
        <h1 className="mt-8 text-4xl xl:text-5xl font-semibold leading-[1.08] text-slate-100 max-w-xl">
          Describe an app.<br />Watch it build.
        </h1>
        <ul className="mt-6 space-y-2.5 text-sm text-slate-400 max-w-md">
          <li className="flex gap-2.5"><Check /> Working accounts and saved data, built in from the first version</li>
          <li className="flex gap-2.5"><Check /> Real design and real photography — nothing that looks generated</li>
          <li className="flex gap-2.5"><Check /> One click to publish on a live URL</li>
          <li className="flex gap-2.5"><Check /> 30 free build credits when you sign up — no card needed</li>
        </ul>
        {/* framed proof: an app Buildr101 built, as-is */}
        <div className="mt-10 max-w-xl rounded-xl border border-line overflow-hidden shadow-panel bg-ink-900">
          <div className="flex items-center gap-1.5 px-3 h-8 border-b border-line bg-ink-850">
            <span className="h-2.5 w-2.5 rounded-full bg-ink-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-ink-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-ink-700" />
            <span className="ml-2 text-[11px] font-mono text-slate-500 truncate">fadedistrict.app.buildr101.com</span>
          </div>
          <img src={showcase} alt="A barber shop website built by Buildr101 — hero, services and booking form"
            className="w-full h-72 object-cover object-top" />
        </div>
        <p className="mt-3 text-[11px] font-mono text-slate-600">Built from one sentence. Untouched.</p>
      </div>

      {/* auth card */}
      <div className="grid grid-rows-[1fr_auto] p-6">
      <div className="grid place-items-center">
      <div className="w-full max-w-sm panel p-7">
        <div className="flex items-center gap-2 mb-1 lg:hidden">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-slate-100 font-display">Buildr101</span>
        </div>
        <p className="text-sm text-slate-400 mb-6 lg:mt-0 lg:text-slate-300 lg:text-base lg:font-medium">
          {mode === "forgot"
            ? "Enter your email and we'll send you a reset link."
            : mode === "signup" ? "Create your account" : "Welcome back"}
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
              : mode === "signup" ? "Create account" : mode === "signin" ? "Sign in" : "Send reset link"}
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

      {/* public legal footer — Stripe + consumer law want these reachable pre-signup */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-6 text-[11px] text-slate-600">
        <a className="hover:text-slate-400" href="/pricing">Pricing</a>
        <a className="hover:text-slate-400" href="/terms">Terms</a>
        <a className="hover:text-slate-400" href="/privacy">Privacy</a>
        <a className="hover:text-slate-400" href="/refunds">Refunds</a>
        <a className="hover:text-slate-400" href="mailto:support@buildr101.com">support@buildr101.com</a>
      </div>
      </div>
    </div>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 mt-0.5">
      <path d="M20 6L9 17l-5-5" />
    </svg>
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
