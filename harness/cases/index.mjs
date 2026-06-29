// The regression suite: more than one archetype, so "reliably builds" means across
// shapes, not one app.

import { todo } from "./todo.mjs";
import { dashboard } from "./dashboard.mjs";
import { formValidation } from "./formValidation.mjs";

export const CASES = [todo, dashboard, formValidation];
