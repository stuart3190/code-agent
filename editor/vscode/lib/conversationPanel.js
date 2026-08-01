// The Thrallo Desktop conversation surface (Phase 23): a webview hosting the SAME built
// web bundle the product ships at app.thrallo.com (copied into media/app at desktop
// bootstrap). The bundle runs in "desktop mode" — window.__THRALLO_DESKTOP__ carries the
// server + the user's PAT, so auth and API base come from the editor connection, not
// browser Supabase auth. vscode-free and unit-tested: the HTML rewriting is pure.

"use strict";

// Rewrite the built index.html for a VS Code webview: absolute /assets/ URLs become
// webview resource URIs, favicon/manifest links (dead in a webview) are dropped, and a
// strict CSP plus the desktop-mode global are injected at the top of <head>.
function rewriteIndexHtml(html, { assetBase, cspSource, server, token, email = null, version = null }) {
  // `version` is the PACKAGED extension version. The bundled web app compares it against the
  // release manifest so a desktop copy left behind by a web deploy can say so, rather than
  // silently running an old build — the exact state the 2026-08-01 audit found it in.
  const desktop = { server: String(server || "").replace(/\/+$/, ""), token, email, version };
  // The bootstrap global is an INLINE script — CSP requires a nonce for it (resource
  // sources only cover the bundle's own files).
  const nonce = require("node:crypto").randomBytes(16).toString("base64url");
  const inject = `<script nonce="${nonce}">window.__THRALLO_DESKTOP__=${JSON.stringify(desktop).replace(/</g, "\\u003c")};</script>`;
  const csp = [
    "default-src 'none'",
    `script-src ${cspSource} 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} https: data:`,
    "connect-src https: wss:",
    "frame-src https:",
  ].join("; ");
  return String(html)
    .replace(/<link[^>]+rel="(?:icon|manifest|apple-touch-icon)"[^>]*>\s*/g, "")
    .replace(/(src|href)="\/((?:assets|design)\/[^"]+)"/g, (_, attr, rel) => `${attr}="${assetBase}/${rel}"`)
    .replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${csp}">${inject}`);
}

// The connect prompt shown when no PAT is stored yet — one action, no chrome.
function connectHtml() {
  return `<!doctype html><html><body style="display:grid;place-items:center;height:100vh;margin:0;font-family:system-ui;background:#fafaf8;color:#1b1826">
  <div style="text-align:center;max-width:340px">
    <div style="font-size:22px;font-weight:600;margin-bottom:10px">Connect Thrallo</div>
    <div style="color:#5f5b6b;font-size:14px;line-height:1.6;margin-bottom:18px">Paste an API token once and your team lives right here in the editor.</div>
    <button id="connect" style="background:#6a5ae0;color:#fff;border:0;border-radius:12px;padding:10px 22px;font-weight:700;font-size:14px;cursor:pointer">Connect with API token</button>
  </div>
  <script>const v=acquireVsCodeApi();document.getElementById("connect").onclick=()=>v.postMessage({type:"connect"});</script>
  </body></html>`;
}

module.exports = { rewriteIndexHtml, connectHtml };
