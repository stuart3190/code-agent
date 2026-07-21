import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CONNECTOR_CATALOG } from "../shell/server/lib/connectors.mjs";
import { cleanWorkflowInput } from "../shell/server/lib/connectorWorkflows.mjs";

const ids = CONNECTOR_CATALOG.map((item) => item.id);
assert.equal(new Set(ids).size, ids.length, "connector IDs must be unique");
for (const id of ["custom_api", "google_drive", "google_sheets", "gmail", "google_calendar", "slack_webhook", "discord_webhook", "stripe_connect", "github"]) {
  assert.ok(ids.includes(id), `${id} should be in the connector catalog`);
}
assert.equal(CONNECTOR_CATALOG.find((item) => item.id === "github").paidPlan, true, "GitHub remains paid-only");
assert.equal(CONNECTOR_CATALOG.find((item) => item.id === "custom_api").readable, true);
assert.equal(CONNECTOR_CATALOG.find((item) => item.id === "slack_webhook").readable, false);

assert.deepEqual(cleanWorkflowInput({ name: "New lead", triggerEvent: "Lead.Created", actionProvider: "app_email" }), {
  name: "New lead", trigger_event: "lead.created", action_provider: "app_email", enabled: true,
});
assert.equal(cleanWorkflowInput({ name: "Everything", triggerEvent: "*", actionProvider: "signed_webhook", enabled: false }).enabled, false);
assert.throws(() => cleanWorkflowInput({ name: "Bad", triggerEvent: "spaces are unsafe", actionProvider: "app_email" }), /event such as/i);
assert.throws(() => cleanWorkflowInput({ name: "Bad", triggerEvent: "event", actionProvider: "shell" }), /supported workflow action/i);

const migration = await readFile(new URL("../supabase/migrations/20260721152000_connector_hub.sql", import.meta.url), "utf8");
for (const table of ["connector_oauth_states", "connector_workflows"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  assert.match(migration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`, "i"));
  assert.match(migration, new RegExp(`grant select, insert, update, delete on table public\\.${table} to service_role`, "i"));
}
assert.match(migration, /code_verifier_encrypted text not null/i);
assert.doesNotMatch(migration, /access_token|refresh_token/i, "OAuth tokens belong in encrypted project_secrets, not connector tables");

const connectorSource = await readFile(new URL("../shell/server/lib/connectors.mjs", import.meta.url), "utf8");
assert.match(connectorSource, /untrustedExternalData: true/);
assert.match(connectorSource, /redirect: "error"/);
assert.match(connectorSource, /MAX_CONNECTOR_OUTPUT = 12_000/);
assert.match(connectorSource, /connectorFeeCredits: 0/);

const buildJobs = await readFile(new URL("../shell/server/lib/buildJobs.mjs", import.meta.url), "utf8");
assert.match(buildJobs, /connectorToolsForProject/);
assert.match(buildJobs, /tools = \[\.\.\.tools, \.\.\.connectors\.schemas\]/);

console.log("connector hub tests OK");

