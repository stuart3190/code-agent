// Phase 23: the desktop conversation panel's pure pieces — index.html rewriting for a
// VS Code webview (asset URIs, CSP, desktop-mode global) and the connect prompt.

import assert from "node:assert/strict";
import test from "node:test";

import { rewriteIndexHtml, connectHtml } from "../../editor/vscode/lib/conversationPanel.js";

const SAMPLE = `<!doctype html><html><head>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="manifest" href="/site.webmanifest" />
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-abc.css">
</head><body><div id="root"></div></body></html>`;

test("rewriteIndexHtml produces a webview-ready document in desktop mode", () => {
  const html = rewriteIndexHtml(SAMPLE, {
    assetBase: "https://file.vscode-resource.vscode-webview.net/ext/media/app",
    cspSource: "https://*.vscode-resource.vscode-webview.net",
    server: "https://app.thrallo.com/",
    token: "thrallo_pat_test123",
  });
  assert.ok(html.includes('src="https://file.vscode-resource.vscode-webview.net/ext/media/app/assets/index-abc.js"'));
  assert.ok(html.includes('href="https://file.vscode-resource.vscode-webview.net/ext/media/app/assets/index-abc.css"'));
  assert.ok(!html.includes('href="/favicon.svg"'), "favicon link removed");
  assert.ok(!html.includes("webmanifest"), "manifest link removed");
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("connect-src https: wss:"));
  const injected = html.match(/window\.__THRALLO_DESKTOP__=(\{[^<]+\});<\/script>/);
  assert.ok(injected, "desktop-mode global injected");
  const nonce = html.match(/<script nonce="([^"]+)">window\.__THRALLO_DESKTOP__/)?.[1];
  assert.ok(nonce, "inline bootstrap script carries a nonce");
  assert.ok(html.includes(`'nonce-${nonce}'`), "CSP script-src allows exactly that nonce");
  const desktop = JSON.parse(injected[1]);
  assert.equal(desktop.server, "https://app.thrallo.com", "trailing slash stripped");
  assert.equal(desktop.token, "thrallo_pat_test123");
  // The CSP/global must land before the app's module script executes.
  assert.ok(html.indexOf("__THRALLO_DESKTOP__") < html.indexOf("/assets/index-abc.js"));
});

test("rewriteIndexHtml escapes injection-hostile values", () => {
  const html = rewriteIndexHtml(SAMPLE, {
    assetBase: "https://x", cspSource: "https://x",
    server: "https://app.thrallo.com",
    token: "</script><script>alert(1)</script>",
  });
  assert.ok(!html.includes("</script><script>alert(1)"), "token cannot break out of the script tag");
});

test("connectHtml is a self-contained one-action page", () => {
  const html = connectHtml();
  assert.ok(html.includes("acquireVsCodeApi"));
  assert.ok(html.includes("Connect with API token"));
  assert.ok(!/src="http/.test(html), "no external resources");
});
