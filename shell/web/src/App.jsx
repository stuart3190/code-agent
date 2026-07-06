import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./lib/useSession.js";
import { backend } from "./lib/backend.js";
import { getConfig } from "./lib/api.js";
import { readBalance } from "./lib/ledger.js";
import { listProjects, createProject, getProject } from "./lib/projects.js";
import AuthGate, { Logo } from "./auth/AuthGate.jsx";
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
  const [view, setView] = useState("workspace"); // "workspace" (builder/dashboard) | "settings"
  const [rightOpen, setRightOpen] = useState(true); // BillingPanel (Credits / Plans …) — open on wide

  useEffect(() => { getConfig().then(setConfig).catch(() => {}); }, []);

  // Responsive auto-collapse so the build area never gets crushed by the billing rail. Acts only
  // when the width BUCKET changes, so it never fights a manual toggle within the same bucket.
  const bucketRef = useRef(null);
  useEffect(() => {
    const bucketOf = (w) => (w < 1200 ? "narrow" : "wide");
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

  useEffect(() => { if (user) { refreshBalance(); refreshProjects(); } }, [user, refreshBalance, refreshProjects]);

  if (loading) return <Splash label="…" />;
  // A password-reset email link lands here with a recovery session — force the new-password
  // screen before the normal app, even though the user is technically signed in.
  if (recovery && user) return <ResetPassword onDone={clearRecovery} />;
  if (!user) return <AuthGate />;

  async function newProject() {
    const p = await createProject("Untitled app");
    await refreshProjects();
    setCurrent(p); setView("workspace");
  }
  async function openProject(id) {
    const p = await getProject(id);
    setCurrent(p); setView("workspace");
  }
  const goHome = () => { setCurrent(null); setView("workspace"); };

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
              onProjectChange={(p) => { setCurrent(p); refreshProjects(); }}
              onAfterTurn={refreshBalance}
              balance={balance}
            />
          ) : (
            <Dashboard projects={projects} onNew={newProject} onOpen={openProject} />
          )}
        </main>

        <BillingPanel config={config} balance={balance} onRefresh={refreshBalance} tier={balance?.tier}
          collapsed={!rightOpen} onToggle={() => setRightOpen((v) => !v)} />
      </div>
    </div>
  );
}

function Dashboard({ projects, onNew, onOpen }) {
  return (
    <div className="h-full overflow-auto p-8">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Your apps</h1>
        <p className="text-sm text-slate-400 mt-1">Start from a description, then iterate. Everything you build is saved to your account.</p>
        <button className="btn-primary mt-5" onClick={onNew}>+ New app</button>

        <div className="mt-8 grid gap-3">
          {projects.length === 0 && (
            <div className="panel p-6 text-sm text-slate-400">No apps yet — create one to begin.</div>
          )}
          {projects.map((p) => (
            <button key={p.id} onClick={() => onOpen(p.id)}
              className="panel p-4 text-left hover:border-amber/40 transition-colors">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-100">{p.name}</span>
                <span className="text-[11px] font-mono text-slate-500">{p.tree ? "built" : "empty"}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {(p.prompts?.length || 0)} turn{(p.prompts?.length || 0) === 1 ? "" : "s"} · updated {rel(p.updatedAt)}
              </div>
            </button>
          ))}
        </div>
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
