import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePublishPolicy, matchesGlob, touchedPathsFromStatus,
} from "../../shell/server/lib/publishPolicy.mjs";

test("glob matching stays segment-aware and directories protect their contents", () => {
  assert.equal(matchesGlob("src/config/**", "src/config/auth/keys.ts"), true);
  assert.equal(matchesGlob("src/config/**", "src/configuration.ts"), false);
  assert.equal(matchesGlob("*.sql", "schema.sql"), true);
  assert.equal(matchesGlob("*.sql", "db/schema.sql"), false);
  assert.equal(matchesGlob("**/*.sql", "db/deep/schema.sql"), true);
  assert.equal(matchesGlob("migrations", "migrations/001_init.sql"), true);
  assert.equal(matchesGlob("migrations", "migrations"), true);
  assert.equal(matchesGlob("migrations", "migrations_backup/a.sql"), false);
  assert.equal(matchesGlob("src/?.js", "src/a.js"), true);
  assert.equal(matchesGlob("src/?.js", "src/ab.js"), false);
  assert.equal(matchesGlob("", "anything"), false);
});

test("touched paths parse modified, untracked, renamed, and quoted entries", () => {
  const status = [
    " M a.js",
    "?? b/c.txt",
    "R  old.js -> new.js",
    'A  "sp ace.txt"',
    "",
  ].join("\n");
  const paths = touchedPathsFromStatus(status);
  assert.deepEqual(paths.sort(), ["a.js", "b/c.txt", "new.js", "old.js", "sp ace.txt"]);
});

test("auto-publish is allowed only when no protected path was touched", () => {
  const agent = { publish_mode: "auto_publish", protected_paths: ["migrations/**", "**/*.env"] };
  const clean = evaluatePublishPolicy(agent, " M src/app.js\n?? src/new.js");
  assert.equal(clean.action, "auto_publish");

  const dirty = evaluatePublishPolicy(agent, " M src/app.js\n M migrations/002_add.sql");
  assert.equal(dirty.action, "require_approval");
  assert.equal(dirty.reason, "protected_path");
  assert.deepEqual(dirty.protectedTouched, ["migrations/002_add.sql"]);
});

test("require_approval agents always wait, and missing policy defaults safely", () => {
  const explicit = evaluatePublishPolicy(
    { publish_mode: "require_approval", protected_paths: [] },
    " M src/app.js",
  );
  assert.equal(explicit.action, "require_approval");
  assert.equal(explicit.reason, "policy");

  const legacy = evaluatePublishPolicy({}, " M src/app.js");
  assert.equal(legacy.action, "require_approval");
});
