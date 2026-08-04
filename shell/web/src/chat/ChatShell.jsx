// The Thrallo application — conversation-first, built from the approved wireframes
// (docs/DESIGN.md). Permanent UI is the four elements only: conversation, the living
// rail, preview, and the settings sheet. Everything else is a card in the thread, a
// summonable view, or a palette entry.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../lib/useSession.js";
import Landing from "../landing/Landing.jsx";
import AccountMenu from "../auth/AccountMenu.jsx";
import ConfirmDialog from "../settings/ConfirmDialog.jsx";
import { rememberIntendedPath, signOutCompletely, takeIntendedPath } from "../auth/signOut.js";
import ResetPassword from "../auth/ResetPassword.jsx";
import { client } from "../lib/backend.js";
import {
  listConversations, bulkConversations, startConversation, sendConversationMessage,
  streamConversationEvents, deleteConversation,
  listDeletedConversations, restoreConversation, incidentDetails,
} from "../lib/codeAgentApi.js";
import {
  applyEvent, emptyConversationView, replayEvents, railState,
  SPECIALIST_HUES, agentInitials, beginChips,
} from "./conversationState.js";
import { renderMarkdown } from "./markdown.js";
import ManageView, { MANAGE_VIEW_IDS } from "../manage/ManageView.jsx";
import PlanBanner from "../billing/PlanBanner.jsx";
import SettingsView, { SETTINGS_TABS } from "../settings/SettingsView.jsx";
import SuccessView from "../billing/SuccessView.jsx";
import {
  readBillingReturn, rememberBillingReturn, takeRememberedBillingReturn,
} from "../billing/billingReturn.js";
import PublishedPanel from "../publish/PublishedPanel.jsx";
import ProjectPublishRow from "../publish/ProjectPublishRow.jsx";

import ProjectDashboard from "../publish/ProjectDashboard.jsx";
import Onboarding from "../start/Onboarding.jsx";
import StarterGallery from "../start/StarterGallery.jsx";
import HistoryView from "../history/HistoryView.jsx";
import { onboardingState, updateOnboarding } from "../lib/codeAgentApi.js";
import UnpublishConfirm from "../publish/UnpublishConfirm.jsx";
import { usePublishState } from "../publish/publishState.js";

// What a completed bulk action says. Named counts rather than "Done": acting on twelve projects
// and being told "Done" leaves the customer counting cards to check.
const bulkMessage = (action, n) => {
  const projects = `${n} project${n === 1 ? "" : "s"}`;
  switch (action) {
    case "favourite": return `${projects} added to favourites`;
    case "unfavourite": return `${projects} removed from favourites`;
    case "archive": return `${projects} archived`;
    case "restore": return `${projects} restored`;
    case "delete": return `${projects} moved to Recently Deleted`;
    default: return `${projects} updated`;
  }
};
import { useDebounced } from "../lib/useDebounced.js";
import {
  TABS, statusOf, countByTab, isLive, badgesFor, groupProjects, DOMAIN_STATUS_LABEL,
  PUBLISH_SUCCESS_DURATION_MS,
} from "../publish/publishLifecycle.js";
import PricingView from "../billing/PricingView.jsx";
import { usePlanState } from "../billing/planState.js";
import ModelSelector, { MODEL_PREF_KEY, displayName as modelDisplayName } from "./ModelSelector.jsx";
import { setConversationModel, cancelBuild, unpublishProject } from "../lib/codeAgentApi.js";
import RunOverlay from "../manage/RunOverlay.jsx";
import AiSettings from "../manage/AiSettings.jsx";
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
  // The billing return is a NAVIGATION and can arrive in any browser — a phone, a second machine,
  // a private window. It used to be handled inside the workspace, BELOW this gate, so a customer
  // who had just paid real money was shown the public landing page and told nothing. Remember it
  // here, above the gate, and hand it to whichever screen renders.
  const billingReturn = readBillingReturn();
  if (billingReturn === "success") rememberBillingReturn("success");
  if (!user) {
    // Where they were trying to go, so signing in returns them there rather than the dashboard.
    rememberIntendedPath();
    return <Landing billingReturn={billingReturn} />;
  }
  return <Workspace user={user} />;
}

// True on touch-primary devices — autofocusing there pops the keyboard over the content.
const FINE_POINTER = typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches;

