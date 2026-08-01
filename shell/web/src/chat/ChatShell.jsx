// The Thrallo application — conversation-first, built from the approved wireframes
// (docs/DESIGN.md). Permanent UI is the four elements only: conversation, the living
// rail, preview, and the settings sheet. Everything else is a card in the thread, a
// summonable view, or a palette entry.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../lib/useSession.js";
import Landing from "../landing/Landing.jsx";
import ResetPassword from "../auth/ResetPassword.jsx";
import { client } from "../lib/backend.js";
import {
  listConversations, startConversation, sendConversationMessage,
  streamConversationEvents, usageSummary, notificationsConfig, subscribeNotifications, deleteConversation,
  listDeletedConversations, restoreConversation, setPreviewPlan, incidentDetails,
} from "../lib/codeAgentApi.js";
import {
  applyEvent, emptyConversationView, replayEvents, railState,
  SPECIALIST_HUES, agentInitials, beginChips,
} from "./conversationState.js";
import { renderMarkdown } from "./markdown.js";
import ManageView, { MANAGE_VIEW_IDS } from "../manage/ManageView.jsx";
import ModelSelector, { MODEL_PREF_KEY, displayName as modelDisplayName } from "./ModelSelector.jsx";
import { setConversationModel, cancelBuild } from "../lib/codeAgentApi.js";
import RunOverlay from "../manage/RunOverlay.jsx";
import AiSettings from "../manage/AiSettings.jsx";
import TokensSettings from "../manage/TokensSettings.jsx";
import DownloadsSettings from "../manage/DownloadsSettings.jsx";
import "./chat.css";

const THEME_KEY = "thrallo-theme";
const THEME_OPTIONS = ["light", "dark", "system"];

