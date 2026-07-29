import assert from "node:assert/strict";
import { ownedProject } from "../server/lib/supabase.mjs";

const filters = [];
const query = {
  select() { return this; },
  eq(column, value) { filters.push([column, value]); return this; },
  async maybeSingle() { return { data: { id: "project-a" }, error: null }; },
};
const client = { from(table) { assert.equal(table, "projects"); return query; } };

assert.deepEqual(await ownedProject("owner-a", "project-a", "id", client), { id: "project-a" });
assert.deepEqual(filters, [["id", "project-a"], ["owner", "owner-a"]]);
assert.equal(await ownedProject(null, "project-a", "id", client), null);
assert.equal(await ownedProject("owner-a", null, "id", client), null);
console.log("project ownership: pass");
