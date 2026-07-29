import assert from "node:assert/strict";
import {
  DESIGN_FAMILY_IDS,
  auditDesign,
  fallbackDesignProfile,
  normalizeDesignProfile,
  parseDesignProfile,
  renderDesignBrief,
} from "../src/design/designProfile.mjs";
import { clone, fromScaffold } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps } from "./workspace.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

check("deterministic selection still varies across projects", () => {
  const families = new Set(Array.from({ length: 30 }, (_, i) =>
    fallbackDesignProfile({ prompt: "premium studio website", projectId: `project-${i}`, style: { preset: "auto" } }).family));
  assert.ok(families.size >= 3, `expected at least 3 families, got ${[...families].join(", ")}`);
});

check("public websites and SaaS get imagery while pure utilities may stay product-led", () => {
  const site = fallbackDesignProfile({ prompt: "a boutique hotel website", projectId: "hotel" });
  const app = fallbackDesignProfile({ prompt: "a SaaS analytics dashboard", projectId: "analytics" });
  const utility = fallbackDesignProfile({ prompt: "a mortgage calculator utility", projectId: "calculator" });
  assert.equal(site.imagery.required, true);
  assert.equal(app.imagery.required, true);
  assert.equal(utility.imagery.required, false);
});

check("invalid model output normalises to an allowed profile", () => {
  const profile = normalizeDesignProfile({ category: "unknown", family: "made-up", fontPair: "remote-cdn" }, {
    prompt: "appointment planner", projectId: "planner", style: { preset: "clean-saas" },
  });
  assert.ok(DESIGN_FAMILY_IDS.includes(profile.family));
  assert.match(profile.typography.bodyPackage, /^@fontsource-variable\//);
  assert.equal(profile.preset, "clean-saas");
});

check("director JSON parser accepts fenced JSON and rejects unsafe choices", () => {
  const profile = parseDesignProfile('```json\n{"category":"content","family":"editorial-magazine","fontPair":"newsreader-dm","concept":"quiet journal"}\n```', {
    prompt: "travel journal", projectId: "journal",
  });
  assert.equal(profile.family, "editorial-magazine");
  assert.equal(profile.typography.displayFamily, "Newsreader Variable");
});

check("rendered brief contains approved photography and font variables", () => {
  const profile = fallbackDesignProfile({ prompt: "restaurant website", projectId: "restaurant" });
  const brief = renderDesignBrief(profile, [{ url: "https://images.example/one.jpg", alt: "Dining room" }]);
  assert.match(brief, /--font-sans/);
  assert.match(brief, /https:\/\/images\.example\/one\.jpg/);
});

check("audit passes a responsive, rethemed build using selected fonts and photos", () => {
  const profile = fallbackDesignProfile({ prompt: "architecture studio website", projectId: "studio" });
  const assets = [1, 2, 3].map((n) => ({ url: `https://cdn.example/photo-${n}.jpg` }));
  const tree = {
    "src/main.jsx": `import "${profile.typography.bodyPackage}";\nimport "${profile.typography.displayPackage}";`,
    "src/index.css": `:root { --font-sans: "${profile.typography.bodyFamily}"; --font-display: "${profile.typography.displayFamily}"; --background: 38 30% 94%; --radius: 0.125rem; }`,
    "src/App.jsx": `<main className="relative grid grid-cols-1 overflow-hidden shadow-xl md:grid-cols-2">${assets.map((a) => `<img className="object-cover transition-transform" src="${a.url}" />`).join("")}</main>`,
  };
  assert.deepEqual(auditDesign(tree, { profile, assets }), { ok: true, issues: [], warnings: [] });
});

check("audit reports honest image-free fallback and invented hosts", () => {
  const profile = fallbackDesignProfile({ prompt: "bakery website", projectId: "bakery" });
  const tree = {
    "src/main.jsx": `import "${profile.typography.bodyPackage}";\nimport "${profile.typography.displayPackage}";`,
    "src/index.css": `:root { --font-sans: "${profile.typography.bodyFamily}"; --font-display: "${profile.typography.displayFamily}"; }`,
    "src/App.jsx": `<main className="md:grid"><img src="https://picsum.photos/800" /></main>`,
  };
  const audit = auditDesign(tree, { profile, assets: [], imageUnavailable: true });
  assert.ok(audit.issues.some((issue) => issue.includes("placeholder")));
  assert.equal(audit.warnings.length, 1);
});

check("audit rejects a flat school-project SaaS made from thick boxes", () => {
  const profile = fallbackDesignProfile({ prompt: "creator SaaS dashboard", projectId: "creator" });
  const tree = {
    "src/main.jsx": `import "${profile.typography.bodyPackage}";\nimport "${profile.typography.displayPackage}";`,
    "src/index.css": `:root { --font-sans: "${profile.typography.bodyFamily}"; --font-display: "${profile.typography.displayFamily}"; }`,
    "src/App.jsx": `<main className="md:grid">${"<section className=\"border-2\">box</section>".repeat(12)}</main>`,
  };
  const audit = auditDesign(tree, { profile });
  assert.ok(audit.issues.some((issue) => issue.includes("visual-production quality")));
  assert.ok(audit.issues.some((issue) => issue.includes("thick-outlined boxes")));
});

check("audit rejects one-way SaaS shells and desktop overlays left active on phones", () => {
  const profile = fallbackDesignProfile({ prompt: "creator SaaS dashboard", projectId: "whole-product" });
  const assets = [1, 2, 3].map((n) => ({ url: `https://cdn.example/creator-${n}.jpg` }));
  const tree = {
    "src/main.jsx": `import "${profile.typography.bodyPackage}";\nimport "${profile.typography.displayPackage}";`,
    "src/index.css": `:root { --font-sans: "${profile.typography.bodyFamily}"; --font-display: "${profile.typography.displayFamily}"; }`,
    "src/App.jsx": `<main className="relative overflow-hidden shadow-xl md:grid">${assets.map((a) => `<img className="object-cover transition-transform" src="${a.url}" />`).join("")}<LandingPage /><Layout /></main>`,
    "src/components/LandingPage.jsx": `<section className="relative md:grid"><div className="absolute w-[84%] shadow-2xl">product</div></section>`,
    "src/components/Layout.jsx": `<aside className="md:block">Workspace navigation</aside>`,
    "src/components/Dashboard.jsx": `<main className="p-4">Dashboard</main>`,
    "src/components/Invoices.jsx": `<main className="p-4">Invoices</main>`,
  };
  const audit = auditDesign(tree, { profile, assets });
  assert.ok(audit.issues.some((issue) => issue.includes("back to the public launch page")));
  assert.ok(audit.issues.some((issue) => issue.includes("normal document flow")));
  assert.ok(audit.issues.some((issue) => issue.includes("inner application screens")));
});

await ensureDeps(() => {});
const fontTree = clone(fromScaffold(REACT_VITE));
fontTree["src/main.jsx"] = fontTree["src/main.jsx"].replace(
  'import "./index.css";',
  'import "@fontsource-variable/dm-sans";\nimport "@fontsource-variable/newsreader";\nimport "@fontsource-variable/sora";\nimport "@fontsource-variable/plus-jakarta-sans";\nimport "./index.css";',
);
const fontBuild = await buildTree(fontTree, "design-font-packages", () => {});
assert.equal(fontBuild.ok, true, fontBuild.stderr);
passed++;
console.log("PASS every approved self-hosted font package compiles in the scaffold");

console.log(`\n${passed} design-profile tests passed.`);
