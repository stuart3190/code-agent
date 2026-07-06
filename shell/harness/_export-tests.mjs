import assert from "node:assert/strict";
import {
  SAFE_ENV_EXAMPLE,
  _internal,
  assembleExportTree,
  assertNoPlatformSecrets,
  createStoredZip,
  readStoredZip
} from "../server/lib/exportProject.mjs";

const project = {
  id: "proj_export_test",
  name: "Sample Export App",
  history: [
    { prompt: "Build a calm task tracker with tags and Supabase persistence." },
    { prompt: "Add a dashboard summary and make the filters easier to scan." }
  ],
  tree: {
    "package.json": JSON.stringify({
      name: "sample-export-app",
      scripts: { lint: "echo ok" },
      dependencies: { "lucide-react": "^0.468.0" }
    }),
    "src/App.jsx": `import { db } from "./lib/backend";

export default function App() {
  return <main className="p-6">Export smoke app</main>;
}
`,
    "src/features/filters.js": "export const filters = ['today', 'tagged'];\n",
    ".env.example": "SUPABASE_SERVICE_ROLE=do-not-ship\nSTRIPE_SECRET_KEY=sk_test_bad\n",
    ".env": "STRIPE_SECRET_KEY=sk_test_bad\n",
    ".env.local": "BYOK_ENC_KEY=bad\n",
    "secret.key": "CLOUDFLARE_API_TOKEN=bad\n",
    "node_modules/pkg/index.js": "nope\n",
    "dist/assets/app.js": "nope\n",
    "../escape.txt": "nope\n",
    "/absolute.txt": "nope\n",
    "server/platform.js": "nope\n",
    "shell/server/index.mjs": "nope\n"
  }
};

function has(path, files) {
  assert.ok(files[path], `expected ${path} in export`);
}

function missing(path, files) {
  assert.equal(Object.hasOwn(files, path), false, `expected ${path} to be excluded`);
}

const { files, filename } = assembleExportTree(project);

assert.equal(filename, "sample-export-app.zip");

for (const path of [
  "README.txt",
  ".gitignore",
  ".env.example",
  "package.json",
  "index.html",
  "vite.config.js",
  "tailwind.config.js",
  "postcss.config.js",
  "src/main.jsx",
  "src/index.css",
  "src/App.jsx",
  "src/lib/backend/index.js",
  "src/lib/backend/supabaseBackend.js"
]) {
  has(path, files);
}

for (const path of [
  ".env",
  ".env.local",
  "secret.key",
  "node_modules/pkg/index.js",
  "dist/assets/app.js",
  "../escape.txt",
  "/absolute.txt",
  "server/platform.js",
  "shell/server/index.mjs"
]) {
  missing(path, files);
}

assert.equal(files[".env.example"], SAFE_ENV_EXAMPLE);
for (const marker of _internal.REQUIRED_SECRET_MARKERS) {
  assert.equal(files[".env.example"].includes(marker), false, `.env.example leaked ${marker}`);
}

const pkg = JSON.parse(files["package.json"]);
assert.equal(pkg.private, true);
assert.equal(pkg.type, "module");
assert.equal(pkg.scripts.dev, "vite");
assert.equal(pkg.scripts.build, "vite build");
assert.equal(pkg.scripts.preview, "vite preview");
assert.equal(pkg.scripts.lint, "echo ok");
assert.ok(pkg.dependencies.react, "react dependency missing");
assert.ok(pkg.dependencies["react-dom"], "react-dom dependency missing");
assert.ok(pkg.dependencies["@supabase/supabase-js"], "supabase dependency missing");
assert.ok(pkg.devDependencies.vite, "vite dependency missing");
assert.ok(pkg.devDependencies["@vitejs/plugin-react"], "vite react plugin missing");

const readme = files["README.txt"];
assert.equal(Object.hasOwn(files, "README.md"), false, "README should be plain-text .txt, not .md");
assert.match(readme, /npm install/);
assert.match(readme, /npm run dev/);
assert.match(readme, /npm run build/);
assert.match(readme, /Before You Start/);
assert.match(readme, /RUN THE APP ON YOUR COMPUTER/);
assert.match(readme, /node -v/);
assert.match(readme, /copy \.env\.example \.env/);
assert.match(readme, /Ctrl \+ C/);
assert.match(readme, /COMMON PROBLEMS/);
assert.match(readme, /\.env\.example/);
assert.match(readme, /Vercel/);
assert.match(readme, /Netlify/);
// Beginner-facing plain text: no markdown code fences or heading hashes that would render
// as noise when the file is opened in Notepad / TextEdit.
assert.equal(readme.includes("```"), false, "README.txt must not contain markdown code fences");
assert.equal(/^#/m.test(readme), false, "README.txt must not contain markdown headings");
assert.match(files[".gitignore"], /^node_modules\//m);
assert.match(files[".gitignore"], /^dist\//m);
assert.match(files[".gitignore"], /^\.env$/m);

assertNoPlatformSecrets(files);

const zip = createStoredZip(files, new Date("2026-01-01T00:00:00Z"));
const entries = readStoredZip(zip);
assert.deepEqual(Object.keys(entries), Object.keys(files));
assert.equal(entries["README.txt"], files["README.txt"]);
assert.equal(entries["src/App.jsx"], files["src/App.jsx"]);
assertNoPlatformSecrets(entries);

console.log(`export tests passed (${Object.keys(files).length} files, ${zip.length} bytes)`);
