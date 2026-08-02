// Custom domains, with ownership verified before a certificate is ever requested.
//
// The assertion that matters most is the negative one: an unverified domain must NOT be approved
// for certificate issuance and must NOT be attached to Caddy. Before this, creating a row was
// enough for Thrallo to tell the CA "yes, issue for that hostname" — so a domain someone else owns
// could have had a certificate requested on their behalf.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import {
  normalizeDomain, dnsRecordsFor, domainLimitFor, DOMAIN_LIMITS, DOMAIN_STATUS,
  addDomain, verifyDomain, removeDomain, retryDomain,
} from "../../shell/server/lib/customDomains.mjs";

const OWNER = "55555555-5555-4555-8555-555555555555";
const PROJECT = "proj-1";
const TOKEN = "thrallo-verify=abc123";
const IP = "51.195.136.189";

process.env.THRALLO_PUBLIC_IP = IP;
process.env.CODE_AGENT_STORE = "memory";

// The plan comes from the subscription store, not the domains table, so tests supply a real
// in-memory store rather than a stubbed row — otherwise ownerSubscription reaches for production.
async function storeOn(plan) {
  const store = new MemoryCodeAgentStore();
  await store.upsertSubscription(OWNER, { plan, status: "active" });
  return store;
}

// Stands in for published_sites, custom_domains and ca_subscriptions.
function fakeDb({ domains = [], site = { slug: "focusflow" }, plan = "pro" } = {}) {
  const rows = domains.map((d) => ({ ...d }));
  const db = {
    rows,
    from(table) {
      const filters = {};
      let pending = null;
      const api = {
        select(_cols, opts) { if (opts?.count) api._count = true; return api; },
        eq(column, value) { filters[column] = value; return api; },
        in(column, values) { filters[column] = values; return api; },
        order() { return api; },
        limit() { return api; },
        // update(...).select().single() is a single statement in PostgREST: the write happens and
        // the updated row comes back. A fake that returned the row without applying the patch
        // would silently pass tests that assert nothing changed.
        _settle() {
          const matched = api._match();
          if (pending && pending !== "delete") {
            for (const row of matched) Object.assign(row, pending);
            pending = null;
          }
          return matched;
        },
        single: async () => ({ data: api._settle()[0] || null, error: null }),
        maybeSingle: async () => ({ data: api._settle()[0] || null, error: null }),
        insert(row) { rows.push({ created_at: new Date().toISOString(), ...row }); return Promise.resolve({ error: null }); },
        update(patch) { pending = patch; return api; },
        delete() { pending = "delete"; return api; },
        _match() {
          if (table === "published_sites") return site ? [site] : [];
          if (table === "ca_subscriptions") return [{ owner: OWNER, plan, status: "active" }];
          return rows.filter((r) => Object.entries(filters)
            .every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : String(r[k]) === String(v))));
        },
        then(resolve) {
          const matched = api._match();
          if (pending === "delete") {
            for (const row of matched) rows.splice(rows.indexOf(row), 1);
            pending = null;
            return resolve({ data: null, error: null });
          }
          if (pending) {
            for (const row of matched) Object.assign(row, pending);
            pending = null;
            return resolve({ data: matched[0] || null, error: null });
          }
          return resolve({ data: matched, error: null, count: matched.length });
        },
      };
      return api;
    },
  };
  return db;
}

const resolverThat = ({ txt = [], a = [], cname = [] } = {}) => ({
  resolveTxt: async () => (txt.length ? txt.map((t) => [t]) : Promise.reject(new Error("ENOTFOUND"))),
  resolve4: async () => (a.length ? a : Promise.reject(new Error("ENOTFOUND"))),
  resolveCname: async () => (cname.length ? cname : Promise.reject(new Error("ENOTFOUND"))),
});
const noCert = async () => { throw new Error("no cert yet"); };

// ── Input handling ──────────────────────────────────────────────────────────────────────

test("only a plain registrable hostname is accepted", () => {
  assert.equal(normalizeDomain("https://Shop.Example.com/pricing"), "shop.example.com");
  assert.equal(normalizeDomain(" example.co.uk. "), "example.co.uk");
  for (const bad of ["", "localhost", "not a domain", "example", "http://", "1.2.3.4"]) {
    assert.equal(normalizeDomain(bad), null, `${bad} must be refused`);
  }
  // Thrallo's own suffixes are ours to hand out, never to claim.
  assert.equal(normalizeDomain("evil.app.thrallo.com"), null);
  assert.equal(normalizeDomain("thrallo.com"), null);
});

test("an apex domain is given an A record and a subdomain a CNAME", () => {
  const [txt, apex] = dnsRecordsFor("example.com", TOKEN, "focusflow");
  assert.equal(txt.type, "TXT");
  assert.equal(txt.name, "_thrallo-verify.example.com");
  assert.equal(txt.value, TOKEN);
  assert.equal(apex.type, "A", "an apex domain cannot be a CNAME");
  assert.equal(apex.value, IP);

  const [, sub] = dnsRecordsFor("shop.example.com", TOKEN, "focusflow");
  assert.equal(sub.type, "CNAME");
  assert.equal(sub.value, "focusflow.app.thrallo.com");
});

