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
        "@fontsource-variable/manrope": "^5.2.8",
        "@fontsource-variable/space-grotesk": "^5.2.10",
        "@fontsource-variable/dm-sans": "^5.2.8",
        "@fontsource-variable/newsreader": "^5.2.8",
        "@fontsource-variable/sora": "^5.2.8",
        "@fontsource-variable/plus-jakarta-sans": "^5.2.8",
        "@radix-ui/react-checkbox": "^1.3.6",
        "@radix-ui/react-dialog": "^1.1.18",
        "@radix-ui/react-dropdown-menu": "^2.1.19",
        "@radix-ui/react-label": "^2.1.11",
        "@radix-ui/react-select": "^2.3.2",
        "@radix-ui/react-separator": "^1.1.11",
        "@radix-ui/react-slot": "^1.3.0",
        "@radix-ui/react-switch": "^1.3.2",
        "@radix-ui/react-tabs": "^1.1.16",
        "class-variance-authority": "^0.7.1",
        clsx: "^2.1.1",
        "lucide-react": "^1.23.0",
        "tailwind-merge": "^2.6.0",
        "tailwindcss-animate": "^1.0.7",
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

  "vite.config.js": `import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // Force ONE copy of React. Without this a mid-session dep re-optimize can split React and
    // ReactDOM across different optimize versions -> two React instances -> a null hooks
    // dispatcher ("Cannot read properties of null (reading 'useState')") in the dev preview.
    dedupe: ["react", "react-dom"],
  },
  // Pre-bundle the whole React set together on first start so a later re-optimize (triggered by
  // a newly-added dependency) never re-splits React across versions.
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  },
});
`,

  "tailwind.config.js": `import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
`,

  "postcss.config.js": `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`,

  "src/main.jsx": `import "./lib/devReporter.js";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "@fontsource-variable/manrope";
import "@fontsource-variable/space-grotesk";
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

/* Semantic design tokens — HSL triplets consumed as hsl(var(--x)) via tailwind.config.js
   (bg-background, text-foreground, text-muted-foreground, bg-primary, border-border, ...).
   Tune the VALUES to fit the app's character; keep the NAMES — utilities depend on them.
   Dark mode is class-based: add class="dark" on <html> or the root div and tune .dark. */
@layer base {
  :root {
    --font-sans: "Manrope Variable";
    --font-display: "Space Grotesk Variable";
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 221.2 83.2% 53.3%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 221.2 83.2% 53.3%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 217.2 91.2% 59.8%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 224.3 76.3% 48%;
  }

  * {
    @apply border-border;
  }
  html, body {
    /* Never let accidental overflow shift the layout and clip the right edge on phones.
       overflow-x:clip (not hidden) keeps position:sticky working. */
    overflow-x: clip;
  }
  body {
    @apply bg-background text-foreground font-sans antialiased;
  }
  img, video { max-width: 100%; }
  h1, h2, h3, h4 {
    @apply font-display tracking-tight;
  }
}
`,

  // The application shell — ROUTING AND LAYOUT ONLY, modular by construction. Generated apps
  // fill known-good slots (one route file per page under src/routes/, reusable interactions
  // under src/components/, persistence under src/data/) instead of inventing an architecture.
  // The 46.10-credit booking build concentrated five journeys in one 40KB App.jsx that every
  // stage re-read, rewrote and dragged through history; the modularity gate now rejects that
  // shape, and this shell is what makes the modular one the path of least resistance.
  "src/App.jsx": `// The application shell — routing, layout and error boundary ONLY.
//
// Feature code does not live here. One route = one file under src/routes/, registered in the
// ROUTES map below. Reusable interactions live under src/components/; persistence lives under
// src/data/ (never inside a React component); shared infrastructure under src/lib/. The build
// gates enforce this: App.jsx must stay small, and a stage that merges pages back into it does
// not go green.
import { Component, useEffect, useState } from "react";
import HomePage from "./routes/HomePage";

// One entry per route, one file per route. Add new pages as files and register them here.
const ROUTES = {
  "/": HomePage,
};

export function navigateTo(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname || "/");
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return ROUTES[path] ? path : "/";
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <p>Reload the page to try again.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const path = useRoute();
  const Page = ROUTES[path] || HomePage;
  return (
    <ErrorBoundary>
      <Page />
    </ErrorBoundary>
  );
}
`,

  "src/routes/HomePage.jsx": `// One route, one file. Replace this placeholder with the real home page; add further routes as
// their own files in this directory and register them in src/App.jsx's ROUTES map.
export default function HomePage() {
  return <main>{/* build here */}</main>;
}
`,

  // Thin backend SDK (auth / entities / storage) — the seam generated apps call.
  // Authored as real files under reactVite/lib/backend/ so the Node proof imports the
  // exact factory the app ships. App code uses `import { auth, db, storage } from "./lib/backend"`.
  "src/lib/backend/index.js": sdk("lib/backend/index.js"),
  "src/lib/backend/supabaseBackend.js": sdk("lib/backend/supabaseBackend.js"),

  // Anonymous visitor sessions — maintained, tested platform infrastructure. Generated apps
  // IMPORT ensureVisitorSession; they never write their own bootstrap (a 46.10-credit build spent
  // three in-stage repair rounds re-inventing this file badly). The honesty scan exempts exactly
  // this module and blocks local variants; the stage gate protects it from edits.
  "src/lib/visitorSession.js": sdk("lib/visitorSession.js"),

  // Headless capabilities (Builder v2, master plan Part 6): the supported implementations of
  // cross-app behaviour. Generated code IMPORTS these; the honesty scan, stage gate and patch
  // engine all treat src/lib/capabilities/ as protected platform infrastructure.
  "src/lib/capabilities/index.js": sdk("lib/capabilities/index.js"),
  "src/lib/capabilities/crud.js": sdk("lib/capabilities/crud.js"),
  "src/lib/capabilities/session.js": sdk("lib/capabilities/session.js"),
  "src/lib/capabilities/roles.js": sdk("lib/capabilities/roles.js"),
  "src/lib/capabilities/booking.js": sdk("lib/capabilities/booking.js"),
  "src/lib/capabilities/forms.js": sdk("lib/capabilities/forms.js"),

  // Asset helpers (Builder v2, master plan Part 18): picture/srcset/lazy/blur rendering
  // for the imagery the Asset Service resolves. Headless props-builders, no JSX.
  "src/lib/assets.js": sdk("lib/assets.js"),

  // Dev-only preview error reporter (the shell's "Fix it" loop). Fixed file, imported
  // first by main.jsx; absent from production builds via the import.meta.env.DEV guard.
  "src/lib/devReporter.js": sdk("lib/devReporter.js"),

  // shadcn/ui component set (JSX, tokens-aware) — authored as real files under
  // reactVite/components/ui/ and read into the tree, same pattern as the SDK.
  // The model composes standard UI from these via `@/components/ui/*` imports.
  "src/lib/utils.js": sdk("lib/utils.js"),
  "src/components/ui/badge.jsx": sdk("components/ui/badge.jsx"),
  "src/components/ui/button.jsx": sdk("components/ui/button.jsx"),
  "src/components/ui/card.jsx": sdk("components/ui/card.jsx"),
  "src/components/ui/checkbox.jsx": sdk("components/ui/checkbox.jsx"),
  "src/components/ui/dialog.jsx": sdk("components/ui/dialog.jsx"),
  "src/components/ui/dropdown-menu.jsx": sdk("components/ui/dropdown-menu.jsx"),
  "src/components/ui/input.jsx": sdk("components/ui/input.jsx"),
  "src/components/ui/label.jsx": sdk("components/ui/label.jsx"),
  "src/components/ui/select.jsx": sdk("components/ui/select.jsx"),
  "src/components/ui/separator.jsx": sdk("components/ui/separator.jsx"),
  "src/components/ui/switch.jsx": sdk("components/ui/switch.jsx"),
  "src/components/ui/table.jsx": sdk("components/ui/table.jsx"),
  "src/components/ui/tabs.jsx": sdk("components/ui/tabs.jsx"),
  "src/components/ui/textarea.jsx": sdk("components/ui/textarea.jsx"),

  ".env.example": `# Backend SDK config — copy to .env (gitignored). The anon key is the PUBLIC
# browser key (safe to ship); never put the service_role key here.
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_APP_ID=
VITE_AUTH_URL=
VITE_PAYMENTS_URL=
VITE_ACTIONS_URL=
VITE_RUNTIME_URL=
VITE_ANALYTICS_URL=
`,
};