function applyTheme(pref) {
  const dark = pref === "dark" ||
    (pref === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}

// Light is the default (Principle 6). The preference persists locally for instant boot
// (main.jsx applies it before React renders) and in the account's user_metadata so it
// follows the user across devices; "system" tracks the OS setting live.
function useTheme(user) {
  const [theme, setThemeState] = useState(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_OPTIONS.includes(stored) ? stored : "light";
  });
  useEffect(() => {
    if (!localStorage.getItem(THEME_KEY)) {
      const remote = user?.user_metadata?.thrallo_theme;
      if (THEME_OPTIONS.includes(remote)) setThemeState(remote);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.user_metadata?.thrallo_theme]);
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    if (theme !== "system" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
  const setTheme = useCallback((next) => {
    setThemeState(next);
    client().auth.updateUser({ data: { thrallo_theme: next } }).catch(() => {});
  }, []);
  return [theme, setTheme];
}

function firstName(user) {
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || "";
  return name.trim().split(/\s+/)[0] || "";
}

export default function ChatShell() {
  const { user, loading, recovery, clearRecovery } = useSession();
  if (recovery && user) return <ResetPassword onDone={clearRecovery} />;
  if (loading) {
    return (
      <div className="chat-root ct-boot" aria-label="Loading Thrallo" role="status">
        <span className="ct-dot ct-boot-dot" />
      </div>
    );
  }
  if (!user) return <Landing />;
  return <Workspace user={user} />;
}

// True on touch-primary devices — autofocusing there pops the keyboard over the content.
const FINE_POINTER = typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches;

function Workspace({ user }) {
  const [theme, setTheme] = useTheme(user);
  const [conversations, setConversations] = useState([]);
  const [convosLoaded, setConvosLoaded] = useState(false);
  const [active, setActive] = useState(null);        // conversation row
  const [view, setView] = useState(emptyConversationView);
  const [pending, setPending] = useState(null);      // optimistic user text awaiting its event
  const [wsContext, setWsContext] = useState(null);  // editor context from the desktop bridge
  const [wsContextOn, setWsContextOn] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [manageView, setManageView] = useState(null); // null | repos | usage | ops
  const [deleting, setDeleting] = useState(null);     // { project, busy, error, permanent } | null
  const [deletedItems, setDeletedItems] = useState([]); // Recently Deleted (7-day recovery)
  const [sheetSection, setSheetSection] = useState(null); // deep-link target inside Settings
  const [modelPref, setModelPref] = useState(() => localStorage.getItem(MODEL_PREF_KEY) || "auto");
  const [runOverlayId, setRunOverlayId] = useState(null);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [toast, setToast] = useState("");
  const scrollMemory = useRef(new Map()); // conversationId -> {top, atBottom}
  const streamAbort = useRef(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    listConversations()
      .then((r) => setConversations(r.conversations || []))
      .catch(() => {})
      .finally(() => setConvosLoaded(true));
    listDeletedConversations().then((r) => setDeletedItems(r.items || [])).catch(() => {});
  }, []);

  // The browser tab always names where you are.
  useEffect(() => {
    document.title = active?.title ? `${active.title} — Thrallo` : "Thrallo";
    return () => { document.title = "Thrallo"; };
  }, [active?.title]);

  // Desktop bridge (Phase 24 principle): the editor streams its active-file context here;
  // the chip in the composer keeps it transparent, and dismissal is respected until the
  // context itself changes.
  useEffect(() => {
    const onMessage = (event) => {
      if (event.data?.type !== "workspaceContext") return;
      setWsContext(event.data.context || null);
      setWsContextOn(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
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
            // The Lead Agent can summon visual views (open_view capability) — the UI
            // responds instantly; the reducer ignores this event type.
            if (event.type === "open_view" && MANAGE_VIEW_IDS.includes(event.payload?.view)) {
              setManageView(event.payload.view);
            }
            if (event.type === "open_view" && event.payload?.view === "run" && event.payload?.runId) {
              setRunOverlayId(event.payload.runId);
            }
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

  // Returns false on failure so the composer can restore the draft instead of losing it.
  const sendingRef = useRef(false);
  const send = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed || sendingRef.current) return true;
    const context = wsContextOn && wsContext ? wsContext : null;
    sendingRef.current = true;
    try {
      if (!active) {
        const r = await startConversation(trimmed, context, modelPref);
        setConversations((list) => [r.conversation, ...list]);
        openConversation(r.conversation);
      } else {
        setPending(trimmed);
        await sendConversationMessage(active.id, trimmed, context);
      }
      return true;
    } catch (error) {
      setPending(null);
      showToast(error.message || "That didn't send — your message is still in the box.");
      return false;
    } finally {
      sendingRef.current = false;
    }
  }, [active, openConversation, showToast, wsContext, wsContextOn, modelPref]);

  // Conversation-scoped model change: future requests only — no rebuild, no memory reset.
  const changeConversationModel = useCallback((value) => {
    if (!active) return;
    setConversationModel(active.id, value)
      .then((r) => {
        const stored = r.value || value;
        setActive((current) => (current ? { ...current, model_pref: stored, modelPref: stored } : current));
        setConversations((list) => list.map((c) => (c.id === active.id ? { ...c, modelPref: stored } : c)));
        localStorage.setItem(MODEL_PREF_KEY, stored);
        setModelPref(stored);
        showToast(`Future requests will use ${modelDisplayName(stored)}.`);
      })
      .catch((error) => showToast(error.message || "That model isn't available."));
  }, [active, showToast]);

  // ⌘K / Ctrl+K opens the palette; Escape closes whatever is on top.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
      if (e.key === "Escape") {
        setPaletteOpen(false); setSheetOpen(false); setMobilePreview(false); setManageView(null); setRunOverlayId(null);
        setDeleting((d) => (d?.busy ? d : null));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rail = railState(view);
  const initial = (user.email || "?")[0].toUpperCase();
  const workingAgent = [...view.roster].reverse().find((r) => r.state === "working");

  // Home never interrupts anything — builds run entirely server-side; the stream is simply
  // closed here and resumed (with `after`) when the conversation reopens.
  const goHome = useCallback(() => {
    streamAbort.current?.abort();
    setActive(null); setView(emptyConversationView()); setMobilePreview(false);
    listConversations().then((r) => setConversations(r.conversations || [])).catch(() => {});
  }, []);

  return (
    <div className="chat-root">
      <header className="ct-topbar">
        <div className="ct-topleft">
          <button className="ct-wordmark" title="Home — builds keep running" aria-label="Home — your projects"
            onClick={goHome}>
            <span className="ct-dot" />Thrallo
          </button>
          {active && (
            <button className="ct-back" onClick={goHome} aria-label="Back to your projects — the build keeps running">
              <span aria-hidden="true">←</span> Projects
            </button>
          )}
        </div>
        <div className={`ct-context ${active?.title ? "show" : ""}`}>
          <span className="ct-cdot" /><span>{active?.title || ""}</span>
        </div>
        <button className="ct-avatar" title="Settings" onClick={() => setSheetOpen(true)}>{initial}</button>
      </header>

      {active && view.roster.length > 0 && (
        <MobileStrip roster={view.roster} working={workingAgent} onPreview={() => view.previewUrl && setMobilePreview(true)} />
      )}

      {!active ? (
        <Begin user={user} conversations={conversations} loaded={convosLoaded} onSend={send}
          modelPref={modelPref}
          onModelChange={(v) => { setModelPref(v); localStorage.setItem(MODEL_PREF_KEY, v); }}
          onOpenSettings={() => { setSheetSection("ai"); setSheetOpen(true); }}
          onContinue={(id) => {
            const row = conversations.find((c) => c.id === id);
            if (row) openConversation(row);
          }}
          onDelete={(c) => setDeleting({ project: c, busy: false, error: "", permanent: false })}
          deletedItems={deletedItems}
          onRestore={(item) => restoreConversation(item.id)
            .then(() => {
              setDeletedItems((list) => list.filter((d) => d.id !== item.id));
              listConversations().then((r) => setConversations(r.conversations || [])).catch(() => {});
              showToast("Project restored.");
            })
            .catch((error) => showToast(error.message || "Restore failed — the project is still recoverable."))}
          onDeleteNow={(item) => setDeleting({
            project: { id: item.id, title: item.title }, busy: false, error: "", permanent: true,
          })} />
      ) : (
        <div className="ct-room">
          <div className="ct-thread-wrap">
            <Thread view={view} pending={pending} onOpenPreview={() => setMobilePreview(true)}
              onRetry={send} scrollKey={active.id} scrollMemory={scrollMemory} />
            <div className="ct-model-dock">
              <ModelSelector compact value={active.model_pref || active.modelPref || "auto"}
                onChange={changeConversationModel}
                onOpenSettings={() => { setSheetSection("ai"); setSheetOpen(true); }} />
            </div>
            <Composer onSend={send} waiting={view.waiting} thinking={view.thinking}
              context={wsContextOn ? wsContext : null} onDismissContext={() => setWsContextOn(false)} />
          </div>
          <aside className={`ct-rail ${rail === "empty" ? "" : rail}`}>
            <div className={`ct-teamcard ${rail === "preview" ? "strip" : ""}`}>
              <div className="ct-rail-label">Your team</div>
              {view.badge && (
                <div className={`ct-provider-badge ${view.badge.switched ? "switched" : ""}`} title="The model doing this work">
                  <span aria-hidden="true">{view.badge.icon}</span>{view.badge.text}
                </div>
              )}
              <div className="ct-rows">
                {view.roster.map((r) => <AgentRow key={r.agent} row={r} compact={rail === "preview"} />)}
              </div>
              <CancelBuild build={view.activeBuild} working={view.roster.some((r) => r.state === "working")} />
            </div>
            {rail === "preview" && <PreviewPane url={view.previewUrl} onPublish={() => send("Publish this, please.")} />}
          </aside>
        </div>
      )}

      {view.previewUrl && (
        <div className={`ct-mobile-sheet ${mobilePreview ? "show" : ""}`}>
          <button className="ct-grab-hit" aria-label="Close preview" onClick={() => setMobilePreview(false)}><span className="ct-grab" /></button>
          <PreviewPane url={view.previewUrl} bare onPublish={() => { setMobilePreview(false); send("Publish this, please."); }} />
        </div>
      )}

      <div className={`ct-scrim ${sheetOpen || paletteOpen || manageView || runOverlayId ? "show" : ""}`} aria-hidden="true"
        onClick={() => { setSheetOpen(false); setPaletteOpen(false); setManageView(null); setRunOverlayId(null); }} />
      <SettingsSheet open={sheetOpen} user={user} theme={theme} setTheme={setTheme} initialSection={sheetSection} onClose={() => { setSheetOpen(false); setSheetSection(null); }}
        onOpenView={(v) => { setSheetOpen(false); setManageView(v); }} />
      <ManageView view={manageView} onClose={() => setManageView(null)}
        onSentence={(text) => { setManageView(null); send(text); }}
        onOpenRun={(id) => setRunOverlayId(id)} />
      {runOverlayId && <RunOverlay runId={runOverlayId} onClose={() => setRunOverlayId(null)} />}
      {paletteOpen && (
        <Palette conversations={conversations}
          onNew={() => { setActive(null); setView(emptyConversationView()); setPaletteOpen(false); }}
          onOpen={(c) => { openConversation(c); setPaletteOpen(false); }}
          onSettings={() => { setPaletteOpen(false); setSheetOpen(true); }}
          onOpenView={(v) => { setPaletteOpen(false); setManageView(v); }} />
      )}
      {deleting && (
        <>
          <div className="ct-scrim show" onClick={() => !deleting.busy && setDeleting(null)} />
          <DeleteConfirm project={deleting.project} busy={deleting.busy} error={deleting.error}
            permanent={deleting.permanent}
            onCancel={() => setDeleting(null)}
            onConfirm={() => {
              const { permanent } = deleting;
              setDeleting((d) => ({ ...d, busy: true, error: "" }));
              deleteConversation(deleting.project.id, { permanent })
                .then((out) => {
                  if (permanent) {
                    setDeletedItems((list) => list.filter((d) => d.id !== deleting.project.id));
                    showToast("Project permanently deleted.");
                  } else {
                    setConversations((list) => list.filter((c) => c.id !== deleting.project.id));
                    setDeletedItems((list) => [{
                      id: deleting.project.id, title: deleting.project.title,
                      deletedAt: out.deletedAt, daysRemaining: 7,
                    }, ...list]);
                    showToast("Project moved to Recently Deleted.");
                  }
                  setDeleting(null);
                })
                .catch((error) => setDeleting((d) => ({ ...d, busy: false, error: error.message || "Deletion failed — the project is untouched." })));
            }} />
        </>
      )}
      <div className={`ct-toast ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

// Home is the workspace: what the team is doing right now, per project — switching away
// never interrupts anything, because builds run entirely server-side.
function projectState(c) {
  if (c.activity) return { label: c.activity.status || `${c.activity.agent} working…`, tone: "active", agent: c.activity.agent };
  if (c.state === "waiting_user") return { label: "Waiting for your input", tone: "waiting" };
  if (c.failed && !c.verified && !c.hasPreview) return { label: "Needs attention", tone: "failed" };
  if (c.verified) return { label: "Verified & complete", tone: "done" };
  if (c.hasPreview) return { label: "Preview live", tone: "done" };
  return { label: "Idle", tone: "idle" };
}

const RETURNING_KEY = "thrallo-returning";

function Begin({ user, conversations, loaded = true, onSend, onContinue, onDelete, deletedItems = [], onRestore, onDeleteNow, modelPref = "auto", onModelChange = null, onOpenSettings = null }) {
  const name = firstName(user);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busyId, setBusyId] = useState(null);
  useEffect(() => { if (!deletedItems.length) setShowDeleted(false); }, [deletedItems.length]);
  // Remember whether this account had projects so the greeting doesn't flash from
  // "Let's build something." to "Welcome back" while the list loads.
  const returning = loaded ? conversations.length > 0 : localStorage.getItem(RETURNING_KEY) === "1";
  useEffect(() => {
    if (loaded) localStorage.setItem(RETURNING_KEY, conversations.length ? "1" : "0");
  }, [loaded, conversations.length]);
  const fresh = !returning;
  const active = conversations.filter((c) => projectState(c).tone === "active" || projectState(c).tone === "waiting");
  const rest = conversations.filter((c) => !active.includes(c)).slice(0, 6);
  const act = (id, run) => { setBusyId(id); Promise.resolve(run()).finally(() => setBusyId(null)); };
  return (
    <div className="ct-begin" style={{ justifyContent: fresh ? "center" : "flex-start", overflowY: "auto" }}>
      <div className="ct-halo" />
      <div className="ct-hello" style={fresh ? undefined : { marginTop: 40 }}>{fresh ? "Let's build something." : `Welcome back${name ? `, ${name}` : ""}.`}</div>
      <div className="ct-question">What are we building today?</div>
      <Composer autoFocus={FINE_POINTER} onSend={onSend} placeholder="Describe anything — an app, a change, an idea…" />
      {onModelChange && (
        <div className="ct-model-begin">
          <ModelSelector value={modelPref} onChange={onModelChange} onOpenSettings={onOpenSettings} />
        </div>
      )}
      {!loaded && returning && (
        <div className="ct-workspace" aria-hidden="true">
          <div className="ct-ws-label">Projects</div>
          <div className="ct-project ct-skel"><span className="ct-skel-dot" /><span className="ct-skel-lines"><i style={{ width: "42%" }} /><i style={{ width: "63%" }} /></span></div>
          <div className="ct-project ct-skel"><span className="ct-skel-dot" /><span className="ct-skel-lines"><i style={{ width: "55%" }} /><i style={{ width: "38%" }} /></span></div>
        </div>
      )}
      {loaded && conversations.length > 0 && (
        <div className="ct-workspace">
          {active.length > 0 && <div className="ct-ws-label">In progress</div>}
          {active.map((c) => <ProjectCard key={c.id} c={c} onOpen={onContinue} onDelete={onDelete} />)}
          {rest.length > 0 && <div className="ct-ws-label">Projects</div>}
          {rest.map((c) => <ProjectCard key={c.id} c={c} onOpen={onContinue} onDelete={onDelete} />)}
        </div>
      )}
      {deletedItems.length > 0 && (
        <div className="ct-workspace" style={{ marginTop: conversations.length ? 6 : 28 }}>
          <button className="ct-recent-toggle" aria-expanded={showDeleted} onClick={() => setShowDeleted((v) => !v)}>
            Recently Deleted ({deletedItems.length})
          </button>
          {showDeleted && deletedItems.map((item) => (
            <div className="ct-project ct-recent" key={item.id}>
              <span className="ct-pmeta">
                <span className="ct-pname">{item.title || "Untitled project"}</span>
                <span className="ct-pactivity">
                  Deleted {new Date(item.deletedAt).toLocaleDateString()} · {item.daysRemaining === 0
                    ? "permanent deletion soon"
                    : `${item.daysRemaining} day${item.daysRemaining === 1 ? "" : "s"} left`}
                </span>
              </span>
              <button className="ct-btn-quiet ct-recent-btn" disabled={busyId === item.id}
                onClick={() => act(item.id, () => onRestore(item))}>
                {busyId === item.id ? "Restoring…" : "Restore"}
              </button>
              <button className="ct-btn-quiet ct-recent-btn ct-recent-danger" disabled={busyId === item.id}
                onClick={() => onDeleteNow(item)}>Delete now</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ c, onOpen, onDelete }) {
  const s = projectState(c);
  return (
    <div className="ct-project" role="button" tabIndex={0} onClick={() => onOpen(c.id)}
      aria-label={`Open ${c.title || "untitled project"} — ${s.label}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c.id); } }}>
      <span className={`ct-pstate ct-pstate-${s.tone}`} />
      <span className="ct-pmeta">
        <span className="ct-pname">{c.title || "Untitled project"}</span>
        <span className="ct-pactivity">{s.agent ? `${s.agent} · ` : ""}{s.label}</span>
      </span>
      <span className="ct-popen">Open</span>
      <button className="ct-pdelete" title="Delete project" aria-label={`Delete ${c.title || "project"}`}
        onClick={(e) => { e.stopPropagation(); onDelete(c); }}>×</button>
    </div>
  );
}

