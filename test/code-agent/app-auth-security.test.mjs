import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  UUID_RE, requestOrigin, originIsEligible, hmacHex,
} from "../../supabase/functions/app-auth/policy.mjs";

const APP_ID = "11111111-1111-4111-8111-111111111111";

test("C6 — app ids are canonical UUIDs and request origins are normalized fail-closed", () => {
  assert.equal(UUID_RE.test(APP_ID), true);
  assert.equal(UUID_RE.test("invented-app"), false);
  assert.equal(requestOrigin("https://demo.preview.thrallo.com/path?q=1"), "https://demo.preview.thrallo.com");
  assert.equal(requestOrigin("http://localhost:5173/path"), "http://localhost:5173");
  assert.equal(requestOrigin("http://evil.example"), null);
  assert.equal(requestOrigin("https://user:password@example.com"), null);
});

test("C6 — only the project's preview, live site, or verified custom domain is eligible", () => {
  assert.equal(originIsEligible("https://p1.preview.thrallo.com", {
    previewRef: "https://p1.preview.thrallo.com/build",
  }), true);
  assert.equal(originIsEligible("https://farm.app.thrallo.com", {
    site: { slug: "farm", url: "https://farm.app.thrallo.com", unpublished_at: null },
  }), true);
  assert.equal(originIsEligible("https://farm.example", {
    domain: { domain: "farm.example", verified_at: "2026-08-06T00:00:00Z" },
  }), true);
  assert.equal(originIsEligible("https://evil.example", {
    previewRef: "https://p1.preview.thrallo.com",
    site: { slug: "farm", url: "https://farm.app.thrallo.com", unpublished_at: null },
  }), false);
  assert.equal(originIsEligible("https://farm.app.thrallo.com", {
    site: { slug: "farm", url: "https://farm.app.thrallo.com", unpublished_at: "2026-08-06T00:00:00Z" },
  }), false);
  assert.equal(originIsEligible("https://farm.example", {
    domain: { domain: "farm.example", verified_at: null },
  }), false);
});

test("C6 — reset hashes are peppered HMACs, not reusable raw digests", async () => {
  const one = await hmacHex("pepper-one", `${APP_ID}|person@example.com|123456`);
  const two = await hmacHex("pepper-two", `${APP_ID}|person@example.com|123456`);
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.notEqual(one, two);
});

test("C6 — edge handler proves registry/origin eligibility before auth creation and atomically claims reset codes", async () => {
  const source = await readFile(new URL("../../supabase/functions/app-auth/index.ts", import.meta.url), "utf8");
  const eligibility = source.indexOf("await eligibleApplication(appId, origin)");
  const createUser = source.indexOf("svc.auth.admin.createUser");
  assert.ok(eligibility > 0 && eligibility < createUser, "eligibility gates every user-creation path");
  assert.match(source, /from\("projects"\)\.select\("id,preview_ref"\)\.eq\("id", appId\)/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin["']:\s*["']\*["']/);
  assert.match(source, /APP_AUTH_RESET_PEPPER/);
  assert.match(source, /update\(\{ attempts: row\.attempts \+ 1, \.\.\.\(matches \? \{ used_at: claimedAt \}/);
  assert.match(source, /\.eq\("id", row\.id\)\.eq\("attempts", row\.attempts\)\.is\("used_at", null\)/);
  assert.ok(source.indexOf("used_at: claimedAt") < source.indexOf("updateUserById"),
    "the correct token is consumed before the external password mutation");
});
