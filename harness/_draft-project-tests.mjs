import assert from "node:assert/strict";
import { createLocalDraft } from "../shell/web/src/lib/draftProject.js";

const draft = createLocalDraft();
assert.equal(draft.transient, true);
assert.equal(draft.name, "Untitled app");
assert.equal(draft.tree, null);
assert.deepEqual(draft.prompts, []);
assert.match(draft.id, /^[0-9a-f-]{36}$/i);
console.log("local draft project: pass");