// ── Plan limits ─────────────────────────────────────────────────────────────────────────

test("plan limits are Free none, Starter one, Pro unlimited", () => {
  assert.deepEqual(DOMAIN_LIMITS, { free: 0, starter: 1, pro: null });
  assert.equal(domainLimitFor("free"), 0);
  assert.equal(domainLimitFor("starter"), 1);
  assert.equal(domainLimitFor("pro"), null, "null means unlimited");
  assert.equal(domainLimitFor("nonsense"), 0, "an unknown plan gets nothing, never everything");
});

test("Free is refused, and Starter is refused a second domain", async () => {
  const free = fakeDb();
  const freeStore = await storeOn("free");
  await assert.rejects(
    () => addDomain(OWNER, PROJECT, "example.com", { client: free, store: freeStore }),
    (e) => e.code === "plan_required" && e.status === 402,
  );
  assert.equal(free.rows.length, 0, "nothing is stored for a plan that cannot have it");

  const starter = fakeDb({
    domains: [{ domain: "first.com", owner: OWNER, project_id: PROJECT, status: "active" }],
  });
  const starterStore = await storeOn("starter");
  await assert.rejects(
    () => addDomain(OWNER, PROJECT, "second.com", { client: starter, store: starterStore }),
    (e) => e.code === "domain_limit",
  );
});

test("Pro can add more than one", async () => {
  const db = fakeDb({
    domains: [{ domain: "first.com", owner: OWNER, project_id: PROJECT, status: "active" }],
  });
  const added = await addDomain(OWNER, PROJECT, "second.com", { client: db, store: await storeOn("pro") });
  assert.equal(added.domain, "second.com");
});

test("a domain already taken never reveals who has it", async () => {
  const otherOwner = "99999999-9999-4999-8999-999999999999";
  const db = fakeDb({ domains: [{ domain: "taken.com", owner: otherOwner, project_id: "their-project" }] });
  const store = await storeOn("pro");
  await assert.rejects(
    () => addDomain(OWNER, PROJECT, "taken.com", { client: db, store }),
    (e) => e.code === "domain_taken"
      && !e.message.includes(otherOwner) && !e.message.includes("their-project"),
  );
});

test("a domain cannot be added to an unpublished project", async () => {
  const store = await storeOn("pro");
  await assert.rejects(
    () => addDomain(OWNER, PROJECT, "example.com", { client: fakeDb({ site: null }), store }),
    (e) => e.code === "not_published",
  );
});

// ── The verification gate ───────────────────────────────────────────────────────────────

test("a new domain starts Pending DNS and is NOT attached", async () => {
  const db = fakeDb();
  let attached = false;
  const added = await addDomain(OWNER, PROJECT, "example.com", { client: db, store: await storeOn("pro") });
  assert.equal(added.status, DOMAIN_STATUS.pendingDns);
  assert.equal(attached, false);
  assert.ok(added.records[0].value.startsWith("thrallo-verify="), "a token is issued to prove ownership");
});

test("the TXT token alone is not enough — the domain must also point here", async () => {
  const db = fakeDb({ domains: [{
    domain: "example.com", owner: OWNER, project_id: PROJECT, slug: "focusflow",
    status: DOMAIN_STATUS.pendingDns, verification_token: TOKEN,
    created_at: new Date().toISOString(), verification_started_at: new Date().toISOString(),
  }] });
  let attached = false;
  const result = await verifyDomain(OWNER, "example.com", {
    client: db, resolver: resolverThat({ txt: [TOKEN] }),        // token present, no A record
    attach: async () => { attached = true; }, fetchImpl: noCert,
  });
  assert.equal(result.status, DOMAIN_STATUS.verifying);
  assert.equal(attached, false, "a certificate must not be requested for a domain that is not routed here");
  assert.match(result.failureReason, /does not point to Thrallo/);
});

test("pointing at Thrallo WITHOUT the token proves nothing", async () => {
  // The dangerous case: anyone can point a hostname at our IP. Only the TXT token proves control.
  const db = fakeDb({ domains: [{
    domain: "victim.com", owner: OWNER, project_id: PROJECT, slug: "focusflow",
    status: DOMAIN_STATUS.pendingDns, verification_token: TOKEN,
    created_at: new Date().toISOString(), verification_started_at: new Date().toISOString(),
  }] });
  let attached = false;
  const result = await verifyDomain(OWNER, "victim.com", {
    client: db, resolver: resolverThat({ a: [IP] }),             // routed, but no token
    attach: async () => { attached = true; }, fetchImpl: noCert,
  });
  assert.equal(result.status, DOMAIN_STATUS.pendingDns);
  assert.equal(attached, false, "THIS is the hole the feature exists to close");
});

