// Archetype 2: dashboard (different shape from todo). A metrics dashboard — stat
// cards computed from an orders array + an orders table. The starting tree deliberately
// contains no "search"/"filter" strings so the new-feature check genuinely bites.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appJsx = readFileSync(path.join(HERE, "trees", "dashboard.App.jsx"), "utf8");

export const dashboard = {
  name: "dashboard",
  scaffold: REACT_VITE,
  startFiles: { "src/App.jsx": appJsx },
  priorFeatures: ["StatCard", "orders", "totalRevenue"],
  editPrompt: "Add a search box that filters the orders table by customer name.",
  newFeature: ["search", "filter"],
};
