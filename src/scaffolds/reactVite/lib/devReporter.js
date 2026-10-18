// Dev-only runtime error reporter — the preview side of the shell's "Fix it" loop.
//
// When the app runs inside the Buildr101 preview iframe (vite dev), uncaught errors and
// unhandled promise rejections are posted to the parent shell, which shows a "Fix it"
// button that feeds the error back into the builder. Absent from production builds
// (import.meta.env.DEV guard) and inert when not iframed. Error text only — no app data.

if (import.meta.env.DEV && typeof window !== "undefined" && window.parent !== window) {
  // Preview apps are separate origins and may be framed by an arbitrary site. Only the
  // actual product shells (and their explicit local development ports) own this bridge.
  const shellOrigins = new Set([
    "https://app.thrallo.com", "https://buildr101.com",
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8787", "http://127.0.0.1:8787",
  ]);
  const trustedOrigin = (value) => {
    try { const origin = new URL(value).origin; return shellOrigins.has(origin) ? origin : null; }
    catch { return null; }
  };
  let parentOrigin = trustedOrigin(document.referrer)
    || trustedOrigin(window.location.ancestorOrigins?.[0]);
  const seen = new Set();
  let sent = 0;

  const report = (message, stack) => {
    if (!parentOrigin) return;
    const key = String(message).slice(0, 200);
    if (seen.has(key) || sent >= 5) return;
    seen.add(key);
    sent += 1;
    try {
      window.parent.postMessage(
        {
          __buildr: "runtime-error",
          message: String(message).slice(0, 500),
          stack: String(stack || "").slice(0, 2000),
        },
        parentOrigin
      );
    } catch {
      /* parent gone — nothing to do */
    }
  };

  window.addEventListener("error", (e) => {
    report(e.message || e.error?.message || "Unknown error", e.error?.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report((r && (r.message || String(r))) || "Unhandled promise rejection", r && r.stack);
  });

  // ── Visual edits: select-mode bridge ─────────────────────────────────────────────────────
  // The shell toggles select mode with { __buildr: "select-mode", on }. While on, hovering
  // outlines elements and a click (captured before the app's own handlers) posts the element
  // back as { __buildr: "element-selected", tag, text, outerHTML, path } and exits the mode.
  let selecting = false;
  let hoverEl = null;
  let hoverOutline = "";

  const clearHover = () => {
    if (hoverEl) { hoverEl.style.outline = hoverOutline; hoverEl = null; hoverOutline = ""; }
  };
  const exitSelect = () => { selecting = false; clearHover(); document.documentElement.style.cursor = ""; };

  // Short structural path (up to 5 ancestors) so the model can locate the element in source.
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5 && node.tagName !== "HTML") {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !shellOrigins.has(e.origin)) return;
    const d = e.data;
    if (!d || d.__buildr !== "select-mode") return;
    parentOrigin = e.origin;
    if (d.on) { selecting = true; document.documentElement.style.cursor = "crosshair"; }
    else exitSelect();
    // ACK so the shell can confirm the bridge is live in this preview (old trees lack it).
    try { window.parent.postMessage({ __buildr: "select-mode-ack", on: !!d.on }, parentOrigin); } catch {}
  });

  document.addEventListener("mouseover", (e) => {
    if (!selecting || !(e.target instanceof Element)) return;
    clearHover();
    hoverEl = e.target;
    hoverOutline = hoverEl.style.outline;
    hoverEl.style.outline = "2px solid #f59e0b";
  }, true);

  document.addEventListener("click", (e) => {
    if (!selecting || !(e.target instanceof Element)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    clearHover();
    // Inspect structure, never credentials or values typed into form controls. Work on a
    // detached clone so selecting an element cannot change the running application's data.
    const safe = el.cloneNode(true);
    const controls = [...(safe.matches("input,textarea,select") ? [safe] : []),
      ...safe.querySelectorAll("input,textarea,select")];
    for (const control of controls) {
      control.removeAttribute("value");
      if (control.tagName === "TEXTAREA") control.textContent = "";
      if (control.tagName === "SELECT") {
        for (const option of control.querySelectorAll("option")) option.removeAttribute("selected");
      }
    }
    try {
      window.parent.postMessage({
        __buildr: "element-selected",
        tag: el.tagName.toLowerCase(),
        text: (safe.textContent || "").trim().slice(0, 120),
        outerHTML: safe.outerHTML.slice(0, 600),
        path: cssPath(el),
      }, parentOrigin);
    } catch { /* parent gone */ }
    exitSelect();
  }, true);
}
