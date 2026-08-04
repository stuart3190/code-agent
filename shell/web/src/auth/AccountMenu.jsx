// The account menu.
//
// Signing out used to live in Settings → Preferences, three clicks and a tab away from anywhere.
// Logging out is a standard account action and people look for it in exactly one place: the avatar
// in the corner. It is here, on the header that every authenticated screen renders, so it is
// reachable from the dashboard, a conversation, the project dashboard, Settings and History alike.
//
// The menu is a real menu: `aria-haspopup`, arrow keys, Escape, click-away, and focus returned to
// the avatar on close. It carries the destinations someone actually goes looking for on an avatar —
// Settings, History — so it is useful rather than a single-item dropdown wrapped around a button.

import React, { useEffect, useRef, useState } from "react";

export default function AccountMenu({ email, initial, desktop = false, onSettings, onHistory, onSignOut }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const menu = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        // Stopped here: the sheets behind also close on Escape, and dismissing a menu should not
        // also close the screen underneath it.
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll("[role='menuitem']") || [])];
        if (!items.length) return;
        const at = items.indexOf(document.activeElement);
        const next = event.key === "ArrowDown"
          ? items[(at + 1 + items.length) % items.length]
          : items[(at - 1 + items.length) % items.length];
        next?.focus();
      }
    };
    const onAway = (event) => {
      if (menu.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onAway);
    // Focus the first item, so the menu is usable from the keyboard the moment it opens.
    requestAnimationFrame(() => menu.current?.querySelector("[role='menuitem']")?.focus());
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onAway);
    };
  }, [open]);

  const choose = (run) => () => { setOpen(false); run?.(); };

  return (
    <div className="ct-account">
      <button ref={trigger} className="ct-avatar" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Account — ${email || "signed in"}`} title="Account"
        onClick={() => setOpen((v) => !v)}>
        {initial}
      </button>
      {open && (
        <div className="ct-account-menu" role="menu" ref={menu} aria-label="Account">
          <div className="ct-account-who">
            <span className="ct-account-email">{email}</span>
            {desktop && <span className="ct-hint">Connected with an API token</span>}
          </div>
          <button role="menuitem" className="ct-account-item" onClick={choose(onSettings)}>Settings</button>
          <button role="menuitem" className="ct-account-item" onClick={choose(onHistory)}>History</button>
          {/* Desktop sessions are an injected API token, not a browser session — there is nothing
              here to sign out OF, and offering it would be a button that cannot work. */}
          {!desktop && (
            <button role="menuitem" className="ct-account-item ct-account-signout" onClick={choose(onSignOut)}>
              Log out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