// Confirmation before deletion. Default deletes into Recently Deleted (7-day recovery);
// permanent (Delete Now) runs the irreversible cascade.
function DeleteConfirm({ project, busy, error, permanent = false, onCancel, onConfirm }) {
  // Focus lands on the safe action; Escape (handled globally) and the scrim both cancel.
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div className="ct-palette show" role="dialog" aria-modal="true" aria-label="Delete this project?" style={{ padding: "22px 22px 18px" }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0 }}>
        {permanent ? "Delete this project forever?" : "Delete this project?"}
      </h3>
      <p className="ct-hint" style={{ margin: "10px 0 4px", fontSize: 14 }}>
        {permanent ? (
          <>This will permanently delete <b>{project.title || "this project"}</b> and all data
          associated with it, right now. This action cannot be undone.</>
        ) : (
          <><b>{project.title || "This project"}</b> will move to Recently Deleted. You can restore
          it within 7 days; after that it will be permanently deleted.</>
        )}
      </p>
      {error && <div className="mg-error">{error}</div>}
      <div className="ct-actions" style={{ justifyContent: "flex-end" }}>
        <button className="ct-btn-quiet" ref={cancelRef} disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="ct-btn" style={{ background: "var(--bad)" }} disabled={busy} onClick={onConfirm}>
          {busy ? "Deleting…" : permanent ? "Delete permanently" : "Delete"}
        </button>
      </div>
    </div>
  );
}

