#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";

loadEnv();
if (process.env.PACKAGE12_HTTP_PROOF !== "1") throw new Error("set PACKAGE12_HTTP_PROOF=1");
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) throw new Error("Supabase service and browser configuration is required");
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const browserClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const owner = crypto.randomUUID(); const project = crypto.randomUUID();
const slug = `package12-${owner.slice(0, 8)}`; const domain = `${slug}.example.invalid`;
const email = `${slug}@example.invalid`; const password = `${crypto.randomUUID()}Aa!9`;
const marker = `package12-log-${crypto.randomUUID()}`;
let browser;

async function unwrap(promise, label) {
  const { data, error } = await promise; if (error) throw new Error(`${label}: ${error.message}`); return data;
}
async function beacon(origin, appId = slug, { contentType = "text/plain", body = null } = {}) {
  return fetch("https://app.thrallo.com/api/analytics/collect", {
    method: "POST", headers: { Origin: origin, "Content-Type": contentType, "User-Agent": "Mozilla/5.0 Package12Proof" },
    body: body ?? JSON.stringify({ appId, kind: "pageview", path: "/package12" }),
  });
}

try {
  await unwrap(db.auth.admin.createUser({ id: owner, email, password, email_confirm: true }), "auth fixture");
  await unwrap(db.from("projects").insert({ id: project, owner, name: "Package 12 HTTP proof", tree: {} }), "project fixture");
  await unwrap(db.from("published_sites").insert({ owner, project_id: project, slug, url: `https://${slug}.app.thrallo.com/` }), "site fixture");
  await unwrap(db.from("custom_domains").insert({ domain, owner, project_id: project, slug, status: "active", verified_at: new Date().toISOString() }), "domain fixture");
  const session = await unwrap(browserClient.auth.signInWithPassword({ email, password }), "browser sign-in");
  const accessToken = session.session?.access_token; assert.ok(accessToken);

  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.goto("https://app.thrallo.com", { waitUntil: "domcontentloaded" });
  const streamPromise = page.evaluate(async ({ projectId, token, expected }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("stream proof timed out")), 20_000);
    const response = await fetch(`/api/v1/projects/${projectId}/logs/stream`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`stream status ${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) throw new Error("stream ended before marker");
      buffer += decoder.decode(value, { stream: true });
      for (const match of buffer.matchAll(/event: log\ndata: (.+)\n\n/g)) {
        const row = JSON.parse(match[1]);
        if (row.message === expected) { clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {}); return row; }
      }
    }
  }, { projectId: project, token: accessToken, expected: marker });
  // The production stream intentionally starts at connection time. Insert after it is open so
  // this proves live delivery rather than depending on historical-list semantics.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await unwrap(db.from("project_logs").insert({ owner, project_id: project, source: "system", level: "info", message: marker }), "live log fixture");
  const streamed = await streamPromise;
  assert.equal(streamed.message, marker);

  const thralloOrigin = `https://${slug}.app.thrallo.com`;
  const thrallo = await beacon(thralloOrigin); assert.equal(thrallo.status, 204);
  assert.equal(thrallo.headers.get("access-control-allow-origin"), thralloOrigin);
  const custom = await beacon(`https://${domain}`); assert.equal(custom.status, 204);
  assert.equal(custom.headers.get("access-control-allow-origin"), `https://${domain}`);
  assert.equal((await beacon("https://unknown.example.invalid", "unregistered-app")).status, 403);
  assert.equal((await beacon(thralloOrigin, "bad app id")).status, 403);
  assert.equal((await beacon(thralloOrigin, slug, { contentType: "application/json" })).status, 415);
  assert.equal((await beacon(thralloOrigin, slug, { body: "x".repeat(32 * 1024 + 1) })).status, 413);
  console.log(JSON.stringify({ ok: true, authenticatedFetchStream: true, bearerInQuery: false,
    thralloOrigin: true, customOrigin: true, unregisteredRejected: true, malformedRejected: true,
    contentTypeRejected: true, oversizedRejected: true }));
} finally {
  if (browser) await browser.close().catch(() => {});
  await db.from("analytics_events").delete().eq("owner", owner);
  await db.from("analytics_daily").delete().eq("owner", owner);
  await db.from("custom_domains").delete().eq("owner", owner);
  await db.from("published_sites").delete().eq("owner", owner);
  await db.from("project_logs").delete().eq("owner", owner);
  await db.from("projects").delete().eq("owner", owner);
  await db.auth.admin.deleteUser(owner).catch(() => {});
}
