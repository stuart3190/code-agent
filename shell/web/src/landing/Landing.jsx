import { useRef, useState } from "react";
import { AuthCard, Logo } from "../auth/AuthGate.jsx";

export default function Landing() {
  const [mode, setMode] = useState("signup");
  const authRef = useRef(null);
  const showAuth = (next) => {
    setMode(next);
    authRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <div className="min-h-full overflow-auto bg-[#07080b] text-slate-200">
      <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-[#07080b]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center px-6">
          <Logo /><span className="ml-2.5 font-display font-semibold text-white">Thrallo</span>
          <nav className="ml-auto flex items-center gap-2">
            <a href="#system" className="hidden px-3 py-2 text-sm text-slate-500 hover:text-white sm:block">Architecture</a>
            <button onClick={() => showAuth("signin")} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-slate-300 hover:bg-white/[0.05]">Sign in</button>
            <button onClick={() => showAuth("signup")} className="rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-black">Start building</button>
          </nav>
        </div>
      </header>
      <main>
        <section className="relative overflow-hidden border-b border-white/[0.06]">
          <div className="code-grid absolute inset-0 opacity-60" />
          <div className="pointer-events-none absolute left-[15%] top-0 h-[34rem] w-[34rem] rounded-full bg-blue-600/10 blur-[110px]" />
          <div className="pointer-events-none absolute right-[8%] top-[15%] h-[28rem] w-[28rem] rounded-full bg-violet-600/10 blur-[100px]" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-[1.05fr_.95fr] lg:py-28">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-400/20 bg-blue-400/[0.06] px-3 py-1 font-mono text-[10px] uppercase tracking-[.16em] text-blue-300">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-400" /> Cloud agents · desktop next
              </div>
              <h1 className="mt-7 max-w-3xl font-display text-5xl font-semibold leading-[.98] tracking-[-.05em] text-white sm:text-7xl">
                Software that builds<br /><span className="bg-gradient-to-r from-blue-400 via-indigo-300 to-violet-400 bg-clip-text text-transparent">alongside you.</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-400">Delegate real coding tasks to isolated cloud agents. They inspect your repository, edit code, run tests, and return a reviewable patch with a complete execution timeline.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <button onClick={() => showAuth("signup")} className="rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_40px_rgba(79,70,229,.25)]">Create an agent</button>
                <a href="#system" className="rounded-lg border border-white/10 px-5 py-2.5 text-sm text-slate-300 hover:bg-white/[0.04]">See how it works</a>
              </div>
              <div className="mt-8 flex gap-5 font-mono text-[10px] uppercase tracking-wide text-slate-600"><span>Isolated execution</span><span>Reviewable diffs</span><span>Provider-ready core</span></div>
            </div>
            <div ref={authRef} className="relative mx-auto w-full max-w-md lg:justify-self-end">
              <div className="absolute -inset-px rounded-2xl bg-gradient-to-br from-blue-500/30 via-transparent to-violet-500/30 blur-sm" />
              <AuthCard mode={mode} onMode={setMode} />
            </div>
          </div>
        </section>
        <section id="system" className="mx-auto max-w-7xl px-6 py-20">
          <div className="max-w-2xl"><div className="font-mono text-[10px] uppercase tracking-[.2em] text-violet-400">A complete execution path</div><h2 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">From issue to verified patch.</h2></div>
          <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.07] md:grid-cols-4">
            {[
              ["01", "Connect", "Link a GitHub repository through an owner-isolated control plane."],
              ["02", "Delegate", "Describe the outcome. The agent plans against the actual codebase."],
              ["03", "Execute", "Every command runs in a disposable Daytona workspace and dedicated branch."],
              ["04", "Review", "Follow ordered events, terminal output, validation, and the final diff."],
            ].map(([n, title, copy]) => <div key={n} className="bg-[#0b0d12] p-6"><span className="font-mono text-[10px] text-blue-400">{n}</span><h3 className="mt-10 text-base font-medium text-white">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{copy}</p></div>)}
          </div>
        </section>
      </main>
    </div>
  );
}
