// PWA assets for published apps — every publish ships a manifest, per-app icons and a service
// worker, so the published site installs like a real app (Android WebAPK / iOS Add to Home
// Screen). PUBLISH-ONLY by construction: nothing here touches the scaffold or withRuntimeEnv,
// so previews never register a service worker (SW caching would fight iteration).
//
// Two exports, mirroring the runtimeEnv pattern:
//   withPwaAssets(tree, { appName })    pure tree transform — manifest + sw.js under public/
//                                       (Vite copies public/* verbatim into dist/) + index.html
//                                       tags & registration. UTF-8 text only — trees can't carry
//                                       binaries (flushDir writes utf8).
//   renderIcons({ appName, distDir })   AFTER the build: letter-tile PNGs written straight into
//                                       dist/icons/ (the dist read is binary-safe). Rendered by
//                                       headless Chrome — zenika/alpine-chrome docker on the VPS
//                                       (same image the social poster uses), Edge headless on the
//                                       Windows dev box. FAIL-SOFT: a publish never blocks on
//                                       icons; install quality degrades, the site does not.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { glyphPath } from "./iconGlyphs.mjs";

// shadcn-style token: "--primary: 222 47% 40%;" (space or comma separated) -> hex.
function tokenToHex(css, name, fallback) {
  const m = String(css || "").match(new RegExp(`--${name}\\s*:\\s*([\\d.]+)[,\\s]+([\\d.]+)%[,\\s]+([\\d.]+)%`));
  if (!m) return fallback;
  return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = (v) => Math.round(255 * v).toString(16).padStart(2, "0");
  return `#${to255(f(0))}${to255(f(8))}${to255(f(4))}`;
}
function tokenLightness(css, name, fallback) {
  const m = String(css || "").match(new RegExp(`--${name}\\s*:\\s*([\\d.]+)[,\\s]+([\\d.]+)%[,\\s]+([\\d.]+)%`));
  return m ? Number(m[3]) : fallback;
}

const cleanName = (appName) => String(appName || "My app").trim().slice(0, 45) || "My app";

export function pwaColors(tree, appName) {
  const css = tree["src/index.css"];
  return {
    name: cleanName(appName),
    themeColor: tokenToHex(css, "primary", "#0a0c0f"),
    backgroundColor: tokenToHex(css, "background", "#ffffff"),
    // letter contrast: light primaries get an ink letter, everything else white
    letterColor: tokenLightness(css, "primary", 40) > 62 ? "#111318" : "#ffffff",
  };
}

export function withPwaAssets(tree, { appName } = {}) {
  const html = tree["index.html"];
  if (typeof html !== "string") return tree; // nothing to hook into — leave the tree alone

  const { name, themeColor, backgroundColor } = pwaColors(tree, appName);
  const short = name.length > 12 ? name.slice(0, 12).trim() : name;

  const manifest = JSON.stringify({
    name,
    short_name: short,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: backgroundColor,
    theme_color: themeColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2);

  // Navigations network-first (a republish is visible on next load), hashed assets cache-first,
  // versioned cache torn down on activate. The version stamp makes every publish a new SW.
  const sw = `// Buildr101 service worker — generated at publish time
const CACHE = "app-${Date.now()}";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add("/")).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // network-first: fresh app when online, cached shell when not
    e.respondWith(fetch(req)
      .then((res) => { caches.open(CACHE).then((c) => c.put("/", res.clone())); return res; })
      .catch(() => caches.match("/")));
    return;
  }
  // static assets: cache-first (Vite filenames are content-hashed — safe forever)
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
    return res;
  })));
});
`;

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const headTags = `    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="${themeColor}" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <!-- Safety net: stop any accidental horizontal overflow from shifting the app and clipping the
         right edge on phones (overflow-x:clip doesn't break sticky, unlike hidden). -->
    <style>html,body{overflow-x:clip}img,video{max-width:100%}</style>
    <script>
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
      }
    </script>
  </head>`;

  let out = html.replace(/<\/head>/, headTags);
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${esc(name)}</title>`);

  return {
    ...tree,
    "index.html": out,
    "public/manifest.webmanifest": manifest,
    "public/sw.js": sw,
  };
}

// Darken a #rrggbb toward black by `f` (0..1) — for the icon's background gradient.
function darken(hex, f = 0.4) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  if (!m) return "#0a0c0f";
  const c = [1, 2, 3].map((i) => Math.round(parseInt(m[i], 16) * (1 - f)));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ── icons: a line glyph (or a letter fallback) white on the app's brand-colour gradient,
//    written into the BUILT dist. Glyph stays in the centre ~54% — safe for maskable crops.
function iconHtml({ glyph, letter, bg, fg }) {
  const g2 = darken(bg, 0.45);
  const mark = glyph
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"
         stroke-linejoin="round" style="width:54vw;height:54vh">${glyph}</svg>`
    : `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-weight:700;font-size:52vh;line-height:1;color:${fg}">${letter}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; }
  body { width:100vw; height:100vh; display:grid; place-items:center; overflow:hidden;
    background:radial-gradient(120% 120% at 30% 20%, ${bg}, ${g2}); }
</style></head><body>${mark}</body></html>`;
}

function chromeRenderer() {
  if (process.platform !== "win32") {
    return (htmlPath, outPath, size) => execFileSync("docker", [
      "run", "--rm", "-v", `${path.dirname(htmlPath)}:/render`, "zenika/alpine-chrome:latest",
      "--headless", "--no-sandbox", "--disable-gpu", `--window-size=${size},${size}`,
      `--screenshot=/render/${path.basename(outPath)}`, "--virtual-time-budget=2500",
      `file:///render/${path.basename(htmlPath)}`,
    ], { stdio: "pipe" });
  }
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  if (!existsSync(edge)) throw new Error("no headless renderer available");
  return (htmlPath, outPath, size) => execFileSync(edge, [
    "--headless", "--disable-gpu", `--window-size=${size},${size}`,
    `--screenshot=${outPath}`, "--virtual-time-budget=2500",
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ], { stdio: "pipe" });
}

export async function renderIcons({ appName, tree, distDir, iconGlyph = null, log = () => {} }) {
  const { name, themeColor, letterColor } = pwaColors(tree, appName);
  const letter = (name.match(/[a-zA-Z0-9]/) || ["A"])[0].toUpperCase();
  const glyph = iconGlyph ? glyphPath(iconGlyph) : null;
  const work = path.join(os.tmpdir(), `buildr-icons-${Date.now()}`);
  try {
    const render = chromeRenderer();
    await mkdir(work, { recursive: true });
    await mkdir(path.join(distDir, "icons"), { recursive: true });
    const htmlPath = path.join(work, "icon.html");
    await writeFile(htmlPath, iconHtml({ glyph, letter, bg: themeColor, fg: letterColor }), "utf8");
    for (const [size, file] of [[512, "icon-512.png"], [192, "icon-192.png"], [180, "apple-touch-icon.png"]]) {
      const tmpOut = path.join(work, file);
      render(htmlPath, tmpOut, size);
      await copyFile(tmpOut, path.join(distDir, "icons", file));
    }
    log(`pwa: icons rendered (${glyph ? iconGlyph : `"${letter}"`} on ${themeColor})`);
  } catch (e) {
    // Never block a publish on icons — the site is fine, the install prompt just degrades.
    log(`pwa: icon render skipped (${String(e.message || e).slice(0, 120)})`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
