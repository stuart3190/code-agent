import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./lib/useSession.js";
import { backend } from "./lib/backend.js";
import { getConfig, deleteProjectFull, serverBalance } from "./lib/api.js";
import { readBalance } from "./lib/ledger.js";
import { listProjects, createProject, getProject } from "./lib/projects.js";
import { Logo } from "./auth/AuthGate.jsx";
import Landing from "./landing/Landing.jsx";
import ResetPassword from "./auth/ResetPassword.jsx";
import TopBar from "./components/TopBar.jsx";
import Builder from "./builder/Builder.jsx";
import BillingPanel from "./billing/BillingPanel.jsx";
import SettingsPanel from "./settings/SettingsPanel.jsx";

export default function App() {
  const { user, loading, recovery, clearRecovery } = useSession();
  const [config, setConfig] = useState(null);
  const [balance, setBalance] = useState(null);
  const [projects, setProjects] = useState([]);
  const [current, setCurrent] = useState(null); // the open project, or null (dashboard)
  const [starter, setStarter] = useState(null); // a starter prompt to prefill the new project's builder
  const [view, setView] = useState("workspace"); // "workspace" (builder/dashboard) | "settings"
  const [rightOpen, setRightOpen] = useState(true); // BillingPanel (Credits / Plans …) — open on wide

  useEffect(() => { getConfig().then(setConfig).catch(() => {}); }, []);

  // Responsive auto-collapse so the build area never gets crushed by the billing rail. Acts only
  // when the width BUCKET changes, so it never fights a manual toggle within the same bucket.
  const bucketRef = useRef(null);
  useEffect(() => {
    // Collapse the billing rail by default below 1440px — the build area always wins;
    // the collapsed rail still shows the credit count and a one-click expand.
    const bucketOf = (w) => (w < 1440 ? "narrow" : "wide");
    const apply = () => {
      const b = bucketOf(window.innerWidth);
      if (b === bucketRef.current) return;
      bucketRef.current = b;
      if (b === "narrow") setRightOpen(false);
      // wide: force nothing — respect current state
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!user) return;
    try { setBalance(await readBalance(user.id)); } catch { /* empty ledger reads as 0 */ }
  }, [user]);

  const refreshProjects = useCallback(async () => {
    if (!user) return;
    try { setProjects(await listProjects()); } catch { setProjects([]); }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    // Server balance first: it materializes the one-time welcome grant for brand-new accounts,
    // so the very first thing a new user sees is their free credits, not a zero.
    serverBalance().catch(() => {}).finally(() => { refreshBalance(); });
    refreshProjects();
  }, [user, refreshBalance, refreshProjects]);

  if (loading) return <Splash label="…" />;
  // A password-reset email link lands here with a recovery session — force the new-password
  // screen before the normal app, even though the user is technically signed in.
  if (recovery && user) return <ResetPassword onDone={clearRecovery} />;
  if (!user) return <Landing />;

  async function newProject(starterPrompt) {
    const p = await createProject("Untitled app");
    await refreshProjects();
    setStarter(typeof starterPrompt === "string" ? starterPrompt : null);
    setCurrent(p); setView("workspace");
  }
  async function openProject(id) {
    const p = await getProject(id);
    setStarter(null);
    setCurrent(p); setView("workspace");
  }
  const goHome = () => { setCurrent(null); setView("workspace"); };

  async function removeProject(p) {
    const extras = p.publishedUrl ? " Its published site goes offline and its site name is released." : "";
    if (!window.confirm(`Delete “${p.name}” permanently?${extras} This can't be undone.`)) return;
    try {
      await deleteProjectFull(p.id);
      if (current?.id === p.id) goHome();
      await refreshProjects();
    } catch (e) {
      window.alert(e.message || String(e));
    }
  }

  const RAIL = "2.75rem"; // collapsed rail width (comfortable tap target)
  const cols = `minmax(0,1fr) ${rightOpen ? "19rem" : RAIL}`;

  return (
    <div className="h-full grid grid-rows-[3rem_minmax(0,1fr)]">
      <TopBar
        user={user}
        projects={projects}
        currentId={current?.id}
        view={view}
        onNew={newProject}
        onOpen={openProject}
        onHome={goHome}
        onSelectSettings={() => setView("settings")}
        onSignOut={async () => { await backend().auth.signOut(); goHome(); }}
      />

      <div className="min-h-0 grid" style={{ gridTemplateColumns: cols, transition: "grid-template-columns 200ms ease" }}>
        <main className="min-w-0 overflow-hidden">
          {view === "settings" ? (
            <SettingsPanel />
          ) : current ? (
            <Builder
              key={current.id}
              project={current}
              initialPrompt={starter}
              onProjectChange={(p) => { setCurrent(p); refreshProjects(); }}
              onAfterTurn={refreshBalance}
              balance={balance}
            />
          ) : (
            <Dashboard projects={projects} onNew={newProject} onOpen={openProject} onStart={(p) => newProject(p)} onDelete={removeProject} />
          )}
        </main>

        <BillingPanel config={config} balance={balance} onRefresh={refreshBalance} tier={balance?.tier}
          collapsed={!rightOpen} onToggle={() => setRightOpen((v) => !v)} />
      </div>
    </div>
  );
}

