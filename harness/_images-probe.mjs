// Probe: does the BUILD prompt actually produce a photo-rich consumer site?
// (Written 2026-07-16 after production builds shipped photo-less "colour block" sites — the
// Pexels quota showed search_images was never being called. Guards the strengthened
// IMAGES_PROMPT_BLOCK + Design-block photography rule.)
//
//   node harness/_images-probe.mjs ["custom prompt"]
//
// Runs ONE live Codex build (free on the sub) with the exact tool wiring the generate route
// uses, then asserts: search_images was called ≥1×, the tree references images.pexels.com ≥3×,
// and the tree still builds. Materializes to harness/.work/images-probe (dist/ servable).

import { runAgent } from "../src/engine/runAgent.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { makeFileTools } from "../src/tools/fileTools.mjs";
import { BUILD_SYSTEM_PROMPT } from "../src/prompts/builder.mjs";
import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { searchImages, SEARCH_IMAGES_SCHEMA, IMAGES_PROMPT_BLOCK } from "../shell/server/lib/images.mjs";
import { ensureDeps, buildTree } from "./workspace.mjs";
import { loadEnv } from "../shell/server/lib/env.mjs";

loadEnv();
if (!process.env.PEXELS_API_KEY) {
  console.log("SKIPPED — PEXELS_API_KEY not set (shell/.env)");
  process.exit(0);
}

const prompt = process.argv[2] ||
  "a website for a local barber shop: hero, services with prices, opening hours, about the shop, and a booking request form (name, phone, preferred day and time, service)";

const tree = clone(fromScaffold(REACT_VITE));
const { schemas, impls } = makeFileTools(tree);
let imageCalls = 0;
const toolImpls = {
  ...impls,
  search_images: async ({ query, count, orientation }) => {
    imageCalls++;
    console.log(`  [search_images #${imageCalls}] "${query}" (count=${count ?? 5}, ${orientation ?? "landscape"})`);
    try {
      const photos = await searchImages(query, { count, orientation });
      return { photos };
    } catch (e) {
      return { error: `image search unavailable (${e.message}) — build without photos`, photos: [] };
    }
  },
};

console.log(`prompt: ${prompt}\n`);
const { telemetry } = await runAgent({
  provider: createCodexProvider(),
  systemPrompt: `${BUILD_SYSTEM_PROMPT}\n${IMAGES_PROMPT_BLOCK}`,
  tools: [...schemas, SEARCH_IMAGES_SCHEMA],
  toolImpls,
  tree,
  prompt,
  log: (l) => console.log(`  ${l}`),
});

const src = Object.entries(tree)
  .filter(([p]) => p.startsWith("src/") && !p.startsWith("src/lib/backend") && !p.startsWith("src/components/ui"))
  .map(([, c]) => c).join("\n");
const pexelsRefs = (src.match(/images\.pexels\.com/g) || []).length;
// Real image-host inventions only — NOT the word "placeholder" (input attrs, Tailwind classes).
const fakeRefs = (src.match(/unsplash\.com|picsum\.photos|placehold\.(?:it|co)|via\.placeholder/gi) || []).length;

console.log("\n[build] proving the tree builds…");
await ensureDeps();
const { ok } = await buildTree(tree, "images-probe");

console.log(`\nsearch_images calls: ${imageCalls}`);
console.log(`pexels URL references in app code: ${pexelsRefs}`);
console.log(`invented image hosts (unsplash/picsum/placeholder): ${fakeRefs}`);
console.log(`tree builds: ${ok}`);

const pass = imageCalls >= 1 && pexelsRefs >= 3 && fakeRefs === 0 && ok;
console.log(pass ? "\nPASS — photo-rich build" : "\nFAIL");
process.exit(pass ? 0 : 1);
