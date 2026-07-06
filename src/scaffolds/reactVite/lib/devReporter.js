// Dev-only runtime error reporter — the preview side of the shell's "Fix it" loop.
//
// When the app runs inside the Buildr101 preview iframe (vite dev), uncaught errors and
// unhandled promise rejections are posted to the parent shell, which shows a "Fix it"
// button that feeds the error back into the builder. Absent from production builds
// (import.meta.env.DEV guard) and inert when not iframed. Error text only — no app data.

if (import.meta.env.DEV && typeof window !== "undefined" && window.parent !== window) {
  const seen = new Set();
  let sent = 0;

  const report = (message, stack) => {
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
        "*"
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
}
