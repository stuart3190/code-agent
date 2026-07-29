// Archetype 1: todo. Starting tree lifted verbatim from the proven Phase 1
// gen-output app (builds, carries the four feature markers). Edit + markers are the
// proven iteration #1 from the spike.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appJsx = readFileSync(path.join(HERE, "trees", "todo.App.jsx"), "utf8");

export const todo = {
  name: "todo",
  scaffold: REACT_VITE,
  startFiles: { "src/App.jsx": appJsx },
  priorFeatures: ["addTodo", "toggleTodo", "setFilter", "filteredTodos"],
  editPrompt: "Add a due-date field to each task, shown next to the task and used to sort.",
  newFeature: ["dueDate", "sort"],
};