// Subtle, honest recovery states — informative without alarming or exposing internals.
const RECOVERY_LABEL = {
  recovering: "Recovering…",
  repairing: "Repairing…",
  verifying: "Verifying…",
  continuing: "Continuing…",
};

function Thread({ view, pending, onOpenPreview, onRetry = null, scrollKey = null, scrollMemory = null }) {
  const ref = useRef(null);
  const atBottom = useRef(true);   // follow the stream only while the user is at the bottom
  const restored = useRef(false);
  useEffect(() => {
    restored.current = false;
    const saved = scrollMemory?.current.get(scrollKey);
    atBottom.current = !(saved && !saved.atBottom);
  }, [scrollKey, scrollMemory]);
  // Leaving the conversation remembers where the reader was (goHome unmounts the thread).
  useEffect(() => () => {
    if (scrollMemory && scrollKey && ref.current) {
      scrollMemory.current.set(scrollKey, { top: ref.current.scrollTop, atBottom: atBottom.current });
    }
  }, [scrollKey, scrollMemory]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const saved = scrollMemory?.current.get(scrollKey);
    if (!restored.current && saved && !saved.atBottom) {
      if (el.scrollHeight >= saved.top + el.clientHeight) {
        el.scrollTop = saved.top;
        restored.current = true;
      }
      return; // replaying history — don't yank a returning reader to the bottom
    }
    if (atBottom.current) el.scrollTo({ top: el.scrollHeight });
  }, [view.items.length, pending, view.thinking, scrollKey, scrollMemory]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  let lastRole = null;
  // History is still replaying — show conversation-shaped placeholders, not a blank room.
  if (!view.items.length && !pending && !view.thinking) {
    return (
      <div className="ct-thread" ref={ref} aria-label="Conversation" aria-busy="true">
        <div className="ct-msg user" aria-hidden="true"><div className="ct-bubble ct-skel-bubble" style={{ width: "46%" }} /></div>
        <div className="ct-msg lead" aria-hidden="true"><div className="ct-bubble ct-skel-bubble" style={{ width: "72%" }} /></div>
      </div>
    );
  }
  return (
    <div className="ct-thread" ref={ref} aria-label="Conversation" onScroll={onScroll}>
      {view.items.map((item) => {
        const showWho = item.kind !== "message" ? false : item.role === "lead" && lastRole !== "lead";
        if (item.kind === "message") lastRole = item.role; else lastRole = null;
        return <ThreadItem key={item.seq} item={item} showWho={showWho} onOpenPreview={onOpenPreview} onRetry={onRetry}
          live={view.thinking || view.roster.some((r) => r.state === "working")} waiting={view.waiting} />;
      })}
      {pending && <div className="ct-msg user"><div className="ct-bubble">{pending}</div></div>}
      {view.recovery && (
        <div className="ct-msg lead">
          <div className="ct-recovery" role="status">
            <span className="ct-recovery-dot" />
            <span className="ct-thinking">{RECOVERY_LABEL[view.recovery.state] || "Recovering…"}</span>
          </div>
        </div>
      )}
      {view.thinking && !view.recovery && (
        <div className="ct-msg lead"><div className="ct-bubble pending"><span className="ct-thinking">Thinking…</span></div></div>
      )}
    </div>
  );
}