function Workspace({ user }) {
  const [theme, setTheme] = useTheme(user);
  const [conversations, setConversations] = useState([]);
  // Read by refreshProjects so it can re-fetch exactly as much as is already on screen without
  // taking `conversations` as a dependency and rebuilding the callback on every list change.
  const conversationsRef = useRef([]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  const [convosLoaded, setConvosLoaded] = useState(false);
  const [active, setActive] = useState(null);        // conversation row
  const [view, setView] = useState(emptyConversationView);
  const [pending, setPending] = useState(null);      // optimistic user text awaiting its event
  const [wsContext, setWsContext] = useState(null);  // editor context from the desktop bridge
  const [wsContextOn, setWsContextOn] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [manageView, setManageView] = useState(null); // null | repos | usage | ops
  const [deleting, setDeleting] = useState(null);     // { project, busy, error, permanent } | null
  const [deletedItems, setDeletedItems] = useState([]); // Recently Deleted (7-day recovery)
  const [sheetSection, setSheetSection] = useState(null); // deep-link target inside Settings
  const [modelPref, setModelPref] = useState(() => localStorage.getItem(MODEL_PREF_KEY) || "auto");
  const [runOverlayId, setRunOverlayId] = useState(null);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [toast, setToast] = useState("");
  // First run. `null` while unknown: showing the tour before the answer arrives would flash it at
  // every returning customer, and hiding it by default would deny it to every new one.
  const [onboarding, setOnboarding] = useState(null);
  const [showStarters, setShowStarters] = useState(false);
  // Text put into the composer for the customer to edit — from a starter, or from "Edit & rebuild".
  // Carries a nonce so choosing the SAME prompt twice still re-seeds the box.
  const [composerSeed, setComposerSeed] = useState({ text: "", nonce: 0 });
  const [confirmSignOut, setConfirmSignOut] = useState(null);
  // Thrallo has one screen, so routing is one path rather than a router dependency. /pricing is a
  // real URL because it is shareable and gets linked to; everything else stays at "/".
  const [path, setPath] = useState(() => window.location.pathname);
  const [query, setQuery] = useState(() => window.location.search);
  // Stripe returns the customer to /?billing=success or /?billing=cancelled. Held in state rather
  // than read from the URL on every render, so returning to the dashboard clears it for good.
  // From the URL, or from a return that arrived before this customer signed in.
  const [billingReturn, setBillingReturn] = useState(
    () => readBillingReturn() || takeRememberedBillingReturn(),
  );
  const planState = usePlanState();
  const publish = usePublishState();
  // Set only when a publish completes in THIS session, so the celebration belongs to the moment
  // while the panel itself stays permanently.
  // { projectId, at } — WHICH project just published, and when. It used to hold a projectId that
  // nothing compared against (`celebrate={!!justPublished}`), so publishing project A and then
  // opening project B made B celebrate too; and it was cleared only by pressing Publish Update, so
  // the banner outlived the moment by hours.
  const [justPublished, setJustPublished] = useState(null);
  const [unpublishing, setUnpublishing] = useState(null); // { conversation, site, busy, error }
  const [dashboard, setDashboard] = useState(null); // { site, tab }
  // A projectId waiting for its publish state to arrive before the Domains panel can be opened on
  // it. The event beats the refresh, so the intent is held rather than dropped.
  const [openDomainsFor, setOpenDomainsFor] = useState(null);
  const scrollMemory = useRef(new Map()); // conversationId -> {top, atBottom}
  const streamAbort = useRef(null);
  const toastTimer = useRef(null);
  // What opened the overlay that is showing. WebKit does not focus a button on click, so
  // document.activeElement is <body> by the time the overlay mounts and focus cannot be returned.
  const overlayOpener = useRef(null);

  const showToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  // Filtering, searching and paging all happen on the server. The client holds one page, so doing
  // any of it here would hide everything past the page and make a tab count describe 20 rows
  // rather than the account.
  const [listTab, setListTab] = useState("all");
  const [listSearch, setListSearch] = useState("");
  const [listSort, setListSort] = useState("activity");
  const [listFavourites, setListFavourites] = useState(false);
  const [listArchived, setListArchived] = useState(false);
  const [listing, setListing] = useState({ counts: {}, page: null, sorts: [] });
  const [listError, setListError] = useState("");
  const [listBusy, setListBusy] = useState(false);
  // Which projects a bulk action would act on. Cleared whenever the list they were chosen from
  // changes, so an action can never apply to something no longer on screen.
  const [selected, setSelected] = useState([]);

  const loadConversations = useCallback(async ({
    tab = listTab, q = listSearch, sort = listSort, favourites = listFavourites,
    archived = listArchived, offset = 0, append = false, limit = 0,
  } = {}) => {
    setListBusy(true);
    try {
      const result = await listConversations({ tab, q, sort, favourites, archived, offset, limit });
      setConversations((current) => (append
        ? [...current, ...(result.conversations || [])]
        : (result.conversations || [])));
      setListing({ counts: result.counts || {}, page: result.page || null, sorts: result.sorts || [] });
      setListError("");
    } catch (error) {
      // A list that fails must say so. Rendering an empty dashboard would tell someone their
      // projects were gone.
      setListError(error?.message || "Your projects could not be loaded. Please try again.");
    } finally {
      setListBusy(false);
      setConvosLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listTab, listSearch, listSort, listFavourites, listArchived]);

  useEffect(() => {
    // The selection belonged to the previous list; keeping it would let a bulk action apply to a
    // project the user can no longer see.
    setSelected([]);
    loadConversations({ offset: 0 });
    listDeletedConversations().then((r) => setDeletedItems(r.items || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listTab, listSearch, listSort, listFavourites, listArchived]);

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
            // Usage is a Settings tab now, not an overlay of its own. The capability keeps its
            // name — the Lead Agent's contract is unchanged — and lands on the one usage surface
            // that exists rather than a second copy of it.
            if (event.type === "open_view" && event.payload?.view === "usage") {
              navigate("/settings/usage");
            }
            // A publish has just succeeded. The panel's facts (URL, time, whether what is live is
            // current) live server-side, so re-read them rather than assembling them from the
            // event — that keeps one source of truth and makes updateAvailable correct.
            if (event.type === "published") {
              setJustPublished(event.payload?.projectId
                ? { projectId: String(event.payload.projectId), at: Date.now() }
                : null);
              refreshProjects();
            }
            if (event.type === "open_view" && event.payload?.view === "run" && event.payload?.runId) {
              setRunOverlayId(event.payload.runId);
            }
            // Connecting a domain from conversation lands on the SAME Domains panel the button
            // opens — one workflow, whichever way it was asked for. The panel polls until the
            // domain settles, so the records stay live rather than freezing at what the chat said.
            if (event.type === "domain") {
              refreshProjects();
              setOpenDomainsFor(event.payload?.projectId || null);
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
        // Settings closes itself on Escape, because closing it is a navigation rather than a
        // state change — doing it from here too would push a second history entry.
        setPaletteOpen(false); setMobilePreview(false); setManageView(null); setRunOverlayId(null);
        setDeleting((d) => (d?.busy ? d : null));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rail = railState(view);
  const initial = (user.email || "?")[0].toUpperCase();
  const workingAgent = [...view.roster].reverse().find((r) => r.state === "working");

  // Publish state now travels with the conversation rows, so re-reading them IS the dashboard
  // refresh. Called after publish and unpublish so a card never shows a state the user has
  // already changed.
  /**
   * A bulk action, then a reload of exactly what is on screen.
   *
   * Optimism is deliberately avoided here: archiving removes cards from the current view, and a
   * list that reorders itself before the server has agreed is a list that can snap back. The
   * reload is scoped to the rows already loaded so someone who paged twice keeps their place.
   */
  const runBulk = useCallback(async (action, ids = selected) => {
    if (!ids.length) return;
    setListBusy(true);
    try {
      const result = await bulkConversations(ids, action);
      setSelected([]);
      showToast(bulkMessage(action, result.changed));
      await loadConversations({ offset: 0, limit: Math.max(20, conversationsRef.current.length) });
      if (action === "delete") {
        listDeletedConversations().then((r) => setDeletedItems(r.items || [])).catch(() => {});
      }
      publish.refresh();
    } catch (error) {
      // A toast, not the list-level error: that one replaces the whole workspace, and losing every
      // card because one archive failed would be a far worse outcome than the failure itself. The
      // selection is kept so the action can simply be tried again.
      showToast(error?.message || "That did not work. Nothing was changed.");
    } finally {
      setListBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, loadConversations, showToast]);

  // Favouriting is a single-project action that reuses the bulk path rather than adding a second
  // endpoint that could drift from it.
  const toggleFavourite = useCallback((conversation) => {
    runBulk(conversation.favourite ? "unfavourite" : "favourite", [conversation.id]);
  }, [runBulk]);

  const refreshProjects = useCallback(() => {
    publish.refresh();
    // Refreshes everything already on screen rather than snapping back to page one — someone who
    // loaded three pages and then published should not lose their place.
    return loadConversations({ offset: 0, limit: Math.max(20, conversationsRef.current.length) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConversations]);

  // The project currently celebrating, or null. Expires on a timer rather than lingering until the
  // next publish, and is cleared when the conversation changes — a celebration belongs to a moment
  // and to one project.
  const [celebratingProjectId, setCelebratingProjectId] = useState(null);
  useEffect(() => {
    if (!justPublished || PUBLISH_SUCCESS_DURATION_MS === 0) { setCelebratingProjectId(null); return undefined; }
    const remaining = PUBLISH_SUCCESS_DURATION_MS - (Date.now() - justPublished.at);
    if (remaining <= 0) { setCelebratingProjectId(null); return undefined; }
    setCelebratingProjectId(justPublished.projectId);
    const timer = setTimeout(() => setCelebratingProjectId(null), remaining);
    return () => clearTimeout(timer);
  }, [justPublished]);
  useEffect(() => { setJustPublished(null); }, [active?.id]);

  // Open the Domains panel once the newly connected project's publish state has actually arrived.
  // Doing it inline on the event would open a dashboard with no site to render.
  useEffect(() => {
    if (!openDomainsFor) return;
    const site = publish.sites.find((s) => String(s.projectId) === String(openDomainsFor));
    if (!site) return;
    openDashboard(site, "domains");
    setOpenDomainsFor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDomainsFor, publish.sites]);

  // Publishing from a dashboard card must post to THAT conversation. `send` reads `active` from
  // its closure, which is still null in the same tick as openConversation — using it here would
  // silently start a brand new conversation instead.
  const publishUpdateFor = useCallback(async (conversation) => {
    const text = "Publish the latest version of this app.";
    openConversation(conversation);
    setPending(text);
    try {
      await sendConversationMessage(conversation.id, text, null);
    } catch (error) {
      setPending(null);
      showToast(error.message || "That didn't send — try again from the project.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConversation, showToast]);

  // Back/forward must work on a real URL, so the browser stays the source of truth.
  const navigate = useCallback((next) => {
    // Compared against pathname AND search: Stripe returns to "/?billing=success", whose pathname
    // is already "/", so comparing the path alone would leave the query in place and replay the
    // success screen on the next refresh.
    if (window.location.pathname + window.location.search !== next) {
      window.history.pushState({}, "", next);
    }
    setPath(window.location.pathname);
    setQuery(window.location.search);
  }, []);
  useEffect(() => {
    // The query string is tracked too, because ?ref=<build> is what makes a link to one
    // deployment's logs a different destination from the project's whole log stream. Without it,
    // Back from a build's logs to the log list would change nothing on screen.
    const onPop = () => { setPath(window.location.pathname); setQuery(window.location.search); };
    window.addEventListener("popstate", onPop);
    // Firefox restores a page from its back/forward cache without firing popstate — the document
    // comes back exactly as it was, including React state that describes the address it was cached
    // AT, not the one it was restored TO. Going Back from a reloaded /settings/billing landed on
    // /settings/usage in the URL bar with Billing still selected. `pageshow` is the event that
    // fires on a bfcache restore, so re-reading the address there keeps the two in step.
    window.addEventListener("pageshow", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("pageshow", onPop);
    };
  }, []);

  // /projects/:projectId/:tab?ref=<buildId> — the dashboard as a real address.
  //
  // The URL drives the dashboard rather than the other way round, so a refresh, a bookmark, a
  // pasted link and the Back button all arrive at the same tab and the same build.
  const route = useMemo(() => {
    // Deliberately not a UUID shape check. The real validation is below — the dashboard opens only
    // if THIS owner has a published site with that id — and an id that matches nothing simply does
    // nothing. A shape check here would add no safety and would reject ids the server accepts.
    const match = path.match(/^\/projects\/([^/]+)\/([a-z]+)$/i);
    if (!match) return null;
    return { projectId: match[1], tab: match[2], ref: new URLSearchParams(query).get("ref") || null };
  }, [path, query]);

  // /settings/:tab — a real address, for the same reasons the dashboard has one: Back works,
  // a refresh returns to the same tab, and "your billing is here" is a link someone can send.
  // History is an address too, so it can be linked to and Back leaves it.
  const historyOpen = useMemo(() => /^\/history\/?$/i.test(path), [path]);
  const settingsTab = useMemo(() => {
    const match = path.match(/^\/settings(?:\/([a-z]+))?$/i);
    if (!match) return null;
    return SETTINGS_TABS.some((t) => t.id === match[1]) ? match[1] : "usage";
  }, [path]);
  const closeSettings = useCallback(() => { setSheetSection(null); navigate("/"); }, [navigate]);

  /**
   * Log out, asking first only when there is something to say.
   *
   * Builds run entirely server-side and keep going, so leaving does not lose work — but somebody
   * watching a build has no way to know that, and a silent sign-out mid-build reads as having
   * thrown it away. An unsent draft in the composer is the one thing that IS genuinely lost.
   *
   * No confirmation when neither is true: a dialog on every log out is a dialog nobody reads.
   */
  const requestSignOut = useCallback(() => {
    const building = !!view.activeBuild || view.thinking;
    const draft = !!pending;
    if (!building && !draft) return signOutCompletely(client);

    setConfirmSignOut({
      building,
      draft,
      body: [
        building && "Your build carries on running on Thrallo's servers — signing out does not stop "
          + "it, and it will be waiting when you sign back in.",
        draft && "The message you were writing has not been sent, and will be lost.",
      ].filter(Boolean).join(" "),
    });
  }, [view.activeBuild, view.thinking, pending]);

  // ── First run ─────────────────────────────────────────────────────────────────────────
  //
  // Read once per session. A failure leaves it as "not pending" rather than showing the tour to
  // someone who has already dismissed it — an unwanted tour is a worse outcome than a missed one,
  // and Help can reopen it either way.
  // A visitor who was sent to a deep link, signed in, and should land there rather than on the
  // dashboard. Runs once: taking the value clears it, so a later refresh does not re-navigate.
  useEffect(() => {
    const intended = takeIntendedPath();
    if (intended && intended !== window.location.pathname + window.location.search) navigate(intended);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    onboardingState()
      .then((state) => { if (live) setOnboarding(state); })
      .catch(() => { if (live) setOnboarding({ pending: false, step: 0 }); });
    return () => { live = false; };
  }, []);

  const finishOnboarding = useCallback((action, step = null) => {
    setOnboarding((current) => ({ ...(current || {}), pending: false }));
    updateOnboarding(action, step).catch(() => {
      // The tour has already closed on screen. A failed write means it may return on the next
      // device, which is a far smaller cost than refusing to let someone past it.
    });
  }, []);

  const reopenOnboarding = useCallback(() => {
    setSheetSection(null);
    navigate("/");
    setOnboarding({ pending: true, step: 0 });
    updateOnboarding("reopen").catch(() => {});
  }, [navigate]);

  // A starter, or a prompt being reused, becomes an editable draft in the composer — never a send.
  const seedComposer = useCallback((text) => {
    setShowStarters(false);
    setOnboarding((current) => ({ ...(current || {}), pending: false }));
    setComposerSeed((current) => ({ text, nonce: current.nonce + 1 }));
  }, []);

  const useStarter = useCallback((prompt, starterId) => {
    // Recorded as completion, with which starter began it, so "did the gallery actually get used"
    // is answerable later without a second analytics path.
    updateOnboarding("complete").catch(() => {});
    seedComposer(prompt);
    showToast(starterId ? "Edit anything, then send it." : "Edit anything, then send it.");
  }, [seedComposer, showToast]);

  useEffect(() => {
    if (!route) {
      // Navigating away from a project address closes the dashboard, so Back actually goes back.
      if (dashboard && !dashboard.transient) setDashboard(null);
      return;
    }
    const site = publish.sites.find((s) => String(s.projectId) === route.projectId);
    if (!site) return;   // publish state has not arrived yet; this re-runs when it does
    const conversation = conversations.find((c) => String(c.productId) === String(site.productId)) || null;
    setDashboard((current) => (
      current?.site?.projectId === site.projectId && current?.tab === route.tab && current?.buildRef === route.ref
        ? current
        : { site, tab: route.tab, buildRef: route.ref, conversation }
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, publish.sites, conversations]);

  // Opening the dashboard is a navigation, not a state change — that is what gives it a URL.
  const openDashboard = useCallback((site, tab = "overview", _conversation = null, ref = null) => {
    if (!site?.projectId) return;
    navigate(`/projects/${site.projectId}/${tab}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
  }, [navigate]);

  // An abandoned checkout needs no screen of its own — the dashboard is the right place to land.
  // The parameter is cleared so a refresh does not look like a second abandonment.
  useEffect(() => {
    if (billingReturn === "cancelled") {
      window.history.replaceState({}, "", "/");
      setBillingReturn(null);
    }
  }, [billingReturn]);

  // Home never interrupts anything — builds run entirely server-side; the stream is simply
  // closed here and resumed (with `after`) when the conversation reopens.
  const goHome = useCallback(() => {
    streamAbort.current?.abort();
    setActive(null); setView(emptyConversationView()); setMobilePreview(false);
    navigate("/");
    loadConversations({ offset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <AccountMenu email={user.email} initial={initial} desktop={!!user.desktop}
          onSettings={() => navigate("/settings/usage")}
          onHistory={() => navigate("/history")}
          onSignOut={requestSignOut} />
      </header>

      <DesktopUpdateNotice />
      {active && view.roster.length > 0 && (
        <MobileStrip roster={view.roster} working={workingAgent} build={view.activeBuild} onPreview={() => view.previewUrl && setMobilePreview(true)} />
      )}

      {billingReturn === "success" ? (
        <SuccessView onDone={() => { setBillingReturn(null); planState.refresh(); goHome(); }} />
      ) : path === "/pricing" ? (
        <PricingView planState={planState} onBack={goHome} />
      ) : !active ? (
        <div className="ct-dash">
          <PlanBanner planState={planState} onOpenPricing={() => navigate("/pricing")} />
          <Begin user={user} conversations={conversations} loaded={convosLoaded} onSend={send}
            composerSeed={composerSeed} onOpenStarters={() => setShowStarters(true)}
            onStarterPrompt={useStarter}
            counts={listing.counts} page={listing.page} busy={listBusy} error={listError}
            tab={listTab} onTab={setListTab}
            search={listSearch} onSearch={setListSearch}
            sorts={listing.sorts} sort={listSort} onSort={setListSort}
            favouritesOnly={listFavourites} onFavouritesOnly={setListFavourites}
            archived={listArchived} onArchived={setListArchived}
            selected={selected} onSelected={setSelected} onBulk={runBulk}
            onToggleFavourite={toggleFavourite}
            onLoadMore={() => listing.page?.nextOffset != null
              && loadConversations({ offset: listing.page.nextOffset, append: true })}
            onRetryList={() => loadConversations({ offset: 0 })}
            onPublishUpdate={publishUpdateFor}
            onUnpublish={(c) => setUnpublishing({ conversation: c, site: c.site, busy: false, error: "" })}
            onProjectSettings={(c) => openDashboard(c.site, "settings")}
            onAnalytics={(c) => openDashboard(c.site, "analytics")}
            onHealth={(c) => openDashboard(c.site, "health")}
          modelPref={modelPref}
          onModelChange={(v) => { setModelPref(v); localStorage.setItem(MODEL_PREF_KEY, v); }}
          onOpenSettings={() => { setSheetSection("ai"); navigate("/settings/preferences"); }}
          onContinue={(id) => {
            const row = conversations.find((c) => c.id === id);
            if (row) openConversation(row);
          }}
          onDelete={(c) => setDeleting({ project: c, busy: false, error: "", permanent: false })}
          deletedItems={deletedItems}
          onRestore={(item) => restoreConversation(item.id)
            .then(() => {
              setDeletedItems((list) => list.filter((d) => d.id !== item.id));
              loadConversations({ offset: 0 });
              showToast("Project restored.");
            })
            .catch((error) => showToast(error.message || "Restore failed — the project is still recoverable."))}
          onDeleteNow={(item) => setDeleting({
            project: { id: item.id, title: item.title }, busy: false, error: "", permanent: true,
          })} />
        </div>
      ) : (
        <div className="ct-room">
          <div className="ct-thread-wrap">
            {/* Above the thread, so it stays put while the conversation scrolls — the answer to
                "is my app live?" must not scroll away the way the old publish message did. */}
            <PublishedPanel site={publish.byProduct(active.productId)}
              // Scoped to THIS project, so another project's publish never celebrates here.
              celebrate={celebratingProjectId != null
                && String(publish.byProduct(active.productId)?.projectId) === celebratingProjectId}
              onPublishUpdate={() => { setJustPublished(null); send("Publish the latest version of this app."); }}
              onUnpublish={() => setUnpublishing({
                conversation: active, site: publish.byProduct(active.productId), busy: false, error: "",
              })}
              onOpenSettings={() => openDashboard(publish.byProduct(active.productId), "settings")}
              // "Connect Domain" opens the Domains panel — the one workflow that actually connects
              // domains. It used to open Project Settings, which contains no domain UI at all.
              onConnectDomain={() => openDashboard(publish.byProduct(active.productId), "domains")}
              onAnalytics={() => openDashboard(publish.byProduct(active.productId), "analytics")}
              // The exact build run, not the whole stream — the deep link PR 6 built.
              onLogs={(runId) => openDashboard(publish.byProduct(active.productId), "logs", null, runId)}
              // Opens Deployments focused on this deployment rather than leaving someone to find it.
              onDeployments={(deploymentId) =>
                openDashboard(publish.byProduct(active.productId), "deployments", null, deploymentId)} />
            <Thread view={view} pending={pending} onOpenPreview={() => setMobilePreview(true)}
              onRetry={send} scrollKey={active.id} scrollMemory={scrollMemory} />
            <div className="ct-model-dock">
              <ModelSelector compact value={active.model_pref || active.modelPref || "auto"}
                onChange={changeConversationModel}
                onOpenSettings={() => { setSheetSection("ai"); navigate("/settings/preferences"); }} />
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

      {/* The dashboard was the one overlay in the product with no backdrop: it opened over a fully
          lit page that still looked interactive, and clicking away did nothing. */}
      <div className={`ct-scrim ${settingsTab || paletteOpen || manageView || runOverlayId || dashboard ? "show" : ""}`} aria-hidden="true"
        onClick={() => {
          setPaletteOpen(false); setManageView(null); setRunOverlayId(null);
          if (dashboard || settingsTab) navigate("/");
        }} />
      {/* Mounted only while its address is open, so the five tab chunks are not fetched — and its
          data is not read — by visitors who never open Settings. */}
      {settingsTab && (
        sheetSection
          ? <SettingsSection section={sheetSection} onBack={() => setSheetSection(null)} onClose={closeSettings} />
          : (
            <SettingsView user={user} theme={theme} setTheme={setTheme} initialTab={settingsTab}
              onClose={closeSettings} showToast={showToast} openedBy={overlayOpener}
              onTabChange={(next) => navigate(`/settings/${next}`)}
              onSection={setSheetSection}
              onUpgrade={() => { setSheetSection(null); navigate("/pricing"); }}
              onOpenUrl={(url) => {
                // A notification can point at a customer's live site or back into Thrallo. An
                // external address opens in its own tab so the workspace is never lost.
                if (/^https?:\/\//i.test(url) && !url.startsWith(window.location.origin)) {
                  window.open(url, "_blank", "noopener,noreferrer");
                } else {
                  navigate(url.replace(window.location.origin, "") || "/");
                }
              }} />
          )
      )}
      {onboarding?.pending && (
        <Onboarding initialStep={onboarding.step || 0}
          onStep={(step) => updateOnboarding("step", step).catch(() => {})}
          onSkip={(step) => finishOnboarding("skip", step)}
          onComplete={(step) => finishOnboarding("complete", step)}
          onUseStarter={useStarter} />
      )}
      {showStarters && !onboarding?.pending && (
        <>
          <div className="ct-scrim show" aria-hidden="true" onClick={() => setShowStarters(false)} />
          <aside className="ct-sheet show ct-settings" aria-label="Start from an idea">
            <div className="ct-sheet-head">
              <h2>Start from an idea</h2>
              <button className="ct-btn-quiet" onClick={() => setShowStarters(false)}>Close</button>
            </div>
            <div className="ct-sheet-body">
              <StarterGallery onUse={useStarter} onClose={() => setShowStarters(false)} />
            </div>
          </aside>
        </>
      )}
      {historyOpen && (
        <>
          <div className="ct-scrim show" aria-hidden="true" onClick={() => navigate("/")} />
          <aside className="ct-sheet show ct-settings" aria-label="History">
            <div className="ct-sheet-head">
              <h2>History</h2>
              <button className="ct-btn-quiet" onClick={() => navigate("/")}>Done</button>
            </div>
            <div className="ct-sheet-body">
              <HistoryView showToast={showToast}
                onUseAgain={(prompt, { edit }) => {
                  navigate("/");
                  seedComposer(prompt);
                  showToast(edit ? "Change what you like, then send it." : "Ready to send again — this starts a new build.");
                }}
                onOpenConversation={(id) => {
                  const found = conversationsRef.current.find((c) => String(c.id) === String(id));
                  navigate("/");
                  if (found) openConversation(found);
                }}
                onOpenDeployment={(deployment) => navigate(`/projects/${deployment.projectId}/deployments`)}
                onOpenLogs={(item) => navigate(`/projects/${item.projectId}/logs${item.id ? `?ref=${encodeURIComponent(item.id)}` : ""}`)} />
            </div>
          </aside>
        </>
      )}
      {confirmSignOut && (
        <ConfirmDialog
          title="Log out?"
          body={confirmSignOut.body}
          confirmLabel="Log out"
          destructive={confirmSignOut.draft}
          onCancel={() => setConfirmSignOut(null)}
          onConfirm={() => signOutCompletely(client)} />
      )}
      <ManageView view={manageView} onClose={() => setManageView(null)}
        onSentence={(text) => { setManageView(null); send(text); }}
        onOpenRun={(id) => setRunOverlayId(id)} />
      {unpublishing && (
        <UnpublishConfirm site={unpublishing.site} busy={unpublishing.busy} error={unpublishing.error}
          onCancel={() => setUnpublishing(null)}
          onConfirm={async () => {
            setUnpublishing((u) => ({ ...u, busy: true, error: "" }));
            try {
              const result = await unpublishProject(unpublishing.site.projectId);
              setUnpublishing(null);
              await refreshProjects();
              showToast(result.message || "Your site has been unpublished.");
            } catch (error) {
              setUnpublishing((u) => ({
                ...u, busy: false,
                error: error.message || "The site could not be taken offline. Please try again.",
              }));
            }
          }} />
      )}
      {dashboard && (
        <ProjectDashboard site={dashboard.site} initialTab={dashboard.tab} initialRef={dashboard.buildRef || null}
          // Switching tab is a navigation, so Back returns to the previous tab instead of leaving
          // the dashboard entirely, and a build's logs can be linked to directly.
          onTabChange={(tab, ref) => openDashboard(dashboard.site, tab, null, ref)}
          onClose={() => navigate("/")}
          onUpgrade={() => navigate("/pricing")}
          onSentence={(text) => { navigate("/"); send(text); }}
          onPublishUpdate={() => { navigate("/"); publishUpdateFor(dashboard.conversation); }}
          onUnpublish={() => setUnpublishing({ conversation: dashboard.conversation, site: dashboard.site, busy: false, error: "" })} />
      )}
      {runOverlayId && <RunOverlay runId={runOverlayId} onClose={() => setRunOverlayId(null)} />}
      {paletteOpen && (
        <Palette conversations={conversations}
          onNew={() => { setActive(null); setView(emptyConversationView()); setPaletteOpen(false); }}
          onOpen={(c) => { openConversation(c); setPaletteOpen(false); }}
          onSettings={() => { setPaletteOpen(false); navigate("/settings/usage"); }}
          onUsage={() => { setPaletteOpen(false); navigate("/settings/usage"); }}
          onHistory={() => { setPaletteOpen(false); navigate("/history"); }}
          onIdeas={() => { setPaletteOpen(false); setShowStarters(true); }}
          onTour={() => { setPaletteOpen(false); reopenOnboarding(); }}
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

function Begin({ user, conversations, loaded = true, onSend, composerSeed = null, onOpenStarters = null, onStarterPrompt = () => {}, onContinue, onDelete, deletedItems = [], onRestore, onDeleteNow, modelPref = "auto", onModelChange = null, onOpenSettings = null, onPublishUpdate = () => {}, onUnpublish = () => {}, onProjectSettings = () => {}, onAnalytics = () => {}, onHealth = () => {},
  counts: serverCounts = {}, page = null, busy = false, error = "", tab = "all", onTab = () => {},
  search = "", onSearch = () => {}, onLoadMore = () => {}, onRetryList = () => {},
  sorts = [], sort = "activity", onSort = () => {},
  favouritesOnly = false, onFavouritesOnly = () => {},
  archived = false, onArchived = () => {},
  selected = [], onSelected = () => {}, onBulk = () => {}, onToggleFavourite = () => {} }) {
  const name = firstName(user);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // The box types freely; the fetch waits until typing stops, so every keystroke is not a request.
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => { setSearchDraft(search); }, [search]);
  const settledDraft = useDebounced(searchDraft, 300);
  useEffect(() => {
    if (settledDraft.trim() !== search) onSearch(settledDraft.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledDraft]);
  useEffect(() => { if (!deletedItems.length) setShowDeleted(false); }, [deletedItems.length]);
  // Remember whether this account had projects so the greeting doesn't flash from
  // "Let's build something." to "Welcome back" while the list loads.
  // A narrowed view is not an empty account. Browsing an empty archive, or favourites before
  // anything is starred, must not greet a long-standing customer with "Let's build something."
  const filtered = !!search || tab !== "all" || favouritesOnly || archived;
  const remembered = localStorage.getItem(RETURNING_KEY) === "1";
  const returning = loaded && !filtered ? conversations.length > 0 : remembered;
  useEffect(() => {
    if (loaded && !filtered) localStorage.setItem(RETURNING_KEY, conversations.length ? "1" : "0");
  }, [loaded, filtered, conversations.length]);
  const fresh = !returning;
  const act = (id, run) => { setBusyId(id); Promise.resolve(run()).finally(() => setBusyId(null)); };

  // Everything the server sent for the current tab and search is shown. The old version kept the
  // in-progress ones and then took SIX of the rest, so a seventh project was simply invisible with
  // nothing on screen saying so — a second, quieter ceiling underneath the server's twenty.
  const counts = Object.keys(serverCounts).length ? serverCounts : countByTab(conversations);
  // Archived projects are a flat list. Grouping them by "Live apps / In progress / Drafts" would be
  // describing work nobody is doing.
  // `.filter(items.length)` matters: the archived branch built its group unconditionally, so an
  // empty archive produced ONE group containing nothing. `groups.length === 0` was therefore never
  // true there and the "Nothing is archived" empty state — which exists and reads well — could not
  // render. The archive simply showed a heading with a void under it.
  const groups = archived
    ? [{ id: "archived", label: "Archived", items: conversations }].filter((g) => g.items.length)
    : groupProjects(conversations);

  const selectedSet = new Set(selected);
  const allShown = conversations.map((c) => c.id);
  const allSelected = allShown.length > 0 && allShown.every((id) => selectedSet.has(id));
  const toggleSelect = (id) => onSelected(
    selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id],
  );

  const cardProps = {
    onOpen: onContinue, onDelete, onPublishUpdate, onUnpublish, onProjectSettings, onAnalytics,
    onHealth, onToggleFavourite,
    // Selection only appears once something is selected: a checkbox on every card at all times is
    // permanent chrome for an action most visits never take.
    selecting: selected.length > 0,
    selectedSet,
    onSelect: toggleSelect,
  };
  // Selecting a tab that empties out (the last published project is unpublished, say) would leave
  // the user staring at nothing they asked for. Fall back to All rather than an empty screen —
  // but not while a search is narrowing things, where an empty result is the honest answer.
  useEffect(() => {
    if (tab !== "all" && !search && counts[tab] === 0) onTab("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, counts, search]);
  return (
    <div className="ct-begin" style={{ justifyContent: fresh ? "center" : "flex-start", overflowY: "auto" }}>
      <div className="ct-halo" />
      <div className="ct-hello" style={fresh ? undefined : { marginTop: 40 }}>{fresh ? "Let's build something." : `Welcome back${name ? `, ${name}` : ""}.`}</div>
      <div className="ct-question">What are we building today?</div>
      <Composer autoFocus={FINE_POINTER} onSend={onSend} seed={composerSeed}
        placeholder="Describe anything — an app, a change, an idea…" />
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
      {loaded && error && (
        <div className="ct-workspace">
          <div className="mg-error">
            {error} <button className="ct-linkish" onClick={onRetryList}>Try again</button>
          </div>
        </div>
      )}
      {/* `favouritesOnly` and `archived` belong here as much as search does: without them, turning
          on a filter that matches nothing unmounts the controls that would turn it back off, and
          the empty state below is unreachable. */}
      {loaded && !error && (conversations.length > 0 || search || tab !== "all" || favouritesOnly || archived) && (
        <div className={`ct-workspace ${selected.length ? "ct-selecting" : ""}`}>
          {/* Tabs are views over one field, so a project can never be missing from every tab.
              Counts come from the SERVER and cover the whole account, not the page on screen. */}
          <div className="ct-ws-tabs" role="tablist" aria-label="Project status">
            {TABS.filter((t) => t.id === "all" || counts[t.id] > 0 || tab === t.id).map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id}
                className={`ct-ws-tab ${tab === t.id ? "on" : ""}`} onClick={() => onTab(t.id)}>
                {t.label}<span className="n">{counts[t.id] ?? 0}</span>
              </button>
            ))}
            {/* Shown once there is enough to make finding one a chore. */}
            {(counts.all > 8 || search) && (
              <input className="ct-ws-search" value={searchDraft} placeholder="Search projects…"
                aria-label="Search projects" onChange={(e) => setSearchDraft(e.target.value)} />
            )}
          </div>

          {/* Favourites, ordering and the archive. Each is one click and each is reflected in what
              the server returns, so nothing here filters a page and calls it a filter. */}
          <div className="ct-ws-controls">
            <button className={`ct-chipfilter ${favouritesOnly ? "on" : ""}`}
              aria-pressed={favouritesOnly} disabled={archived}
              onClick={() => onFavouritesOnly(!favouritesOnly)}>
              ★ Favourites{counts.favourites ? ` (${counts.favourites})` : ""}
            </button>
            <button className={`ct-chipfilter ${archived ? "on" : ""}`} aria-pressed={archived}
              onClick={() => { onArchived(!archived); if (!archived) onFavouritesOnly(false); }}>
              Archived
            </button>
            {sorts.length > 0 && (
              <label className="ct-ws-sort">
                <span className="ct-hint">Sort</span>
                <select value={sort} onChange={(e) => onSort(e.target.value)} aria-label="Sort projects">
                  {sorts.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
            )}
            {conversations.length > 0 && (
              <button className="ct-linkish ct-ws-selectall"
                onClick={() => onSelected(allSelected ? [] : allShown)}>
                {allSelected ? "Clear selection" : "Select all"}
              </button>
            )}
          </div>

          {/* The bulk bar appears only when something is selected, and says exactly what it will
              act on rather than "selected items". */}
          {selected.length > 0 && (
            <div className="ct-bulkbar" role="region" aria-label="Bulk actions">
              <span className="ct-bulkbar-count">
                {selected.length} project{selected.length === 1 ? "" : "s"} selected
              </span>
              <div className="ct-bulkbar-actions">
                {archived ? (
                  <button className="ct-pubrow-btn" disabled={busy} onClick={() => onBulk("restore")}>Restore</button>
                ) : (
                  <>
                    <button className="ct-pubrow-btn" disabled={busy} onClick={() => onBulk("favourite")}>★ Favourite</button>
                    <button className="ct-pubrow-btn" disabled={busy} onClick={() => onBulk("archive")}>Archive</button>
                  </>
                )}
                {/* The same soft delete a single project gets — Recently Deleted, recoverable for
                    seven days. A bulk action must never be more destructive than the individual one. */}
                <button className="ct-pubrow-btn" disabled={busy} onClick={() => onBulk("delete")}>Delete</button>
                <button className="ct-btn-quiet" onClick={() => onSelected([])}>Cancel</button>
              </div>
            </div>
          )}
          {/* Grouped by what a project IS, so live apps are never buried among drafts. The tabs
              still filter; this is what the dashboard does before anyone touches them. */}
          {groups.map((group) => (
            <React.Fragment key={group.id}>
              <div className="ct-ws-label">{group.label}</div>
              {group.items.map((c) => <ProjectCard key={c.id} c={c} {...cardProps} />)}
            </React.Fragment>
          ))}
          {/* A narrowed view that finds nothing is NOT a first-time experience. Search, archive,
              favourites and the status tabs each say what that particular view means and how to
              leave it — showing "here is how Thrallo works" to someone with forty projects because
              they filtered to Updates would be absurd. The genuine no-projects case is handled
              below, outside the workspace, where the idea gallery is. */}
          {groups.length === 0 && (
            <div className="ct-ws-empty ct-hint">
              {search ? `Nothing matches “${search}”. Try a shorter word, or part of the address.`
                : archived ? "Nothing is archived. Archiving puts a project out of the way without deleting anything — a published site keeps serving."
                  : favouritesOnly ? "No favourites yet. Star a project to keep it at the top of this list."
                    : tab === "published" ? "Nothing is live yet. Publishing a project puts it on a real web address in seconds, and it will appear here."
                      : tab === "updates" ? "Every published project is up to date — nothing has been built since its last publish."
                        : "No projects in this view."}
            </div>
          )}
          {/* Paging, not a silent ceiling. The old dashboard showed six and said nothing about the
              rest; the count here makes what is hidden visible before you ask for it. */}
          {page?.nextOffset != null && (
            <button className="ct-ws-more" disabled={busy} onClick={onLoadMore}>
              {busy ? "Loading…" : `Load more (${page.total - conversations.length} more)`}
            </button>
          )}
          {page && page.total > 0 && page.nextOffset == null && page.total > page.limit && (
            <div className="ct-ws-empty ct-hint">All {page.total} projects shown.</div>
          )}
        </div>
      )}
      {/* Never built anything. Not "no results": the difference is counts.all, which describes the
          ACCOUNT rather than the current view, so archiving, starring or filtering to Updates can
          never reach this. That is the rule — a narrowed empty view is not a first-time
          experience, and an established customer must never be shown one. */}
      {loaded && !error && (counts.all ?? 0) === 0 && !search && !archived && !favouritesOnly && onOpenStarters && (
        <div className="ct-workspace ct-firstrun">
          <div className="ct-ws-label">Your first build</div>
          <p className="ct-hint ct-firstrun-lead">
            Describe what you want in the box above and the team will plan it, build it and put it
            online. If a blank page is hard, start from one of these — they are opening prompts you
            can edit, not templates.
          </p>
          <StarterGallery compact onUse={onStarterPrompt} />
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

function ProjectCard({
  c, onOpen, onDelete, onPublishUpdate, onUnpublish, onProjectSettings, onAnalytics, onHealth,
  onToggleFavourite = () => {}, selecting = false, selectedSet = new Set(), onSelect = () => {},
}) {
  const s = projectState(c);
  const status = statusOf(c);
  const site = c.site || null;
  const badges = badgesFor(c);
  const isSelected = selectedSet.has(c.id);
  // Stops a click on a control inside the card from also opening the project.
  const only = (run) => (event) => { event.stopPropagation(); run(); };
  // While a selection is running a click selects rather than opens, so the label must say so.
  const cardLabel = `${selecting ? (isSelected ? "Deselect" : "Select") : "Open"} ${c.title || "untitled project"}`
    + ` — ${badges.map((b) => b.label).join(", ")}, ${s.label}`;

  return (
    <div className={`ct-project ${site ? "has-pub" : ""} ${isLive(status) ? "is-live" : ""} ${isSelected ? "is-selected" : ""}`}
      role="button" tabIndex={0} onClick={() => (selecting ? onSelect(c.id) : onOpen(c.id))}
      {...(selecting ? { "aria-pressed": isSelected } : {})}
      aria-label={cardLabel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selecting ? onSelect(c.id) : onOpen(c.id); }
        // A single key to start selecting, so bulk work does not begin with a hunt for a checkbox.
        if (e.key === "x" || e.key === "X") { e.preventDefault(); onSelect(c.id); }
      }}>
      {/* Always rendered, faded away until the card is hovered or focused (or a selection is
          already running). It cannot be conditional on `selecting`: that left the keyboard's `x`
          as the only way to begin, so a mouse could never start a selection at all. */}
      <input type="checkbox" className="ct-pselect" checked={isSelected} onClick={(e) => e.stopPropagation()}
        onChange={() => onSelect(c.id)} aria-label={`Select ${c.title || "untitled project"}`} />
      <span className="ct-pmeta">
        <span className="ct-pname">
          {c.title || "Untitled project"}
          {/* Badges, not a dot. A dot could only ever say one thing, and a project is often two
              things at once — live AND building, or live AND a newer build waiting. */}
          {badges.map((b) => (
            <span className={`ct-badge tone-${b.tone}`} key={b.id}>{b.label}</span>
          ))}
        </span>
        <span className="ct-pactivity">{s.agent ? `${s.agent} · ` : ""}{s.label}</span>
        {site && (
          <ProjectPublishRow site={site} status={status}
            onPublishUpdate={() => onPublishUpdate(c)}
            onUnpublish={() => onUnpublish(c)}
            onSettings={() => onProjectSettings(c)}
            onAnalytics={() => onAnalytics(c)}
            onHealth={() => onHealth(c)}
            health={c.health} today={c.today} />
        )}
      </span>
      <span className="ct-popen">Open</span>
      {/* A card action, grouped with the other one rather than inside the name. Inside `.ct-pname`
          it sat close enough to the centre that clicking the name hit the star, and `only()` stops
          the click there — so the project silently refused to open. */}
      <button className={`ct-pfav ${c.favourite ? "on" : ""}`} onClick={only(() => onToggleFavourite(c))}
        aria-pressed={!!c.favourite}
        aria-label={c.favourite ? "Remove from favourites" : "Add to favourites"}
        title={c.favourite ? "Remove from favourites" : "Add to favourites"}>
        {c.favourite ? "★" : "☆"}
      </button>
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
  if (item.kind === "domain") {
    return <DomainRecords item={item} />;
  }
  if (item.kind === "error") {
    return <div className="ct-error">Something went wrong: {item.text} — say “try again” and I will.</div>;
  }
  if (item.kind === "failure") {
    return <FailureCard item={item} onRetry={onRetry} />;
  }
  return null;
}

// The two DNS records a newly connected domain needs, copyable rather than described.
//
// Both are shown from the start. The verification TXT is what proves ownership, and no certificate
// is requested until it is found — so hiding it until later would leave someone waiting on a step
// they had not been told about.
function DomainRecords({ item }) {
  const [copied, setCopied] = useState(null);
  const copy = async (value, key) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 2_000);
    } catch { setCopied(null); }
  };
  return (
    <div className="ct-domain-card">
      <div className="ct-domain-head">
        <strong>{item.domain}</strong>
        <span className="ct-badge tone-muted">{DOMAIN_STATUS_LABEL[item.status] || "Pending DNS"}</span>
      </div>
      <div className="ct-hint">
        Add these at your DNS provider. Thrallo checks automatically, and the HTTPS certificate is
        issued only once ownership is verified. Your Thrallo address keeps working throughout.
      </div>
      {item.records.map((record) => (
        <div className="ct-domain-record" key={record.name + record.type}>
          <span className="ct-domain-type">{record.type}</span>
          <span className="ct-domain-name" title={record.name}>{record.name}</span>
          <code className="ct-domain-value" title={record.value}>{record.value}</code>
          <button className="ct-btn-quiet" onClick={() => copy(record.value, record.type)}>
            {copied === record.type ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
    </div>
  );
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

// Desktop staleness notice. The desktop app BUNDLES its own copy of this web bundle, so every
// web deploy leaves an installed copy behind — the 2026-08-01 audit found the shipped installer
// five merged PRs out of date with no way for a user to know. There is no auto-updater (the
// binaries are unsigned, so a silent update would be untrustworthy), so the honest alternative
// is to say so once, quietly, and link to the download.
//
// Web users never see this: it renders only when the desktop host injected a version.
function DesktopUpdateNotice() {
  const host = typeof window !== "undefined" ? window.__THRALLO_DESKTOP__ : null;
  const packaged = host?.version || null;
  const [latest, setLatest] = useState(null);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem("thrallo-update-dismissed") === "1");

  useEffect(() => {
    if (!packaged) return;
    // Fails silent: an offline desktop should say nothing, not show an error.
    fetch(`${host.server || ""}/api/v1/downloads`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setLatest(m?.version || null))
      .catch(() => {});
  }, [packaged]);

  if (!packaged || !latest || dismissed) return null;
  // Numeric-aware compare so 0.10.0 is newer than 0.9.0.
  const newer = String(latest).localeCompare(String(packaged), undefined, { numeric: true }) > 0;
  if (!newer) return null;

  return (
    <div className="ct-update-notice" role="status" data-testid="desktop-update-notice">
      <span>A newer Thrallo Desktop is available ({latest}).</span>
      <a href={`${host.server || ""}/api/v1/downloads`} target="_blank" rel="noreferrer">Get it</a>
      <button className="ct-btn-quiet" aria-label="Dismiss"
        onClick={() => { sessionStorage.setItem("thrallo-update-dismissed", "1"); setDismissed(true); }}>Later</button>
    </div>
  );
}

// Stop a running build. Contextual by design (Principle 3): it exists only while the team is
// actually working, and disappears the moment they finish — never permanent chrome.
//
// This is the user-facing half of the cancellation pipeline. The classification work that makes
// a cancelled build stop cleanly (no repair, no retry, no further spend) shipped in #119, but
// its HTTP route had been unmounted since #53, so until now there was no way to trigger it.
function CancelBuild({ build, working, compact = false }) {
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
    <button className={`ct-btn-quiet ct-cancel-build${compact ? " compact" : ""}`} data-testid="cancel-build"
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

function MobileStrip({ roster, working, onPreview, build }) {
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
      {/* The team rail is desktop-only, so without this a phone user cannot stop a build at all.
          Mobile is first-class; the control belongs wherever the roster is shown. */}
      <span onClick={(e) => e.stopPropagation()}>
        <CancelBuild build={build} working={Boolean(working)} compact />
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

function Composer({ onSend, autoFocus = false, placeholder = "Message your team…", waiting = false, thinking = false, context = null, onDismissContext = null, seed = "" }) {
  const [text, setText] = useState("");
  const ref = useRef(null);
  // A seed is a DRAFT, never a send. "Edit & rebuild" and the starter gallery both put words in
  // the box for the customer to change; sending on their behalf would take that away — and the
  // whole point of an expert prompt is that it is a good first draft, not a finished answer.
  //
  // Keyed on the nonce rather than the text: choosing the SAME starter twice, or reusing the same
  // prompt twice, has to re-seed the box, and comparing text alone would silently do nothing.
  const seedNonce = seed?.nonce || 0;
  useEffect(() => {
    if (!seedNonce || !seed?.text) return;
    setText(seed.text);
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`;
    // Caret at the start: these are long prompts and the first line is the one to edit.
    el.setSelectionRange(0, 0);
    el.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);
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

// The two drill-ins that are not tabs: connecting an AI provider, and the download links. Both
// are reached from Preferences, both are long, and neither is something most visits need — so
// they stay separate screens rather than becoming a sixth and seventh tab nobody asked for.
function SettingsSection({ section, onBack, onClose }) {
  const Body = section === "ai" ? AiSettings : DownloadsSettings;
  return (
    <aside className="ct-sheet show ct-settings" aria-label={section === "ai" ? "Model access" : "Downloads"}>
      <div className="ct-sheet-head">
        <button className="ct-btn-quiet" onClick={onBack}>← Settings</button>
        <button className="ct-btn-quiet" onClick={onClose}>Done</button>
      </div>
      <div className="ct-sheet-body"><Body /></div>
    </aside>
  );
}

function Palette({ conversations, onNew, onOpen, onSettings, onOpenView, onUsage, onHistory, onIdeas, onTour }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const actions = useMemo(() => [
    { key: "new", label: "＋ New conversation", hint: "start fresh", run: onNew },
    { key: "settings", label: "⚙ Settings", run: onSettings },
    { key: "history", label: "◔ History", hint: "your prompts · builds · deployments", run: onHistory },
    { key: "ideas", label: "✦ Start from an idea", hint: "expert opening prompts", run: onIdeas },
    { key: "tour", label: "? Show me around", hint: "the first-run walkthrough", run: onTour },
    { key: "repos", label: "⌘ Repositories", hint: "connect · index · policies · PRs", run: () => onOpenView("repos") },
    { key: "usage", label: "▤ Usage & plan", hint: "budgets · guards", run: onUsage },
    { key: "diagnostics", label: "◔ Build diagnostics", hint: "logs · repairs · costs", run: () => onOpenView("diagnostics") },
    { key: "ops", label: "⚡ Operations", hint: "admin", run: () => onOpenView("ops") },
    { key: "analytics", label: "◈ Admin analytics", hint: "admin · spend · revenue", run: () => onOpenView("analytics") },
    { key: "intelligence", label: "◎ Provider intelligence", hint: "admin · learned routing", run: () => onOpenView("intelligence") },
  ], [onNew, onSettings, onOpenView, onUsage, onHistory, onIdeas, onTour]);
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
