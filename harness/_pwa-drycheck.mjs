// Offline dry check for withPwaAssets — no network, no build, no spend.
//   node harness/_pwa-drycheck.mjs
import { withPwaAssets } from "../shell/server/lib/pwa.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";

const tree = clone(fromScaffold(REACT_VITE));
tree["src/index.css"] = ":root { --background: 0 0% 100%; --primary: 24 95% 47%; }";
const out = withPwaAssets(tree, { appName: "Iron & Oak Barber Co" });
const m = JSON.parse(out["public/manifest.webmanifest"]);

const checks = [
  ["manifest name", m.name === "Iron & Oak Barber Co"],
  ["short_name <= 12 chars", m.short_name.length <= 12],
  ["theme colour parsed from --primary", /^#[0-9a-f]{6}$/.test(m.theme_color) && m.theme_color !== "#0a0c0f"],
  ["background from --background", m.background_color === "#ffffff"],
  ["3 icon entries incl. maskable", m.icons.length === 3 && m.icons[2].purpose === "maskable"],
  ["sw.js present + versioned", /const CACHE = "app-\d+"/.test(out["public/sw.js"])],
  ["html: manifest link", out["index.html"].includes('rel="manifest"')],
  ["html: theme-color meta", out["index.html"].includes('name="theme-color"')],
  ["html: apple-touch-icon", out["index.html"].includes("apple-touch-icon")],
  ["html: SW registration", out["index.html"].includes("serviceWorker.register")],
  ["html: horizontal-overflow guard", out["index.html"].includes("overflow-x:clip")],
  ["html: title swapped + escaped", out["index.html"].includes("<title>Iron &amp; Oak Barber Co</title>")],
  ["input tree untouched (pure)", !tree["public/sw.js"] && !tree["index.html"].includes("manifest")],
];

let fails = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) fails++; }
console.log(`theme_color = ${m.theme_color}`);
process.exit(fails ? 1 : 0);
