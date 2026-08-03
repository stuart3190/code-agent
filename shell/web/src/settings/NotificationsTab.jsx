// Settings → Notifications.
//
// Thrallo's own notification history: publishes, custom domains, health, billing. Until this
// existed, every one of these was fire-and-forget — pushed to a browser that may not have been
// open and an inbox that may not have been read, and then gone. A customer asleep when their
// custom domain stopped working had no way to find out it ever had.
//
// This is NOT the notification list inside the apps customers build. Those belong to their end
// users, live in `app_notifications`, and are a different stream for a different audience.

import React, { useEffect, useState } from "react";
import { listNotifications, markNotificationsRead, notificationsConfig, subscribeNotifications } from "../lib/codeAgentApi.js";
import { SkeletonRows } from "../manage/shared.jsx";
import { relativeTime } from "../publish/publishLifecycle.js";

const SOURCE = {
  publish: { label: "Deploy", tone: "live" },
  domain: { label: "Domain", tone: "update" },
  health: { label: "Health", tone: "muted" },
  billing: { label: "Billing", tone: "muted" },
  thrallo: { label: "Thrallo", tone: "muted" },
};

export default function NotificationsTab({ channels, unread, onUnread, onOpenUrl }) {
  const [items, setItems] = useState(null);   // null = loading
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listNotifications()
      .then((r) => { if (live) { setItems(r.items || []); onUnread(r.unread); } })
      .catch((e) => { if (live) { setError(e.message); setItems(null); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const read = async (patch) => {
    setBusy(true);
    try {
      const result = await markNotificationsRead(patch);
      onUnread(result.unread);
      setItems((current) => (current || []).map((n) => (
        patch.all || n.id === patch.id ? { ...n, read: true } : n
      )));
    } catch (e) {
      setError(e.message || "That did not work.");
    } finally { setBusy(false); }
  };

  return (
    <div className="st-tab">
      <div className="st-headline">
        <div>
          <div className="st-headline-plan">
            Notifications
            {unread > 0 && <span className="st-unread-pill">{unread} unread</span>}
          </div>
          <div className="ct-hint">Everything Thrallo has told you about this account.</div>
        </div>
        {unread > 0 && (
          <button className="ct-btn-quiet" disabled={busy} onClick={() => read({ all: true })}>
            Mark all read
          </button>
        )}
      </div>

      {error && <div className="mg-error">{error}</div>}

      <div className="st-section">
        {items === null && !error && <SkeletonRows rows={3} />}
        {items !== null && !items.length && (
          <div className="st-empty">
            Nothing yet. Thrallo writes here when something happens to your account — a deploy
            finishing, a custom domain going live or stopping, a site going offline.
          </div>
        )}
        <div className="st-rows">
          {(items || []).map((n) => {
            const source = SOURCE[n.source] || SOURCE.thrallo;
            return (
              <div className={`st-row st-notif ${n.read ? "" : "is-unread"}`} key={n.id}>
                <div className="st-notif-meta">
                  <div className="st-notif-head">
                    {!n.read && <span className="st-notif-dot" aria-label="Unread" />}
                    <span className={`ct-badge tone-${source.tone}`}>{source.label}</span>
                    <b>{n.title}</b>
                  </div>
                  {n.body && <div className="ct-hint">{n.body}</div>}
                  <div className="ct-hint">{relativeTime(n.createdAt) || ""}</div>
                </div>
                <div className="st-token-actions">
                  {n.url && (
                    <button className="ct-btn-quiet" onClick={() => onOpenUrl(n.url)}>Open</button>
                  )}
                  {!n.read && (
                    <button className="ct-btn-quiet" disabled={busy} onClick={() => read({ id: n.id })}>
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="st-section">
        <h3>How you are told</h3>
        <p className="ct-hint st-note">
          The history above always exists. These are the extra ways Thrallo can reach you when you
          are away — when the conversation is open, the thread itself is the notification and
          nothing else fires.
        </p>
        <PushRow available={!!channels?.webpush} />
        <div className="st-row">
          <div>
            Email
            <div className="ct-hint">
              {channels?.email
                ? "Sent to the address on this account."
                : "Not configured on this deployment."}
            </div>
          </div>
          <span className="ct-hint">{channels?.email ? "On" : "Unavailable"}</span>
        </div>
      </div>
    </div>
  );
}

// Browser notifications need a user gesture and a permission prompt, so this stays a control the
// customer presses rather than something Settings can switch on for them.
function PushRow({ available }) {
  const supported = "serviceWorker" in navigator && "PushManager" in window;
  const [state, setState] = useState("idle");   // idle | on | busy | unavailable | denied

  useEffect(() => {
    if (!supported || !available) { setState("unavailable"); return; }
    navigator.serviceWorker.getRegistration()
      .then(async (reg) => { if (await reg?.pushManager?.getSubscription()) setState("on"); })
      .catch(() => {});
  }, [supported, available]);

  const enable = async () => {
    setState("busy");
    try {
      const config = await notificationsConfig();
      if (!config.vapidPublicKey) { setState("unavailable"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      // Denied is not the same as "not set up": the browser will not ask again, so telling someone
      // to press Enable a second time would send them round a loop that cannot end.
      if (permission === "denied") { setState("denied"); return; }
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

  const TEXT = {
    on: "This browser will show a notification when something needs you.",
    denied: "This browser has blocked notifications for Thrallo. Allow them in your browser's site settings, then reload.",
    unavailable: "Not available in this browser.",
    busy: "Asking your browser…",
    idle: "Previews ready, questions, and finished work.",
  };

  return (
    <div className="st-row">
      <div>
        Browser notifications
        <div className="ct-hint">{TEXT[state]}</div>
      </div>
      {state === "on"
        ? <span className="ct-hint" style={{ color: "var(--good)", fontWeight: 700 }}>On</span>
        : state === "unavailable" || state === "denied"
          ? <span className="ct-hint">Off</span>
          : <button className="ct-btn-quiet" disabled={state === "busy"} onClick={enable}>
              {state === "busy" ? "Enabling…" : "Enable"}
            </button>}
    </div>
  );
}
