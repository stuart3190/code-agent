// Settings.
//
// This replaces a single scrolling sheet of eleven stacked rows in which Billing sat sixth,
// between "Plan & budgets" and "Build diagnostics", and the only way to see what an account had
// used was a Details button that opened a SECOND overlay on top of the first.
//
// The structure is the project dashboard's, deliberately: same tabs, same roving tabindex, same
// focus-in-and-back-out, same Escape. A customer who has learned one has learned both — and a
// pattern implemented twice from one source cannot drift into two behaviours.
//
// Tab bodies are code-split for the same reason the dashboard's are: most visits open Settings to
// check one thing, and none of them should pay to download the other four.

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accountSettings, setPreviewPlan } from "../lib/codeAgentApi.js";
import { TabSkeleton } from "../publish/TabStates.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";

const UsageTab = lazy(() => import("./UsageTab.jsx"));
const BillingTab = lazy(() => import("./BillingTab.jsx"));
const TokensTab = lazy(() => import("./TokensTab.jsx"));
const NotificationsTab = lazy(() => import("./NotificationsTab.jsx"));
const PreferencesTab = lazy(() => import("./PreferencesTab.jsx"));

export const SETTINGS_TABS = [
  { id: "usage", label: "Usage" },
  { id: "billing", label: "Billing" },
  { id: "keys", label: "API keys" },
  { id: "notifications", label: "Notifications" },
  { id: "preferences", label: "Preferences" },
];

export default function SettingsView({
  user, theme, setTheme, initialTab = "usage", onClose, onTabChange, onSection, onUpgrade,
  onOpenUrl, showToast,
}) {
  const [tab, setTabState] = useState(initialTab);
  const [data, setData] = useState(null);      // null = loading
  const [error, setError] = useState("");
  // Settings owns its own confirmations rather than reaching up into the shell for them: the
  // things needing confirming here (revoking a key, cancelling a plan) are Settings' own.
  const [confirm, setConfirm] = useState(null);
  const tablist = useRef(null);
  const heading = useRef(null);
  const opener = useRef(null);

  // The URL is the source of truth, so Back, forward and a refresh land on the same tab.
  useEffect(() => { setTabState(initialTab); }, [initialTab]);

  const setTab = useCallback((next) => { setTabState(next); onTabChange?.(next); }, [onTabChange]);

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await accountSettings());
    } catch (e) {
      // Named, not blank. "Nothing here" for a failed load is the mistake this codebase keeps
      // finding: it reads as an empty account rather than an unavailable one.
      setError(e.message || "Your settings could not be loaded.");
      setData(null);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus moves in on open and back out on close, so a keyboard user is not left tabbing through
  // the page behind this one.
  useEffect(() => {
    opener.current = document.activeElement;
    heading.current?.focus();
    return () => {
      const returnTo = opener.current;
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, []);

  const onTabKeyDown = (event) => {
    const index = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let next = null;
    if (move) next = SETTINGS_TABS[(index + move + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    else if (event.key === "Home") next = SETTINGS_TABS[0];
    else if (event.key === "End") next = SETTINGS_TABS[SETTINGS_TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    setTab(next.id);
    tablist.current?.querySelector(`#settab-${next.id}`)?.focus();
  };

  const unread = data?.notifications?.unread ?? 0;

  const body = useMemo(() => {
    if (!data) return null;
    switch (tab) {
      case "billing":
        return (
          <BillingTab data={data} showToast={showToast} onConfirm={setConfirm}
            onChanged={(next) => setData((current) => ({ ...current, ...next }))} />
        );
      case "keys":
        return (
          <TokensTab tokens={data.tokens} showToast={showToast} onConfirm={setConfirm}
            onTokens={(tokens) => setData((current) => ({ ...current, tokens }))} />
        );
      case "notifications":
        return (
          <NotificationsTab channels={data.notifications?.channels} unread={unread} onOpenUrl={onOpenUrl}
            onUnread={(n) => setData((current) => ({
              ...current, notifications: { ...current.notifications, unread: n },
            }))} />
        );
      case "preferences":
        return (
          <PreferencesTab user={user} theme={theme} setTheme={setTheme} data={data}
            onSection={onSection}
            onPreviewPlan={(plan) => setPreviewPlan(plan).then(load).catch(() => {})} />
        );
      default:
        return (
          <UsageTab data={data} onUpgrade={onUpgrade} onOpenTab={setTab} showToast={showToast}
            onChanged={(next) => setData((current) => ({ ...current, ...next }))} />
        );
    }
  }, [tab, data, unread, user, theme, setTheme, onSection, onUpgrade, onOpenUrl, showToast, setTab, load]);

  return (
    <>
    <aside className="ct-sheet show ct-settings" aria-label="Settings">
      <div className="ct-sheet-head ct-projdash-head">
        <div className="ct-projdash-title">
          <h2 ref={heading} tabIndex={-1}>Settings</h2>
          {data && (
            <div className="ct-projdash-facts">
              <span className="ct-badge tone-muted">{data.plan.name.toUpperCase()}</span>
              <span className="ct-hint">{user.email}</span>
            </div>
          )}
        </div>
        <button className="ct-btn-quiet" onClick={onClose}>Done</button>
      </div>

      <div className="ct-projtabs-wrap">
        <div className="ct-projtabs" role="tablist" aria-label="Settings sections"
          ref={tablist} onKeyDown={onTabKeyDown}>
          {SETTINGS_TABS.map((t) => (
            <button key={t.id} id={`settab-${t.id}`} role="tab"
              aria-selected={tab === t.id} aria-controls="settab-panel"
              tabIndex={tab === t.id ? 0 : -1}
              className={`ct-projtab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "notifications" && unread > 0 && <span className="st-tab-count">{unread}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="ct-sheet-body" id="settab-panel" role="tabpanel"
        aria-labelledby={`settab-${tab}`} tabIndex={-1}>
        {error && (
          <div className="mg-error">
            {error} <button className="ct-linkish" onClick={load}>Try again</button>
          </div>
        )}
        {!data && !error && <TabSkeleton rows={3} metrics />}
        {data && (
          <Suspense fallback={<TabSkeleton rows={3} metrics={tab === "usage"} />}>
            {body}
          </Suspense>
        )}
      </div>
    </aside>
    {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
    </>
  );
}
