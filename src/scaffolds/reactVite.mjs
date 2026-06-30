// The target scaffold the generated/edited apps live in: a minimal Vite + React +
// Tailwind client app with a thin, swappable backend SDK (auth / entities / storage).
// The model writes its app into this fixed file tree.
// Real enough that `npm install && npm run build` works once App.jsx is implemented.
//
// Graduated from codex-oauth-spike/lib/scaffold.mjs (export renamed SCAFFOLD ->
// REACT_VITE so multiple scaffolds can coexist later). Phase 3: the backend SDK files
// under reactVite/lib/backend/ are authored as REAL files (single source of truth — the
// Node proof imports the same factory the app ships) and read into the tree here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sdk = (rel) => readFileSync(path.join(HERE, "reactVite", rel), "utf8");

export const REACT_VITE = {
  "package.json": JSON.stringify(
    {
      name: "generated-app",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "@supabase/supabase-js": "^2.45.4",
      },
      devDependencies: {
        "@vitejs/plugin-react": "^4.3.1",
        autoprefixer: "^10.4.20",
        postcss: "^8.4.47",
        tailwindcss: "^3.4.13",
        vite: "^5.4.8",
      },
    },
    null,
    2
  ),

  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Generated App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,

  "vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ plugins: [react()] });
`,

  "tailwind.config.js": `export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: { extend: {} },
  plugins: [],
};
`,

  "postcss.config.js": `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`,

  "src/main.jsx": `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,

  "src/index.css": `@tailwind base;
@tailwind components;
@tailwind utilities;
`,

  "src/App.jsx": `export default function App() {
  return <div>{/* build here */}</div>;
}
`,

  // Thin backend SDK (auth / entities / storage) — the seam generated apps call.
  // Authored as real files under reactVite/lib/backend/ so the Node proof imports the
  // exact factory the app ships. App code uses `import { auth, db, storage } from "./lib/backend"`.
  "src/lib/backend/index.js": sdk("lib/backend/index.js"),
  "src/lib/backend/supabaseBackend.js": sdk("lib/backend/supabaseBackend.js"),

  ".env.example": `# Backend SDK config — copy to .env (gitignored). The anon key is the PUBLIC
# browser key (safe to ship); never put the service_role key here.
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
`,
};
