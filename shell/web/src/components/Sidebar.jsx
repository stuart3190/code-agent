import { Logo } from "../auth/AuthGate.jsx";

export default function Sidebar({ user, projects, currentId, collapsed, onToggle, onNew, onOpen, onHome, onSignOut }) {
  if (collapsed) {
    return (
      <aside className="h-full border-r border-line bg-ink-900/60 flex flex-col items-center py-3 gap-3">
        <button onClick={onToggle} title="Expand projects panel" aria-label="Expand projects panel"
          className="p-2 rounded-lg border border-line text-slate-400 hover:text-slate-100 hover:bg-ink-850">
          <ChevronRight />
        </button>
        <button onClick={onHome} title="Home" aria-label="Home"
          className="p-1.5 rounded-lg hover:bg-ink-850"><Logo /></button>
        <button onClick={onNew} title="New app" aria-label="New app"
          className="h-8 w-8 grid place-items-center rounded-lg bg-amber text-ink-950 hover:bg-amber-soft text-lg font-bold leading-none">+</button>
      </aside>
    );
  }

  return (
    <aside className="h-full border-r border-line bg-ink-900/60 flex flex-col">
      <div className="flex items-center h-14 border-b border-line">
        <button onClick={onHome} className="flex flex-1 items-center gap-2 px-4 h-full hover:bg-ink-850 min-w-0">
          <Logo />
          <span className="font-semibold tracking-tight text-slate-100 truncate">Forge</span>
        </button>
        <button onClick={onToggle} title="Collapse panel" aria-label="Collapse projects panel"
          className="px-2 h-full text-slate-500 hover:text-slate-200 hover:bg-ink-850">
          <ChevronLeft />
        </button>
      </div>

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

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
