// Loading, empty and error, for every tab in the project dashboard.
//
// These existed six different ways. Analytics, Health and Deployments each rendered their own
// "Loading…" card; Logs had one only for its Load-older button; Domains and Settings had none at
// all, so Domains showed an empty section while it was still fetching — a loading state that looks
// exactly like "you have no domains". Errors were `mg-error` with raw text, and only two of the six
// offered a way to try again.
//
// One set now, so a customer moving between tabs meets the same three shapes rather than six
// dialects of the same three ideas.

import React from "react";

/**
 * The shape of the content that is coming, not a spinner.
 *
 * A skeleton says "this is a list of cards" while it loads; a spinner says "wait". Reuses the sheen
 * the project cards already use, which stops under prefers-reduced-motion via the global rule in
 * chat.css.
 */
export function TabSkeleton({ rows = 3, metrics = false, label = "Loading" }) {
  return (
    <div className="ct-tabstate ct-skel" role="status" aria-label={label} aria-busy="true">
      {metrics && (
        <div className="ct-metrics" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <span className="mg-skel-line" style={{ width: 48, height: 20 }} />
              <span className="mg-skel-line" style={{ width: 72, marginTop: 6 }} />
            </div>
          ))}
        </div>
      )}
      {Array.from({ length: rows }, (_, i) => (
        <div className="mg-card ct-tabskel-row" key={i} aria-hidden="true">
          <span className="mg-skel-line" style={{ width: `${58 - i * 9}%` }} />
          <span className="mg-skel-line" style={{ width: `${38 + i * 7}%`, height: 10 }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Nothing here yet — and what to do about it.
 *
 * An empty state without a next step is a dead end, so `action` is encouraged rather than optional
 * in spirit. The title says what is absent; the body says why, in the customer's terms.
 */
export function TabEmpty({ title, children = null, action = null, icon = null }) {
  return (
    <div className="ct-tabstate ct-tabempty">
      {icon && <span className="ct-tabempty-icon" aria-hidden="true">{icon}</span>}
      <strong>{title}</strong>
      {children && <span className="ct-hint">{children}</span>}
      {action}
    </div>
  );
}

/**
 * Something went wrong — said plainly, with a way out.
 *
 * Always offers a retry when one is possible. An error a customer can only stare at is the same
 * dead end as an empty state with no next step, and this is the surface where "we could not find
 * out" must never be mistaken for "there is nothing here".
 */
export function TabError({ message, onRetry = null, children = null }) {
  // Deliberately NOT the shape for an action that failed. "Your domains could not be loaded"
  // replaces the whole panel because there is nothing else to show; "that rollback did not work"
  // belongs beside the button that was pressed, where `mg-error` still lives. Replacing the panel
  // for a failed action would throw away the list the user is still looking at.
  return (
    <div className="ct-tabstate ct-taberror" role="alert">
      <strong>{message || "That could not be loaded."}</strong>
      {children && <span className="ct-hint">{children}</span>}
      {onRetry && (
        <button className="ct-btn-quiet" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}
