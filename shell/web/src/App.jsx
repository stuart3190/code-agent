import { useCallback, useEffect, useState } from "react";
import { useSession } from "./lib/useSession.js";
import { backend } from "./lib/backend.js";
import { getConfig } from "./lib/api.js";
import { readBalance } from "./lib/ledger.js";
import { listProjects, createProject, getProject } from "./lib/projects.js";
import AuthGate, { Logo } from "./auth/AuthGate.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Builder from "./builder/Builder.jsx";
import BillingPanel from "./billing/BillingPanel.jsx";

export default function App() {
  const { user, loading } = useSession();
  const [config, setConfig] = useState(null);
  const [balance, setBalance] = useState(null);
  const [projects, setProjects] = useState([]);
  const [current, setCurrent] = useState(null); // the open project, or null (dashboard)

  useEffect(() => { getConfig().then(setConfig).catch(() => {}); }, []);

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
  if (!user) return <AuthGate />;

  async function newProject() {
    const p = await createProject("Untitled app");
    await refreshProjects();
    setCurrent(p);
  }
  async function openProject(id) {
    const p = await getProject(id);
    setCurrent(p);
  }

  return (
    <div className="h-full grid grid-cols-[15rem_1fr_19rem]">
      <Sidebar
        user={user}
        projects={projects}
        currentId={current?.id}
        onNew={newProject}
        onOpen={openProject}
        onHome={() => setCurrent(null)}
        onSignOut={async () => { await backend().auth.signOut(); setCurrent(null); }}
      />

      <main className="min-w-0 overflow-hidden">
        {current ? (
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

      <BillingPanel config={config} balance={balance} onRefresh={refreshBalance} tier={balance?.tier} />
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
