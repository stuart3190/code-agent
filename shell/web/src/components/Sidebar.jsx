import { Logo } from "../auth/AuthGate.jsx";

export default function Sidebar({ user, projects, currentId, onNew, onOpen, onHome, onSignOut }) {
  return (
    <aside className="h-full border-r border-line bg-ink-900/60 flex flex-col">
      <button onClick={onHome} className="flex items-center gap-2 px-4 h-14 border-b border-line hover:bg-ink-850">
        <Logo />
        <span className="font-semibold tracking-tight text-slate-100">Forge</span>
      </button>

      <div className="p-3">
        <button className="btn-primary w-full" onClick={onNew}>+ New app</button>
      </div>

      <div className="px-3 text-[11px] font-mono uppercase tracking-wider text-slate-500 mb-1">Projects</div>
      <nav className="flex-1 overflow-auto px-2 space-y-1">
        {projects.length === 0 && <div className="px-2 py-3 text-xs text-slate-500">Nothing yet.</div>}
        {projects.map((p) => (
          <button key={p.id} onClick={() => onOpen(p.id)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors ${
              p.id === currentId ? "bg-ink-800 text-slate-100 border border-line" : "text-slate-300 hover:bg-ink-850"}`}>
            <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${p.tree ? "bg-lime" : "bg-slate-600"}`} />
            {p.name}
          </button>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        <div className="text-xs text-slate-400 truncate mb-2" title={user.email}>{user.email}</div>
        <button className="btn-ghost w-full text-xs" onClick={onSignOut}>Sign out</button>
      </div>
    </aside>
  );
}
