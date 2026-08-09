import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ClockCounterClockwise, DownloadSimple, House, LockSimple, Plus, X, ArrowClockwise } from "@phosphor-icons/react";
import { browserPages } from "../fixtures/data.js";

const startTab = (id = 1, url = "thrallo://home") => ({ id, history: [url], historyIndex: 0 });

export function BrowserApp({ onFixtureNotice }) {
  const [tabs, setTabs] = useState([startTab()]);
  const [activeTab, setActiveTab] = useState(1);
  const [panel, setPanel] = useState(null);
  const tab = tabs.find((entry) => entry.id === activeTab) ?? tabs[0];
  const url = tab.history[tab.historyIndex];
  const page = browserPages[url] ?? browserPages["thrallo://home"];

  const navigate = (nextUrl) => {
    if (!browserPages[nextUrl]) {
      onFixtureNotice("Navigation blocked", "The C1 Browser can only open bundled fixture pages. No internet request was made.");
      return;
    }
    setTabs((current) => current.map((entry) => entry.id === activeTab ? { ...entry, history: [...entry.history.slice(0, entry.historyIndex + 1), nextUrl], historyIndex: entry.historyIndex + 1 } : entry));
  };

  const moveHistory = (offset) => setTabs((current) => current.map((entry) => entry.id === activeTab ? { ...entry, historyIndex: Math.min(Math.max(0, entry.historyIndex + offset), entry.history.length - 1) } : entry));

  const addTab = () => {
    const id = Math.max(0, ...tabs.map((entry) => entry.id)) + 1;
    setTabs((current) => [...current, startTab(id)]);
    setActiveTab(id);
  };

  const closeTab = (tabId) => {
    if (tabs.length === 1) return;
    const index = tabs.findIndex((entry) => entry.id === tabId);
    const nextTabs = tabs.filter((entry) => entry.id !== tabId);
    setTabs(nextTabs);
    if (activeTab === tabId) setActiveTab(nextTabs[Math.max(0, index - 1)].id);
  };

  const recentHistory = useMemo(() => [...new Set(tabs.flatMap((entry) => entry.history))].map((entry) => browserPages[entry]), [tabs]);

  return (
    <div className="app-view browser-app" data-testid="browser-app">
      <div className="browser-tab-strip">
        <div className="browser-tabs" role="tablist" aria-label="Fixture browser tabs">
          {tabs.map((entry) => {
            const entryPage = browserPages[entry.history[entry.historyIndex]];
            return <button key={entry.id} role="tab" aria-selected={entry.id === activeTab} onClick={() => setActiveTab(entry.id)}><span>{entryPage.title}</span><X aria-label={`Close ${entryPage.title} tab`} onClick={(event) => { event.stopPropagation(); closeTab(entry.id); }} /></button>;
          })}
        </div>
        <button className="new-tab" aria-label="New fixture tab" onClick={addTab}><Plus /></button>
      </div>
      <div className="browser-toolbar">
        <button aria-label="Go back" disabled={tab.historyIndex === 0} onClick={() => moveHistory(-1)}><ArrowLeft /></button>
        <button aria-label="Go forward" disabled={tab.historyIndex === tab.history.length - 1} onClick={() => moveHistory(1)}><ArrowRight /></button>
        <button aria-label="Reload fixture page" onClick={() => onFixtureNotice("Page reloaded", `${page.title} was reloaded from bundled fixture data.`)}><ArrowClockwise /></button>
        <label className="browser-address"><LockSimple /><span className="sr-only">Fixture address</span><input aria-label="Fixture address" key={url} defaultValue={url} onKeyDown={(event) => { if (event.key === "Enter") navigate(event.currentTarget.value); }} /></label>
        <button aria-label="Browser history" aria-pressed={panel === "history"} onClick={() => setPanel(panel === "history" ? null : "history")}><ClockCounterClockwise /></button>
        <button aria-label="Fixture downloads" aria-pressed={panel === "downloads"} onClick={() => setPanel(panel === "downloads" ? null : "downloads")}><DownloadSimple /></button>
      </div>
      <div className="browser-page">
        <header><span className="fixture-chip"><LockSimple /> Bundled fixture page</span><button onClick={() => navigate("thrallo://home")}><House /> Home</button></header>
        <main>
          <span className="eyebrow">{page.eyebrow}</span>
          <h2>{page.heading}</h2>
          <p>{page.body}</p>
          <div className="browser-page-list">{page.rows.map((row) => <button key={row} onClick={() => navigate(row.includes("project") || row.includes("Customer") ? "thrallo://projects" : "thrallo://activity")}><span>{row}</span><ArrowRight /></button>)}</div>
        </main>
      </div>
      {panel && <aside className="browser-panel" aria-label={panel === "history" ? "Browser history" : "Fixture downloads"}>
        <header><strong>{panel === "history" ? "History" : "Downloads"}</strong><button aria-label="Close panel" onClick={() => setPanel(null)}><X /></button></header>
        {panel === "history" ? recentHistory.map((item) => <button key={item.title} onClick={() => navigate(Object.keys(browserPages).find((key) => browserPages[key] === item))}><ClockCounterClockwise /><span>{item.title}<small>Bundled page</small></span></button>) : <><div className="download-row"><DownloadSimple /><span>workspace-summary.pdf<small>Completed · fixture file</small></span></div><div className="download-row"><DownloadSimple /><span>brand-assets.zip<small>Completed · fixture file</small></span></div></>}
      </aside>}
    </div>
  );
}
