import assert from "node:assert/strict";
import { waitForInstagramContainer } from "../marketing/instagramPublishing.mjs";

function response(status_code, ok = true) {
  return { ok, json: async () => ({ status_code, status: `status ${status_code}` }) };
}

const statuses = [response("IN_PROGRESS"), response("IN_PROGRESS"), response("FINISHED")];
let sleeps = 0;
const ready = await waitForInstagramContainer({
  containerId: "container-1",
  token: "token",
  graph: "https://graph.example/v1",
  fetchFn: async (url) => {
    assert.equal(url.searchParams.get("fields"), "status_code,status");
    assert.equal(url.searchParams.get("access_token"), "token");
    return statuses.shift();
  },
  sleep: async () => { sleeps += 1; },
});
assert.equal(ready.status_code, "FINISHED");
assert.equal(sleeps, 2);

await assert.rejects(
  waitForInstagramContainer({
    containerId: "container-2", token: "token", graph: "https://graph.example/v1",
    fetchFn: async () => response("ERROR"), sleep: async () => {},
  }),
  /container error/,
);

await assert.rejects(
  waitForInstagramContainer({
    containerId: "container-3", token: "token", graph: "https://graph.example/v1",
    fetchFn: async () => response("IN_PROGRESS"), sleep: async () => {}, attempts: 2,
  }),
  /not ready after 2 checks/,
);

console.log("instagram publishing readiness: pass");
