import { useState } from "react";
import { Logo } from "../auth/AuthGate.jsx";

// Horizontal top menu bar. Holds what used to live in the left Sidebar: Home (logo), New app,
// the Projects list (now a dropdown), plus a Settings tab and the account/sign-out menu. Pure
// navigation/UI — it owns no build/billing state.
export default function TopBar({ user, projects, currentId, view, onNew, onOpen, onHome, onSelectSettings, onSignOut }) {
  const [menu, setMenu] = useState(null); // "projects" | "user" | null
  const close = () => setMenu(null);

  return (
    <header className="relative z-20 h-full flex items-center gap-2 px-3 border-b border-line bg-ink-900/60">
      {/* home / brand */}
      <button onClick={() => { close(); onHome(); }} title="Home"
        className="flex items-center gap-2 px-2 h-8 rounded-lg hover:bg-ink-850 min-w-0">
        <Logo />
        <span className="hidden sm:inline font-semibold tracking-tight text-slate-100">Buildr101</span>
      </button>

      <button className="btn-primary text-sm h-8 px-3" onClick={() => { close(); onNew(); }}>
        <span className="sm:hidden text-lg leading-none font-bold">+</span>
        <span className="hidden sm:inline">+ New app</span>
      </button>

      <div className="w-px h-5 bg-line mx-1" />

      {/* Projects dropdown */}
      <div className="relative">
        <button onClick={() => setMenu((m) => (m === "projects" ? null : "projects"))}
          className={`flex items-center gap-1 h-8 px-3 rounded-lg text-sm transition-colors ${
            menu === "projects" ? "bg-ink-800 text-slate-100" : "text-slate-300 hover:bg-ink-850"}`}>
          Projects <Caret />
        </button>
        {menu === "projects" && (
          <Menu onClose={close} className="w-64">
            {projects.length === 0 && <div className="px-3 py-3 text-xs text-slate-500">Nothing yet — “New app” to begin.</div>}
            {projects.map((p) => (
              <button key={p.id} onClick={() => { close(); onOpen(p.id); }}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors ${
                  p.id === currentId ? "bg-ink-800 text-slate-100" : "text-slate-300 hover:bg-ink-850"}`}>
                <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${p.tree ? "bg-amber" : "bg-slate-600"}`} />
                {p.name}
              </button>
            ))}
          </Menu>
        )}
      </div>

      {/* Settings tab — empty placeholder panel for now (BYOK key input lands here later) */}
      <button onClick={() => { close(); onSelectSettings(); }}
        className={`h-8 px-3 rounded-lg text-sm transition-colors ${
          view === "settings" ? "bg-ink-800 text-slate-100" : "text-slate-300 hover:bg-ink-850"}`}>
        Settings
      </button>

      {/* account menu (right) */}
      <div className="relative ml-auto">
        <button onClick={() => setMenu((m) => (m === "user" ? null : "user"))}
          className={`flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm max-w-[14rem] transition-colors ${
            menu === "user" ? "bg-ink-800 text-slate-100" : "text-slate-300 hover:bg-ink-850"}`}>
          <span className="truncate">{user.email}</span> <Caret />
        </button>
        {menu === "user" && (
          <Menu onClose={close} className="right-0 w-48">
            <div className="px-3 py-2 text-xs text-slate-500 truncate border-b border-line" title={user.email}>{user.email}</div>
            <a className="block px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-ink-850"
              href="/support" target="_blank" rel="noreferrer" onClick={close}>Help &amp; support</a>
            <button className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-ink-850"
              onClick={() => { close(); onSignOut(); }}>Sign out</button>
          </Menu>
        )}
      </div>
    </header>
  );
}

// Dropdown surface + a full-screen transparent backdrop that closes it on any outside click
// (no document listeners). Positioned under its trigger; pass `right-0` in className to right-align.
function Menu({ children, onClose, className = "" }) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden="true" />
      <div className={`absolute z-20 mt-1 p-1.5 rounded-xl border border-line bg-ink-900 shadow-panel max-h-[70vh] overflow-auto ${className}`}>
        {children}
      </div>
    </>
  );
}

function Caret() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
  );
}