function ThreadItem({ item, showWho, onOpenPreview, onRetry = null, live = false, waiting = false }) {
  if (item.kind === "message") {
    if (item.role === "user") {
      return (
        <div className="ct-msg user">
          <div className="ct-bubble">{item.text}</div>
          {item.workspaceContext?.file && (
            <div className="ct-context-shared">⌁ shared {item.workspaceContext.file}
              {item.workspaceContext.hasSelection ? " · selection" : ""}
              {item.workspaceContext.diagnostics ? ` · ${item.workspaceContext.diagnostics} problems` : ""}</div>
          )}
        </div>
      );
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
          <div className="ct-kicker">
            <span className={`ct-kdot ${live ? "ct-pulse" : ""}`}
              style={{ background: waiting ? "var(--warn)" : live ? "var(--good)" : "var(--agent-planner)" }} />
            Plan · {item.title}
          </div>
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
            <a className="ct-urlpill" href={item.url} title={item.url} target="_blank" rel="noreferrer noopener">
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
  if (item.kind === "published") {
    return (
      <div className="ct-receipt">
        <span className="ct-rcheck">✓</span> {item.text}
        {item.url && <a href={item.url} target="_blank" rel="noreferrer noopener" style={{ color: "var(--accent)", textDecoration: "none" }}>Open ↗</a>}
      </div>
    );
  }
  if (item.kind === "error") {
    return <div className="ct-error">Something went wrong: {item.text} — say “try again” and I will.</div>;
  }
  if (item.kind === "failure") {
    return <FailureCard item={item} onRetry={onRetry} />;
  }
  return null;
}

// Failed recovery: calm sentence, support reference, and actions. Technical detail lives
// behind an advanced disclosure and is fetched owner-scoped from the server.
function FailureCard({ item, onRetry }) {
  const [details, setDetails] = useState(null);
  const [open, setOpen] = useState(false);
  const reveal = () => {
    setOpen((v) => !v);
    if (!details && item.reference) {
      incidentDetails(item.reference)
        .then((r) => setDetails(r.incident))
        .catch(() => setDetails({ unavailable: true }));
    }
  };
  return (
    <div className="ct-msg lead">
      <div className="ct-card ct-failure">
        <div className="ct-kicker"><span className="ct-kdot" style={{ background: "var(--warn)" }} />Needs a hand</div>
        <div style={{ whiteSpace: "pre-wrap" }}>{item.text}</div>
        <div className="ct-actions">
          {onRetry && <button className="ct-btn" onClick={() => onRetry("Please try that again.")}>Retry</button>}
          <a className="ct-btn-quiet" style={{ textDecoration: "none", border: "1px solid var(--line)" }}
            href={`mailto:support@thrallo.com?subject=${encodeURIComponent(`Thrallo support ${item.reference || ""}`)}`}>
            Contact support
          </a>
          {item.reference && (
            <button className="ct-btn-quiet" onClick={reveal} aria-expanded={open}>
              {open ? "Hide technical details" : "View technical details"}
            </button>
          )}
        </div>
        {open && (
          <div className="ct-failure-tech">
            {!details && <div className="ct-hint">Loading…</div>}
            {details?.unavailable && <div className="ct-hint">Those details are no longer available.</div>}
            {details && !details.unavailable && (
              <>
                <div className="ct-hint">{details.service} · {details.code} · {new Date(details.createdAt).toLocaleString()} · {details.retryCount} automatic {details.retryCount === 1 ? "retry" : "retries"}</div>
                <pre className="mg-mono">{details.message}{details.stack ? `\n\n${details.stack}` : ""}</pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Stop a running build. Contextual by design (Principle 3): it exists only while the team is
// actually working, and disappears the moment they finish — never permanent chrome.
//
// This is the user-facing half of the cancellation pipeline. The classification work that makes
// a cancelled build stop cleanly (no repair, no retry, no further spend) shipped in #119, but
// its HTTP route had been unmounted since #53, so until now there was no way to trigger it.
function CancelBuild({ build, working }) {
  const [state, setState] = useState("idle"); // idle | cancelling | done
  useEffect(() => { setState("idle"); }, [build?.jobId]);
  if (!build?.jobId || !working || state === "done") return null;

  const stop = async () => {
    setState("cancelling");
    try {
      await cancelBuild(build.jobId);
    } catch {
      // A build that completed a moment before the click reports "already finished". That is a
      // normal race, not a failure: the work the user wanted stopped is already stopped, so we
      // simply retire the control rather than showing them an error.
    }
    setState("done");
  };

  return (
    <button className="ct-btn-quiet ct-cancel-build" data-testid="cancel-build"
      disabled={state === "cancelling"} onClick={stop}
      title="Stop this build. Your current progress is saved.">
      {state === "cancelling" ? "Stopping…" : "Stop build"}
    </button>
  );
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
        <a className="ct-urlpill" href={url} title={url} target="_blank" rel="noreferrer noopener">
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

function contextChipLabel(context) {
  const bits = [context.file];
  if (context.selection) bits.push("selection");
  if (context.diagnostics?.length) bits.push(`${context.diagnostics.length} problem${context.diagnostics.length > 1 ? "s" : ""}`);
  return bits.filter(Boolean).join(" · ");
}

function Composer({ onSend, autoFocus = false, placeholder = "Message your team…", waiting = false, thinking = false, context = null, onDismissContext = null }) {
  const [text, setText] = useState("");
  const ref = useRef(null);
  // Clear immediately (feels instant); if sending fails, put the draft back untouched.
  const submit = async () => {
    const draft = text;
    if (!draft.trim()) return;
    setText("");
    if (ref.current) ref.current.style.height = "auto";
    const ok = await onSend(draft);
    if (ok === false) {
      setText((current) => current || draft);
      ref.current?.focus();
    }
  };
  const hint = waiting ? "The team is waiting on your answer above…" : thinking ? "The team is working — you can still talk…" : placeholder;
  return (
    <div className="ct-composer" style={context ? { flexWrap: "wrap" } : undefined}>
      {context && (
        <div className="ct-context-chip" title="Shared with your next message — the team sees exactly this">
          <span className="ct-context-glyph">⌁</span>
          <span className="ct-context-label">{contextChipLabel(context)}</span>
          {onDismissContext && <button onClick={onDismissContext} title="Don't share editor context" aria-label="Don't share editor context">×</button>}
        </div>
      )}
      <textarea
        ref={ref} rows={1} value={text} autoFocus={autoFocus} placeholder={hint} aria-label="Message your team"
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 148)}px`;
        }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
      />
      <button className="ct-send" onClick={submit} disabled={!text.trim()} title="Send" aria-label="Send message">↑</button>
    </div>
  );
}

// The ONE settings experience: quick rows, with drill-in sections for the plumbing that
// is technically required to live here (secrets never enter the conversation).
function SettingsSheet({ open, user, theme, setTheme, onClose, onOpenView, initialSection = null }) {
  const [usage, setUsage] = useState(null);
  const [section, setSection] = useState(null); // null | ai | tokens | downloads
  useEffect(() => { if (open) usageSummary().then(setUsage).catch(() => setUsage(null)); }, [open]);
  // Opening with a section (e.g. "Configure xAI" in the model selector) lands the user
  // directly on that screen — arriving at the settings root with no mention of the
  // provider they asked to configure reads as "the provider disappeared".
  useEffect(() => { setSection(open ? initialSection : null); }, [open, initialSection]);

  if (section) {
    const Section = section === "ai" ? AiSettings : section === "tokens" ? TokensSettings : DownloadsSettings;
    return (
      <aside className={`ct-sheet ${open ? "show" : ""}`}>
        <div className="ct-sheet-head">
          <button className="ct-btn-quiet" onClick={() => setSection(null)}>← Settings</button>
          <button className="ct-btn-quiet" onClick={onClose}>Done</button>
        </div>
        <div className="ct-sheet-body"><Section /></div>
      </aside>
    );
  }
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
            <div>
              {user.email}
              <div className="ct-hint">
                {usage?.ownerAccount ? "Owner — limits are never enforced" : `${usage?.plan?.name || usage?.plan?.id || "Free"} plan`}
              </div>
            </div>
            {!user.desktop && <button className="ct-btn-quiet" onClick={() => client().auth.signOut()}>Sign out</button>}
          </div>
          {usage?.ownerAccount && (
            <div className="ct-set-row">
              <div>View as<div className="ct-hint">Experience the product on a customer plan — usage still records, nothing blocks you.</div></div>
              <div className="ct-toggle" role="group" aria-label="View as plan">
                {[["actual", "Owner"], ["free", "Free"], ["starter", "Starter"], ["pro", "Pro"]].map(([id, label]) => (
                  <button key={id}
                    className={(usage.previewPlan || "actual") === id ? "on" : ""}
                    aria-pressed={(usage.previewPlan || "actual") === id}
                    onClick={() => setPreviewPlan(id === "actual" ? null : id)
                      .then(() => usageSummary().then(setUsage))
                      .catch(() => {})}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">AI connection</div>
          <div className="ct-set-row">
            <div>Model access<div className="ct-hint">Managed, your own key, or ChatGPT Codex</div></div>
            <button className="ct-btn-quiet" onClick={() => setSection("ai")}>Manage</button>
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
            <button className="ct-btn-quiet" onClick={() => onOpenView("usage")}>Details</button>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">API tokens</div>
          <div className="ct-set-row">
            <div>CLI, editor &amp; desktop access<div className="ct-hint">Personal access tokens</div></div>
            <button className="ct-btn-quiet" onClick={() => setSection("tokens")}>Manage</button>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">Build diagnostics</div>
          <div className="ct-set-row">
            <div>Complete build audit trail<div className="ct-hint">Every prompt, log, repair and cost — kept even when builds fail</div></div>
            <button className="ct-btn-quiet" onClick={() => onOpenView("diagnostics")}>Open</button>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">Repositories</div>
          <div className="ct-set-row">
            <div>Connected code<div className="ct-hint">GitHub App, indexing, policies, pull requests</div></div>
            <button className="ct-btn-quiet" onClick={() => onOpenView("repos")}>Open</button>
          </div>
        </div>
        <div className="ct-set-group">
          <div className="ct-set-label">Downloads</div>
          <div className="ct-set-row">
            <div>Editor, CLI &amp; desktop<div className="ct-hint">Bring Thrallo where you work</div></div>
            <button className="ct-btn-quiet" onClick={() => setSection("downloads")}>Open</button>
          </div>
        </div>
        <NotificationSettings />
        <div className="ct-set-group">
          <div className="ct-set-label">Appearance</div>
          <div className="ct-set-row">
            <div>Theme</div>
            <div className="ct-toggle" role="group" aria-label="Theme">
              <button className={theme === "light" ? "on" : ""} aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light</button>
              <button className={theme === "dark" ? "on" : ""} aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark</button>
              <button className={theme === "system" ? "on" : ""} aria-pressed={theme === "system"} onClick={() => setTheme("system")}>System</button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// Browser notifications need a user gesture + permission prompt, so this one row lives in
// the sheet (like credentials). Everything about WHEN to notify stays conversational —
// Thrallo only speaks up when the user is away and something needs them.
function NotificationSettings() {
  const supported = "serviceWorker" in navigator && "PushManager" in window;
  const [state, setState] = useState("idle"); // idle | on | busy | unavailable
  useEffect(() => {
    if (!supported) { setState("unavailable"); return; }
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) setState("on");
    }).catch(() => {});
  }, [supported]);

  const enable = async () => {
    setState("busy");
    try {
      const config = await notificationsConfig();
      if (!config.vapidPublicKey) { setState("unavailable"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState("idle"); return; }
      const raw = atob(config.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/"));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await subscribeNotifications(subscription.toJSON());
      setState("on");
    } catch {
      setState("idle");
    }
  };

  return (
    <div className="ct-set-group">
      <div className="ct-set-label">Notifications</div>
      <div className="ct-set-row">
        <div>When you're away<div className="ct-hint">
          {state === "on" ? "I'll let you know when something needs you." :
            state === "unavailable" ? "Not available in this browser yet." :
            "Previews ready, questions, and finished work."}
        </div></div>
        {state === "on"
          ? <span className="ct-hint" style={{ color: "var(--good)", fontWeight: 700 }}>On</span>
          : <button className="ct-btn-quiet" disabled={state !== "idle"} onClick={enable}>
              {state === "busy" ? "Enabling…" : "Enable"}
            </button>}
      </div>
    </div>
  );
}

function Palette({ conversations, onNew, onOpen, onSettings, onOpenView }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const actions = useMemo(() => [
    { key: "new", label: "＋ New conversation", hint: "start fresh", run: onNew },
    { key: "settings", label: "⚙ Settings", run: onSettings },
    { key: "repos", label: "⌘ Repositories", hint: "connect · index · policies · PRs", run: () => onOpenView("repos") },
    { key: "usage", label: "▤ Usage & plan", hint: "budgets · guards", run: () => onOpenView("usage") },
    { key: "diagnostics", label: "◔ Build diagnostics", hint: "logs · repairs · costs", run: () => onOpenView("diagnostics") },
    { key: "ops", label: "⚡ Operations", hint: "admin", run: () => onOpenView("ops") },
    { key: "analytics", label: "◈ Admin analytics", hint: "admin · spend · revenue", run: () => onOpenView("analytics") },
    { key: "intelligence", label: "◎ Provider intelligence", hint: "admin · learned routing", run: () => onOpenView("intelligence") },
  ], [onNew, onSettings, onOpenView]);
  const q = query.trim().toLowerCase();
  const shownActions = useMemo(
    () => actions.filter((a) => !q || a.label.toLowerCase().includes(q) || (a.hint || "").includes(q)),
    [actions, q],
  );
  const rows = useMemo(
    () => (conversations || []).filter((c) => !q || (c.title || "").toLowerCase().includes(q)).slice(0, 6),
    [conversations, q],
  );
  const flat = useMemo(() => [
    ...shownActions.map((a) => ({ id: `a-${a.key}`, run: a.run })),
    ...rows.map((c) => ({ id: `c-${c.id}`, run: () => onOpen(c) })),
  ], [shownActions, rows, onOpen]);
  // The ref is the source of truth for key handling — consecutive keystrokes must not
  // race React's async re-render (state is only mirrored for highlighting).
  const selRef = useRef(0);
  const moveSel = (delta) => {
    const max = Math.max(flat.length, 1);
    selRef.current = (selRef.current + delta + max) % max;
    setSelected(selRef.current);
  };
  useEffect(() => { selRef.current = 0; setSelected(0); }, [q]);
  const sel = Math.min(selected, Math.max(flat.length - 1, 0));

  return (
    <div className="ct-palette show" role="dialog" aria-modal="true" aria-label="Command palette">
      <input autoFocus placeholder="Type a command or search conversations…" aria-label="Type a command or search conversations"
        value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
          if (e.key === "Enter") {
            const target = flat[Math.min(selRef.current, flat.length - 1)];
            if (target) { e.preventDefault(); target.run(); }
          }
        }} />
      {shownActions.length > 0 && <div className="ct-pal-sect">Actions</div>}
      {shownActions.map((a, i) => (
        <button key={a.key} className={`ct-pal-row ${sel === i ? "sel" : ""}`} onClick={a.run}
          onMouseMove={() => { if (selRef.current !== i) { selRef.current = i; setSelected(i); } }}>
          {a.label}{a.hint && <span className="ct-pal-hint">{a.hint}</span>}
        </button>
      ))}
      {rows.length > 0 && <div className="ct-pal-sect">Conversations</div>}
      {rows.map((c, i) => (
        <button key={c.id} className={`ct-pal-row ${sel === shownActions.length + i ? "sel" : ""}`}
          onClick={() => onOpen(c)}
          onMouseMove={() => { const n = shownActions.length + i; if (selRef.current !== n) { selRef.current = n; setSelected(n); } }}>
          {c.title || "Untitled"}
        </button>
      ))}
      {!flat.length && <div className="ct-pal-sect" style={{ paddingBottom: 14 }}>No matches — try a different word.</div>}
    </div>
  );
}
