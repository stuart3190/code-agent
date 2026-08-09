import { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { applicationRegistry } from "../apps/registry.js";
import { AppIcon } from "./AppIcon.jsx";

export function Launcher({ open, windows, actions }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const launcherRef = useRef(null);
  const matches = useMemo(() => applicationRegistry.filter((application) => `${application.title} ${application.description}`.toLowerCase().includes(query.toLowerCase())), [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => searchRef.current?.focus());
    const handleKey = (event) => {
      if (event.key === "Escape") actions.toggleLauncher(false);
    };
    const handlePointer = (event) => {
      if (!launcherRef.current?.contains(event.target) && !event.target.closest("[data-launcher-button]")) actions.toggleLauncher(false);
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("pointerdown", handlePointer);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("pointerdown", handlePointer);
    };
  }, [open, actions]);

  if (!open) return null;

  const handleGridKey = (event) => {
    const buttons = [...event.currentTarget.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    const columns = window.innerWidth < 768 ? 3 : 2;
    let next = index;
    if (event.key === "ArrowRight") next = Math.min(buttons.length - 1, index + 1);
    if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    if (event.key === "ArrowDown") next = Math.min(buttons.length - 1, index + columns);
    if (event.key === "ArrowUp") next = Math.max(0, index - columns);
    if (next !== index) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  };

  return (
    <section className="launcher" aria-label="Application launcher" data-launcher ref={launcherRef}>
      <header className="launcher-header">
        <div>
          <span className="eyebrow">Cloud applications</span>
          <h2>Open an app</h2>
        </div>
        <button className="icon-button" aria-label="Close launcher" onClick={() => actions.toggleLauncher(false)}><X /></button>
      </header>
      <label className="launcher-search">
        <MagnifyingGlass aria-hidden="true" />
        <span className="sr-only">Search applications</span>
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps" />
      </label>
      <div className="launcher-grid" onKeyDown={handleGridKey}>
        {matches.map((application) => {
          const state = windows[application.id];
          return (
            <button key={application.id} onClick={() => actions.open(application.id)} data-launch-app={application.id}>
              <span className={`launcher-app-icon app-tone-${application.id}`}><AppIcon name={application.icon} size={25} /></span>
              <span className="launcher-app-copy"><strong>{application.title}</strong><small>{application.description}</small></span>
              <span className="launcher-app-state">{state?.isOpen ? state.minimized ? `Minimized${application.recent ? " · Recent" : ""}` : `Running${application.recent ? " · Recent" : ""}` : `${application.pinned ? "Pinned" : "Available"}${application.recent ? " · Recent" : ""}`}</span>
            </button>
          );
        })}
        {!matches.length && <p className="launcher-empty">No applications match “{query}”.</p>}
      </div>
      <footer className="launcher-footer"><span>7 fixture apps</span><span>Offline-safe C1</span></footer>
    </section>
  );
}
