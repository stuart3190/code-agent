// Archetype 3: form-with-validation (a third shape). A signup form with a validate()
// function, an errors map, and required/email/min-length rules. The starting tree
// contains no "confirm"/"match" strings so the new-feature check genuinely bites.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appJsx = readFileSync(path.join(HERE, "trees", "form.App.jsx"), "utf8");

export const formValidation = {
  name: "form-validation",
  scaffold: REACT_VITE,
  startFiles: { "src/App.jsx": appJsx },
  priorFeatures: ["validate", "errors", "email"],
  editPrompt: "Add a confirm-password field that must match the password before the form can submit.",
  newFeature: ["confirm", "match"],
};
