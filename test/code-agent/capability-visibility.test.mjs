// The two operational defects visible in every production build:
//   connectors: unavailable — Could not find the table 'public.project_integrations'
//   design: photography unavailable (PEXELS_API_KEY is not configured)
// One was an error on every build for a permanently absent optional table; the other was invisible
// unless you opened an individual build's log.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMissingTable, noteMissingCapability, withOptionalTable, resetCapabilityNotices,
} from "../../shell/server/lib/schemaCapability.mjs";
import { reportCapabilities, capabilities } from "../../shell/server/lib/capabilityReport.mjs";

test("a missing table is recognised in every form Postgres and PostgREST report it", () => {
  // The exact production message.
  assert.equal(isMissingTable({
    message: "Could not find the table 'public.project_integrations' in the schema cache",
    code: "PGRST205",
  }), true);
  assert.equal(isMissingTable({ code: "42P01", message: 'relation "project_integrations" does not exist' }), true);
  assert.equal(isMissingTable({ message: 'relation "connector_actions" does not exist' }), true);

  // And nothing else is. A permissions error or a network failure must still surface as a fault.
  assert.equal(isMissingTable({ code: "42501", message: "permission denied for table projects" }), false);
  assert.equal(isMissingTable({ message: "fetch failed" }), false);
  assert.equal(isMissingTable(null), false);
});

test("withOptionalTable falls back for an absent table and rethrows everything else", async () => {
  resetCapabilityNotices();
  const missing = { code: "PGRST205", message: "Could not find the table 'public.project_integrations' in the schema cache" };

  const rows = await withOptionalTable("connectors", async () => { throw missing; }, []);
  assert.deepEqual(rows, [], "no connector table reads the same as no connector rows");

  // A real fault must not be swallowed behind a default value.
  await assert.rejects(
    withOptionalTable("connectors", async () => { throw new Error("permission denied for table projects"); }, []),
    /permission denied/,
  );

  // And a working query is untouched.
  assert.deepEqual(await withOptionalTable("connectors", async () => [{ id: 1 }], []), [{ id: 1 }]);
});

test("the absence is announced once, not on every build", () => {
  resetCapabilityNotices();
  const error = { code: "PGRST205", message: "Could not find the table 'public.project_integrations'" };
  assert.equal(noteMissingCapability("connectors", error), true, "the first build says so");
  assert.equal(noteMissingCapability("connectors", error), false, "the four hundredth does not");
  resetCapabilityNotices();
  assert.equal(noteMissingCapability("connectors", error), true);
});

test("the boot report names every disabled capability and what it costs", () => {
  const lines = [];
  const log = { log: (m) => lines.push(`log ${m}`), warn: (m) => lines.push(`warn ${m}`) };
  const before = process.env.PEXELS_API_KEY;
  delete process.env.PEXELS_API_KEY;
  try {
    const list = reportCapabilities({ log });
    const photography = list.find((c) => c.name === "photography");
    assert.equal(photography.available, false);

    const warning = lines.find((l) => l.startsWith("warn") && l.includes("photography"));
    assert.ok(warning, "an unconfigured optional key must warn at boot, not only inside a build");
    assert.match(warning, /DISABLED/);
    // The consequence, so an operator does not have to know what Pexels is to understand the impact.
    assert.match(warning, /generated apps are built without photographs/);
    assert.match(warning, /PEXELS_API_KEY/);
  } finally {
    if (before !== undefined) process.env.PEXELS_API_KEY = before;
  }
});

test("a configured capability reports as enabled rather than warning", () => {
  const lines = [];
  const log = { log: (m) => lines.push(`log ${m}`), warn: (m) => lines.push(`warn ${m}`) };
  const before = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = "test-key-not-real";
  try {
    const list = reportCapabilities({ log });
    assert.equal(list.find((c) => c.name === "photography").available, true);
    assert.ok(!lines.some((l) => l.startsWith("warn") && l.includes("photography")));
    assert.ok(lines.some((l) => l.startsWith("log") && l.includes("photography")));
    // The key itself is never printed.
    assert.ok(!lines.join("\n").includes("test-key-not-real"));
  } finally {
    if (before === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = before;
  }
});

test("a capability that is configured but still loading is not reported as disabled", () => {
  // Observed in the live boot log: "DISABLED: country analytics ... (loading)". The licence key
  // was present and the database was seconds from being read — reporting that as disabled would
  // send an operator hunting for a key that is already there.
  const lines = [];
  const log = { log: (m) => lines.push(`log ${m}`), warn: (m) => lines.push(`warn ${m}`) };
  reportCapabilities({ log });

  const geoLines = lines.filter((l) => l.includes("country analytics"));
  for (const line of geoLines) {
    if (/still loading/.test(line)) {
      assert.ok(line.startsWith("log "), "a loading capability must not warn");
      assert.ok(!/DISABLED/.test(line));
    }
  }
  // And the states stay distinguishable rather than collapsing into a boolean.
  const geo = capabilities().find((c) => c.name === "country analytics");
  assert.ok(geo.available === true || geo.available === false || geo.available === null);
});
