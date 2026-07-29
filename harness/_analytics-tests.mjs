import assert from "node:assert/strict";
import { summarizeAnalytics } from "../shell/server/lib/analytics.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

const now = new Date().toISOString();
const result = summarizeAnalytics([
  { id: 1, session_id: "session-a", name: "page_view", path: "/", properties: {}, created_at: now },
  { id: 2, session_id: "session-a", name: "signup", path: "/signup", properties: {}, created_at: now },
  { id: 3, session_id: "session-b", name: "page_view", path: "/", properties: {}, created_at: now },
  { id: 4, session_id: "session-b", name: "client_error", path: "/app", properties: { message: "boom" }, created_at: now },
], 7);
assert.deepEqual(result.totals, { events: 4, sessions: 2, pageViews: 2, errors: 1 });
assert.deepEqual(result.pages[0], { path: "/", count: 2 });
assert.equal(result.errors[0].properties.message, "boom");
assert.equal(result.daily.length, 7);
assert.equal(result.daily.at(-1).sessions, 2);

const sdk = REACT_VITE["src/lib/backend/supabaseBackend.js"];
assert.match(sdk, /client_error/);
assert.match(sdk, /page_view/);
assert.match(sdk, /keepalive: true/);
assert.doesNotMatch(sdk, /userAgent|ip_address/);

console.log("Analytics tests passed");
