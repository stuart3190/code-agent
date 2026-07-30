// Phase 21: the conversation-first production shell at `/`, built exactly from the
// approved /design wireframes (docs/DESIGN.md). Permanent UI is the four elements only:
// conversation, the living rail, preview, and the settings sheet. Everything else is a
// card in the thread or a palette entry. The console remains at /console during the
// transition.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../lib/useSession.js";
import Landing from "../landing/Landing.jsx";
import ResetPassword from "../auth/ResetPassword.jsx";
import { client } from "../lib/backend.js";
import {
  listConversations, startConversation, sendConversationMessage,
  streamConversationEvents, usageSummary,
} from "../lib/codeAgentApi.js";
import {
  applyEvent, emptyConversationView, replayEvents, railState,
  SPECIALIST_HUES, agentInitials, beginChips,
} from "./conversationState.js";
import { renderMarkdown } from "./markdown.js";
import "./chat.css";

const THEME_KEY = "thrallo-theme";

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "light");
  useEffect(() => {
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}

function firstName(user) {
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || "";
  return name.trim().split(/\s+/)[0] || "";
}

export default function ChatShell() {
  const { user, loading, recovery, clearRecovery } = useSession();
  if (recovery && user) return <ResetPassword onDone={clearRecovery} />;
  if (loading) return <div className="chat-root" />;
  if (!user) return <Landing />;
  return <Workspace user={user} />;
}

function Workspace({ user }) {
  const [theme, setTheme] = useTheme();
  const [conversations, setConversations] = useState([]);
  const [active, setActive] = useState(null);        // conversation row
  const [view, setView] = useState(emptyConversationView);
  const [pending, setPending] = useState(null);      // optimistic user text awaiting its event
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [toast, setToast] = useState("");
  const streamAbort = useRef(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    listConversations().then((r) => setConversations(r.conversations || [])).catch(() => {});
  }, []);

  // Live channel: replay history from seq 0, then keep streaming with `after` resume.
  const openConversation = useCallback((conversation) => {
    streamAbort.current?.abort();
    setActive(conversation);
    setView(emptyConversationView());
    setPending(null);
    setMobilePreview(false);
    const controller = new AbortController();
    streamAbort.current = controller;
    let after = 0;
    (async () => {
      while (!controller.signal.aborted) {
        try {
          after = await streamConversationEvents(conversation.id, (event) => {
            after = Math.max(after, Number(event.sequence || 0));
            if (event.payload?.role === "user") setPending(null);
            setView((v) => applyEvent(v, event));
          }, { signal: controller.signal, after });
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    })();
  }, []);
  useEffect(() => () => streamAbort.current?.abort(), []);

  const send = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      if (!active) {
        const r = await startConversation(trimmed);
        setConversations((list) => [r.conversation, ...list]);
        openConversation(r.conversation);
      } else {
        setPending(trimmed);
        await sendConversationMessage(active.id, trimmed);
      }
    } catch (error) {
      setPending(null);
      showToast(error.message || "That didn't send — try again.");
    }
  }, [active, openConversation, showToast]);

  // ⌘K / Ctrl+K opens the palette; Escape closes overlays.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
      if (e.key === "Escape") { setPaletteOpen(false); setSheetOpen(false); setMobilePreview(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rail = railState(view);
  const initial = (user.email || "?")[0].toUpperCase();
  const workingAgent = [...view.roster].reverse().find((r) => r.state === "working");

  return (
    <div className="chat-root">
      <header className="ct-topbar">
        <div className="ct-wordmark"><span className="ct-dot" />Thrallo</div>
        <div className={`ct-context ${active?.title ? "show" : ""}`}>
          <span className="ct-cdot" /><span>{active?.title || ""}</span>
        </div>
        <button className="ct-avatar" title="Settings" onClick={() => setSheetOpen(true)}>{initial}</button>
      </header>

      {active && view.roster.length > 0 && (
        <MobileStrip roster={view.roster} working={workingAgent} onPreview={() => view.previewUrl && setMobilePreview(true)} />
      )}

      {!active ? (
        <Begin user={user} conversations={conversations} onSend={send}
          onContinue={(id) => {
            const row = conversations.find((c) => c.id === id);
            if (row) openConversation(row);
          }} />
      ) : (
        <div className="ct-room">
          <div className="ct-thread-wrap">
            <Thread view={view} pending={pending} onOpenPreview={() => setMobilePreview(true)} />
            <Composer onSend={send} waiting={view.waiting} thinking={view.thinking} />
          </div>
          <aside className={`ct-rail ${rail === "empty" ? "" : rail}`}>
            <div className={`ct-teamcard ${rail === "preview" ? "strip" : ""}`}>
              <div className="ct-rail-label">Your team</div>
              <div className="ct-rows">
                {view.roster.map((r) => <AgentRow key={r.agent} row={r} compact={rail === "preview"} />)}
              </div>
            </div>
            {rail === "preview" && <PreviewPane url={view.previewUrl} onPublish={() => send("Publish this, please.")} />}
          </aside>
        </div>
      )}

      {view.previewUrl && (
        <div className={`ct-mobile-sheet ${mobilePreview ? "show" : ""}`}>
          <div className="ct-grab" onClick={() => setMobilePreview(false)} />
          <PreviewPane url={view.previewUrl} bare onPublish={() => { setMobilePreview(false); send("Publish this, please."); }} />
        </div>
      )}

      <div className={`ct-scrim ${sheetOpen || paletteOpen ? "show" : ""}`}
        onClick={() => { setSheetOpen(false); setPaletteOpen(false); }} />
      <SettingsSheet open={sheetOpen} user={user} theme={theme} setTheme={setTheme} onClose={() => setSheetOpen(false)} />
      {paletteOpen && (
        <Palette conversations={conversations}
          onNew={() => { setActive(null); setView(emptyConversationView()); setPaletteOpen(false); }}
          onOpen={(c) => { openConversation(c); setPaletteOpen(false); }}
          onSettings={() => { setPaletteOpen(false); setSheetOpen(true); }} />
      )}
      <div className={`ct-toast ${toast ? "show" : ""}`}>{toast}</div>
    </div>
  );
}

function Begin({ user, conversations, onSend, onContinue }) {
  const name = firstName(user);
  const chips = beginChips(conversations);
  const fresh = !conversations.length;
  return (
    <div className="ct-begin">
      <div className="ct-halo" />
      <div className="ct-hello">{fresh ? "Let's build something." : `Welcome back${name ? `, ${name}` : ""}.`}</div>
      <div className="ct-question">What are we building today?</div>
      <Composer autoFocus onSend={onSend} placeholder="Describe anything — an app, a change, an idea…" />
      <div className="ct-begin-chips">
        {chips.map((chip, i) => (
          <button key={chip.id} className={`ct-chip ${i === 0 ? "ct-chip-live" : ""}`} onClick={() => onContinue(chip.id)}>
            {i === 0 && <span className="ct-livedot" />}{chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Thread({ view, pending, onOpenPreview }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [view.items.length, pending, view.thinking]);
  let lastRole = null;
  return (
    <div className="ct-thread" ref={ref}>
      {view.items.map((item) => {
        const showWho = item.kind !== "message" ? false : item.role === "lead" && lastRole !== "lead";
        if (item.kind === "message") lastRole = item.role; else lastRole = null;
        return <ThreadItem key={item.seq} item={item} showWho={showWho} onOpenPreview={onOpenPreview} />;
      })}
      {pending && <div className="ct-msg user"><div className="ct-bubble">{pending}</div></div>}
      {view.thinking && (
        <div className="ct-msg lead"><div className="ct-bubble pending"><span className="ct-thinking">Thinking…</span></div></div>
      )}
    </div>
  );
}

function ThreadItem({ item, showWho, onOpenPreview }) {
  if (item.kind === "message") {
    if (item.role === "user") {
      return <div className="ct-msg user"><div className="ct-bubble">{item.text}</div></div>;
    }
    return (
      <div className="ct-msg lead">
        {showWho && <div className="ct-who">Lead Agent</div>}
        <div className="ct-bubble" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
      </div>
    );
  }
  if (item.kind === "plan") {
    return (
      <div className="ct-msg lead">
        <div className="ct-card">
          <div className="ct-kicker"><span className="ct-kdot" style={{ background: "var(--agent-planner)" }} />Plan · {item.title}</div>
          {item.steps.map((step, i) => (
            <div key={i} className="ct-plan-step"><span className="ct-tick" />{step}</div>
          ))}
        </div>
      </div>
    );
  }
  if (item.kind === "preview") {
    return (
      <div className="ct-msg lead">
        <div className="ct-card" style={{ padding: 14 }}>
          <div className="ct-kicker"><span className="ct-kdot" style={{ background: "var(--good)" }} />Preview ready</div>
          <div className="ct-preview-thumb" onClick={onOpenPreview}>
            <iframe src={item.url} title="Preview" loading="lazy" sandbox="allow-scripts allow-same-origin" tabIndex={-1} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <a className="ct-urlpill" href={item.url} target="_blank" rel="noreferrer noopener">
              <span className="ct-lock">●</span><span>{String(item.url).replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
            </a>
            <a className="ct-btn" style={{ textDecoration: "none" }} href={item.url} target="_blank" rel="noreferrer noopener">Open</a>
          </div>
        </div>
      </div>
    );
  }
  if (item.kind === "question") {
    return (
      <div className="ct-msg lead">
        <div className="ct-card">
          <div className="ct-kicker"><span className="ct-kdot" style={{ background: "var(--accent)" }} />Quick decision</div>
          {item.question}
          {item.consequence && <div className="ct-hint" style={{ marginTop: 8 }}>{item.consequence}</div>}
        </div>
      </div>
    );
  }
  if (item.kind === "receipt") {
    return <div className="ct-receipt"><span className="ct-rcheck">✓</span> {item.text}</div>;
  }
  if (item.kind === "error") {
    return <div className="ct-error">Something went wrong: {item.text} — say “try again” and I will.</div>;
  }
  return null;
}

function AgentRow({ row, compact }) {
  const hue = SPECIALIST_HUES[row.agent] || "var(--accent)";
  const lead = row.agent === "Lead Agent";
  const cls = row.state === "working" ? "working" : row.state === "failed" ? "done failed" : lead ? "done" : "done settled";
  return (
    <div className={`ct-agent ${cls}`} title={compact ? `${row.agent} — ${row.status}` : undefined}>
      <span className="ct-adot" style={{ background: hue, color: hue }}>
        <span style={{ color: "#fff" }}>{agentInitials(row.agent)}</span>
      </span>
      <span className="ct-ameta">
        <span className="ct-aname">{row.agent}{lead && <span className="ct-pin">ALWAYS HERE</span>}</span>
        <span className="ct-astatus">{row.status}</span>
      </span>
      <span className="ct-acheck">{row.state === "failed" ? "✕" : "✓"}</span>
    </div>
  );
}

function PreviewPane({ url, onPublish, bare = false }) {
  return (
    <div className="ct-pane" style={bare ? { border: 0, borderRadius: 0, boxShadow: "none", background: "transparent" } : undefined}>
      <div className="ct-pane-top">
        <a className="ct-urlpill" href={url} target="_blank" rel="noreferrer noopener">
          <span className="ct-lock">●</span><span>{String(url).replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
        </a>
        <button className="ct-btn" onClick={onPublish}>Publish</button>
      </div>
      <div className="ct-pane-frame">
        <iframe src={url} title="Live preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
      </div>
    </div>
  );
}

function MobileStrip({ roster, working, onPreview }) {
  return (
    <div className="ct-strip" style={{ marginTop: 62 }} onClick={onPreview}>
      {roster.slice(0, 5).map((r) => {
        const hue = SPECIALIST_HUES[r.agent] || "var(--accent)";
        return (
          <span key={r.agent} className="ct-adot" style={{ background: hue }}>
            <span style={{ color: "#fff" }}>{agentInitials(r.agent)}</span>
          </span>
        );
      })}
      <span className="ct-strip-status">
        {working ? `${working.agent} — ${working.status}` : "The team is with you."}
      </span>
    </div>
  );
}

function Composer({ onSend, autoFocus = false, placeholder = "Message your team…", waiting = false, thinking = false }) {
  const [text, setText] = useState("");
  const ref = useRef(null);
  const submit = () => { onSend(text); setText(""); if (ref.current) ref.current.style.height = "auto"; };
  const hint = waiting ? "The team is waiting on your answer above…" : thinking ? "The team is working — you can still talk…" : placeholder;
  return (
    <div className="ct-composer">
      <textarea
        ref={ref} rows={1} value={text} autoFocus={autoFocus} placeholder={hint}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 148)}px`;
        }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
      />
      <button className="ct-send" onClick={submit} disabled={!text.trim()} title="Send">↑</button>
    </div>
  );
}

function SettingsSheet({ open, user, theme, setTheme, onClose }) {
  const [usage, setUsage] = useState(null);
  useEffect(() => { if (open) usageSummary().then(setUsage).catch(() => setUsage(null)); }, [open]);
  const tokens = usage?.budgets?.managedTokens;
  const used = tokens ? Math.max(0, (tokens.limit ?? 0) - (tokens.remaining ?? 0)) : 0;
  const pct = tokens?.limit ? Math.min(100, Math.round((used / tokens.limit) * 100)) : 0;
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
  return (
    <aside className={`ct-sheet ${open ? "show" : ""}`}>
      <div className="ct-sheet-head"><h2>Settings</h2><button className="ct-btn-quiet" onClick={onClose}>Done</button></div>
      <div className="ct-sheet-body">
        <div className="ct-set-group">
          <div className="ct-set-label">Account</div>
          <div className="ct-set-row">
            <div>{user.email}<div className="ct-hint">{usage?.plan?.name || usage?.plan?.id || "Free"} plan</div></div>
            <button className="ct-btn-quiet" onClick={() => client().auth.signOut()}>Sign out</button>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">AI connection</div>
          <div className="ct-set-row">
            <div>Model access<div className="ct-hint">Managed, or bring your own key</div></div>
            <a className="ct-btn-quiet" href="/console" style={{ textDecoration: "none" }}>Manage</a>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">Plan &amp; budgets</div>
          <div className="ct-set-row">
            <div style={{ flex: 1 }}>
              Monthly budget
              {tokens ? (
                <>
                  <div className="ct-meter"><i style={{ width: `${pct}%` }} /></div>
                  <div className="ct-hint">{fmt(used)} of {fmt(tokens.limit)} tokens used</div>
                </>
              ) : <div className="ct-hint">Ask me “how much budget is left?” any time.</div>}
            </div>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">API tokens</div>
          <div className="ct-set-row">
            <div>CLI &amp; editor access<div className="ct-hint">Personal access tokens</div></div>
            <a className="ct-btn-quiet" href="/console" style={{ textDecoration: "none" }}>Manage</a>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">Appearance</div>
          <div className="ct-set-row">
            <div>Theme</div>
            <div className="ct-toggle">
              <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>Light</button>
              <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}>Dark</button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Palette({ conversations, onNew, onOpen, onSettings }) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (conversations || []).filter((c) => !q || (c.title || "").toLowerCase().includes(q)).slice(0, 6);
  }, [conversations, query]);
  return (
    <div className="ct-palette show">
      <input autoFocus placeholder="Type a command or search conversations…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="ct-pal-sect">Actions</div>
      <button className="ct-pal-row" onClick={onNew}>＋ New conversation<span className="ct-pal-hint">start fresh</span></button>
      <button className="ct-pal-row" onClick={onSettings}>⚙ Settings</button>
      <a className="ct-pal-row" href="/console" style={{ textDecoration: "none" }}>▤ Open Console<span className="ct-pal-hint">transition</span></a>
      {rows.length > 0 && <div className="ct-pal-sect">Conversations</div>}
      {rows.map((c) => (
        <button key={c.id} className="ct-pal-row" onClick={() => onOpen(c)}>{c.title || "Untitled"}</button>
      ))}
    </div>
  );
}