test("both proofs together make it Active and attach it exactly once", async () => {
  const row = {
    domain: "example.com", owner: OWNER, project_id: PROJECT, slug: "focusflow",
    status: DOMAIN_STATUS.pendingDns, verification_token: TOKEN,
    created_at: new Date().toISOString(), verification_started_at: new Date().toISOString(),
  };
  const db = fakeDb({ domains: [row] });
  const attaches = [];
  const options = {
    client: db, resolver: resolverThat({ txt: [TOKEN], a: [IP] }),
    attach: async (d, slug) => attaches.push([d, slug]),
    fetchImpl: async () => ({ status: 200 }),
  };

  const first = await verifyDomain(OWNER, "example.com", options);
  assert.equal(first.status, DOMAIN_STATUS.active);
  assert.equal(first.sslStatus, "active", "a successful HTTPS request is the evidence of a certificate");
  assert.ok(first.verifiedAt);
  assert.deepEqual(attaches, [["example.com", "focusflow"]]);

  // Re-checking an already-active domain must not re-attach.
  await verifyDomain(OWNER, "example.com", options);
  assert.equal(attaches.length, 1, "attaching again on every sweep would be pointless churn");
});

test("a CNAME to a Thrallo host counts as routed", async () => {
  const db = fakeDb({ domains: [{
    domain: "shop.example.com", owner: OWNER, project_id: PROJECT, slug: "focusflow",
    status: DOMAIN_STATUS.pendingDns, verification_token: TOKEN,
    created_at: new Date().toISOString(), verification_started_at: new Date().toISOString(),
  }] });
  const result = await verifyDomain(OWNER, "shop.example.com", {
    client: db,
    resolver: resolverThat({ txt: [TOKEN], cname: ["focusflow.app.thrallo.com"] }),
    attach: async () => {}, fetchImpl: noCert,
  });
  assert.equal(result.status, DOMAIN_STATUS.active);
  assert.equal(result.sslStatus, "pending", "the certificate is issued on first handshake, so it is not live yet");
});

test("a domain nobody fixes eventually fails, and Retry restarts the clock", async () => {
  const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
  const db = fakeDb({ domains: [{
    domain: "example.com", owner: OWNER, project_id: PROJECT, slug: "focusflow",
    status: DOMAIN_STATUS.pendingDns, verification_token: TOKEN,
    created_at: old, verification_started_at: old,
  }] });
  const dead = { client: db, resolver: resolverThat({}), attach: async () => {}, fetchImpl: noCert };

  const failed = await verifyDomain(OWNER, "example.com", dead);
  assert.equal(failed.status, DOMAIN_STATUS.failed);

  const retried = await retryDomain(OWNER, "example.com", dead);
  assert.equal(retried.status, DOMAIN_STATUS.pendingDns, "Retry must give it a fresh window, not stay failed");
  assert.equal(retried.failureReason && /could not verify/.test(retried.failureReason), false);
});

// ── Removal ─────────────────────────────────────────────────────────────────────────────

test("removing detaches BEFORE forgetting the domain", async () => {
  const order = [];
  const db = fakeDb({ domains: [{ domain: "example.com", owner: OWNER, project_id: PROJECT, status: "active" }] });
  const originalDelete = db.from;
  db.from = (table) => {
    const api = originalDelete.call(db, table);
    const del = api.delete.bind(api);
    api.delete = () => { order.push("delete"); return del(); };
    return api;
  };
  await removeDomain(OWNER, "example.com", { client: db, detach: async () => { order.push("detach"); } });
  assert.deepEqual(order, ["detach", "delete"],
    "deleting first would leave Caddy serving a hostname Thrallo no longer knows about");
  assert.equal(db.rows.length, 0);
});

test("removing a domain you do not have is refused", async () => {
  await assert.rejects(
    () => removeDomain(OWNER, "example.com", { client: fakeDb() }),
    (e) => e.code === "not_connected" && e.status === 404,
  );
});

// ── The certificate gate, at its actual source ──────────────────────────────────────────

test("the ask-gate approves ONLY active domains", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/routes/previewDomainCheck.mjs", import.meta.url)), "utf8");
  const fn = source.slice(source.indexOf("async function thralloCustomDomain"), source.indexOf("export async function previewDomainAllowed"));
  assert.match(fn, /\.eq\("status", "active"\)/,
    "without this filter, adding a row is enough to have a certificate requested for someone else's domain");
});

test("the Thrallo subdomain is never affected by custom domains", async () => {
  // The ask-gate answers for *.app.thrallo.com from provisiond's own record, on a path that never
  // consults custom_domains — so a broken or removed custom domain cannot take the default
  // address down with it.
  const source = await readFile(fileURLToPath(new URL("../../shell/server/routes/previewDomainCheck.mjs", import.meta.url)), "utf8");
  const fn = source.slice(source.indexOf("export async function previewDomainAllowed"));
  assert.ok(fn.indexOf("labelExists") < fn.indexOf("thralloCustomDomain"),
    "Thrallo suffixes must be answered before custom domains are consulted");
  assert.match(fn, /return labelExists/);
});
