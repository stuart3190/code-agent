// The target scaffold the generated/edited apps live in: a minimal Vite + React +
// Tailwind client app. The model writes its app into this fixed file tree.
// Real enough that `npm install && npm run build` works once App.jsx is implemented.
//
// Graduated verbatim from codex-oauth-spike/lib/scaffold.mjs (export renamed
// SCAFFOLD -> REACT_VITE so multiple scaffolds can coexist later).

export const REACT_VITE = {
  "package.json": JSON.stringify(
    {
      name: "generated-app",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
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
};