const STARTERS = [
  { label: "Barber shop site with booking", prompt: "a website for a local barber shop: hero, services with prices, opening hours, about the shop, and a booking request form (name, phone, preferred day and time, service)" },
  { label: "Subscription tracker", prompt: "a subscription and direct debit tracker: add recurring payments with a name, amount, currency and billing frequency; show the total normalized to a monthly cost; highlight payments due soon" },
  { label: "Team task board", prompt: "a kanban-style task board: columns for todo, in progress and done; add, edit and drag tasks between columns; assignee and due-date on each task" },
];

function Dashboard({ projects, onNew, onOpen, onStart, onDelete }) {
  return (
    <div className="h-full overflow-auto p-8">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Your apps</h1>
        <p className="text-sm text-slate-400 mt-1">Start from a description, then iterate. Everything you build is saved to your account.</p>
        <button className="btn-primary mt-5" onClick={() => onNew()}>+ New app</button>

        <div className="mt-8 grid gap-3">
          {projects.length === 0 && (
            <div className="panel p-6">
              <div className="text-sm text-slate-300">No apps yet — describe anything, or start from one of these:</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button key={s.label} onClick={() => onStart(s.prompt)}
                    className="rounded-full border border-line px-3 py-1.5 text-xs text-slate-300 hover:border-amber/60 hover:text-amber-soft transition-colors">
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {projects.map((p) => (
            <div key={p.id} role="button" tabIndex={0} onClick={() => onOpen(p.id)}
              onKeyDown={(e) => { if (e.key === "Enter") onOpen(p.id); }}
              className="panel p-4 text-left hover:border-amber/40 transition-colors cursor-pointer group">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-100 truncate">{p.name}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {p.publishedUrl && (
                    <a className="text-[11px] font-mono text-amber-soft hover:underline" href={p.publishedUrl}
                      target="_blank" rel="noreferrer" title={p.publishedUrl}
                      onClick={(e) => e.stopPropagation()}>live ↗</a>
                  )}
                  <span className="text-[11px] font-mono text-slate-500">{p.tree ? "built" : "empty"}</span>
                  <button className="px-1.5 py-0.5 rounded text-slate-600 hover:text-red-400 hover:bg-ink-850 transition-colors"
                    title="Delete project (permanent)" aria-label={`Delete ${p.name}`}
                    onClick={(e) => { e.stopPropagation(); onDelete(p); }}>✕</button>
                </div>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {(p.prompts?.length || 0)} turn{(p.prompts?.length || 0) === 1 ? "" : "s"} · updated {rel(p.updatedAt)}
              </div>
            </div>
          ))}
        </div>

        {/* the logged-in surface needs the public links too — logged-in users never see Landing */}
        <footer className="mt-12 pt-5 border-t border-line/60 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          <a className="hover:text-slate-400" href="/support" target="_blank" rel="noreferrer">Help &amp; support</a>
          <a className="hover:text-slate-400" href="/pricing" target="_blank" rel="noreferrer">Pricing</a>
          <a className="hover:text-slate-400" href="/terms" target="_blank" rel="noreferrer">Terms</a>
          <a className="hover:text-slate-400" href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
          <a className="hover:text-slate-400" href="mailto:support@buildr101.com">support@buildr101.com</a>
        </footer>
      </div>
    </div>
  );
}

function Splash({ label }) {
  return (
    <div className="min-h-full grid place-items-center">
      <div className="flex items-center gap-2 text-slate-400"><Logo /> {label}</div>
    </div>
  );
}

function rel(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
