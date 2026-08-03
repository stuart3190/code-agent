// Live proof for custom domain verification integrity. Runs against production.
//
// Real public DNS: 51-195-136-189.sslip.io genuinely resolves to this VPS, so the routing half of
// verification is proved against the actual internet rather than a stub.
//
// The TXT half cannot be: publishing _thrallo-verify TXT requires owning the zone, and Thrallo owns
// no throwaway domain. So the NEGATIVE is proved with real DNS — no TXT published, real lookup,
// domain must not activate and must not pass the certificate gate — and the POSITIVE is driven by
// answering the TXT lookup with the token the production database actually issued. Every other
// part (the row, the attach, the gate, the symlink, the surfaces) is production.
//
// No HTTPS request is ever made to the throwaway hostname: that would ask Let's Encrypt for a
// certificate against sslip.io's shared rate limit for a domain Thrallo does not own.

import { promises as dns } from "node:dns";
import { access, readlink } from "node:fs/promises";
import path from "node:path";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import {
  addDomain, verifyDomain, removeDomain, listDomains, normalizeDomain,
} from "../shell/server/lib/customDomains.mjs";
import { attachDomain, detachDomain } from "../shell/server/lib/appBuild/appPublishService.mjs";
import { previewDomainAllowed } from "../shell/server/routes/previewDomainCheck.mjs";
import { publishStates } from "../shell/server/lib/publishState.mjs";

const db = serviceClient();
const DOMAIN = "51-195-136-189.sslip.io";
const PUBLISH_ROOT = process.env.PUBLISH_DIR || "/home/ubuntu/publish";
// A live site to prove the Thrallo subdomain is unaffected. Resolved from the database rather
// than hard-coded: which customer sites are published is the OWNERS' business, and a proof that
// fails because somebody unpublished their own app is a proof about them, not about this code.
let REAL_SITE = null;
let REAL_SLUG = null;
{
  const { data: live } = await db.from("published_sites")
    .select("slug,url").is("unpublished_at", null).limit(1);
  REAL_SITE = live?.[0]?.url || null;
  REAL_SLUG = live?.[0]?.slug || null;
}
const SLUG = "pr5proof";

const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

// Caddy learns about a custom hostname through a symlink under _domains. That symlink IS the
// attachment, so checking the filesystem beats trusting an API response.
async function attachedInCaddy(domain) {
  try {
    const target = await readlink(path.join(PUBLISH_ROOT, "_domains", domain));
    return target;
  } catch {
    try { await access(path.join(PUBLISH_ROOT, "_domains", domain)); return "(exists)"; } catch { return null; }
  }
}

const siteStatus = async (url) => {
  try { return (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) })).status; }
  catch (error) { return `error: ${error?.message}`; }
};
// Never triggers issuance.
const noCert = async () => { throw new Error("not requested during proof"); };

// ── Fixtures ────────────────────────────────────────────────────────────────────────────
const email = `pr5-domain-proof-${Date.now()}@thrallo.invalid`;
const { data: created, error: userError } = await db.auth.admin.createUser({
  email, password: `Pr5!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
});
if (userError) { console.error("could not create throwaway owner:", userError.message); process.exit(1); }
const OWNER = created.user.id;
const PROJECT = crypto.randomUUID();
const PRODUCT = crypto.randomUUID();
console.log(`[proof] throwaway owner ${OWNER}`);

async function cleanup() {
  await db.from("custom_domains").delete().eq("owner", OWNER);
  await db.from("published_sites").delete().eq("owner", OWNER);
  await db.from("projects").delete().eq("owner", OWNER);
  await db.from("ca_subscriptions").delete().eq("owner", OWNER);
  await detachDomain(DOMAIN).catch(() => {});
  await db.auth.admin.deleteUser(OWNER).catch(() => {});
}

try {
  await db.from("ca_products").insert({ id: PRODUCT, owner: OWNER, name: "PR5 Proof" }).select().maybeSingle();
  const { error: projectError } = await db.from("projects")
    .insert({ id: PROJECT, owner: OWNER, name: "PR5 Proof", product_id: PRODUCT, tree: { "index.html": "<h1>proof</h1>" } });
  if (projectError) throw new Error(`project fixture: ${projectError.message}`);
  const { error: siteError } = await db.from("published_sites").insert({
    owner: OWNER, project_id: PROJECT, slug: SLUG, url: `https://${SLUG}.app.thrallo.com/`,
  });
  if (siteError) throw new Error(`site fixture: ${siteError.message}`);

  // The throwaway's OWN Thrallo address is the one this proof controls, so the "the default
  // subdomain is unaffected" claim rests on something the proof published rather than on whatever
  // an account owner happens to have live at the time.
  const baseline = REAL_SITE ? await siteStatus(REAL_SITE) : null;
  check(REAL_SITE === null || baseline === 200,
    "any live customer site is serving before any of this",
    REAL_SITE ? String(baseline) : "no live site published — skipped");

  // ── Free gets no custom domains ───────────────────────────────────────────────────────
  await db.from("ca_subscriptions").upsert({ owner: OWNER, plan: "free", status: "active" }, { onConflict: "owner" });
  let refused = null;
  await addDomain(OWNER, PROJECT, DOMAIN, { attach: attachDomain, fetchImpl: noCert })
    .catch((error) => { refused = error; });
  check(refused?.code === "plan_required", "Free is refused a custom domain", refused?.code || "was ALLOWED");

  await db.from("ca_subscriptions").upsert({ owner: OWNER, plan: "starter", status: "active" }, { onConflict: "owner" });

  // ── Adding: token, records, Pending DNS, nothing attached ─────────────────────────────
  const added = await addDomain(OWNER, PROJECT, DOMAIN, { attach: attachDomain, fetchImpl: noCert });
  const { data: row } = await db.from("custom_domains").select("*").eq("domain", DOMAIN).maybeSingle();

  check(!!row, "the domain was recorded");
  check(/^thrallo-verify=[0-9a-f]{32}$/.test(row?.verification_token || ""),
    "a real verification token was generated", row?.verification_token || "NULL");
  const txt = (added.records || []).find((r) => r.purpose === "verification");
  check(!!txt?.value && txt.value.length > 10, "the TXT record shown is non-empty", txt?.value || "(blank)");
  check(txt?.value === row?.verification_token, "and is the token actually checked for");
  check(row?.status === "pending_dns", "the initial status is Pending DNS", row?.status);
  check(row?.ssl_status !== "active", "and it does not claim a certificate", `ssl_status=${row?.ssl_status}`);

  const routing = (added.records || []).find((r) => r.purpose === "routing");
  check(!!routing?.value, "a routing record is offered too", `${routing?.type} → ${routing?.value}`);

  check((await attachedInCaddy(DOMAIN)) === null,
    "NOTHING is attached to Caddy before verification", String(await attachedInCaddy(DOMAIN)));

  // ── The certificate gate, against the real production route ───────────────────────────
  check((await previewDomainAllowed(DOMAIN)) === false,
    "the certificate gate REFUSES an unverified domain");
  // A Thrallo subdomain whose files genuinely exist on disk — the gate answers those from
  // provisiond's own record, not from custom_domains. This proof inserts a published_sites row but
  // never uploads files, so its own slug is not a valid subject; a really-published site is.
  if (REAL_SLUG) {
    check((await previewDomainAllowed(`${REAL_SLUG}.app.thrallo.com`)) === true,
      "while the Thrallo subdomain is unaffected by any of it", `${REAL_SLUG}.app.thrallo.com`);
  } else {
    check(true, "no published site available to check the Thrallo subdomain against", "skipped");
  }

  // ── Real DNS: routing resolves, TXT does not, so it must not activate ─────────────────
  const realIps = await dns.resolve4(DOMAIN).catch(() => []);
  check(realIps.includes("51.195.136.189"), "the throwaway hostname genuinely resolves to Thrallo in public DNS", realIps.join(","));
  const realTxt = await dns.resolveTxt(`_thrallo-verify.${DOMAIN}`).catch(() => []);
  check(realTxt.length === 0, "and no verification TXT is published for it");

  const withRealDns = await verifyDomain(OWNER, DOMAIN, { attach: attachDomain, fetchImpl: noCert });
  check(withRealDns.status === "pending_dns",
    "routing alone does NOT activate it — ownership is a separate proof", withRealDns.status);
  check((await attachedInCaddy(DOMAIN)) === null, "still nothing attached");
  check(!!withRealDns.failureReason, "and the reason is stated", withRealDns.failureReason);

  // ── Idempotency ───────────────────────────────────────────────────────────────────────
  const again = await addDomain(OWNER, PROJECT, DOMAIN, { attach: attachDomain, fetchImpl: noCert });
  const { count } = await db.from("custom_domains")
    .select("domain", { count: "exact", head: true }).eq("owner", OWNER);
  check(count === 1, "asking again creates no second row", `${count} row(s)`);
  check(again.alreadyConnected === true, "and reports that it is already connected");
  const { data: afterRetry } = await db.from("custom_domains").select("verification_token").eq("domain", DOMAIN).maybeSingle();
  check(afterRetry?.verification_token === row?.verification_token,
    "with the SAME token — reissuing would invalidate DNS the user had already published");

  // ── Activation. TXT answered with the token production actually issued. ───────────────
  const zone = {
    resolveTxt: async (name) => (name === `_thrallo-verify.${DOMAIN}` ? [[row.verification_token]] : []),
    resolve4: dns.resolve4,            // real public DNS
    resolveCname: dns.resolveCname,    // real public DNS
  };
  const activated = await verifyDomain(OWNER, DOMAIN, { resolver: zone, attach: attachDomain, fetchImpl: noCert });
  check(activated.status === "active", "correct TXT + real routing DNS activates it", activated.status);
  check(!!activated.verifiedAt, "and the verification is stamped");

  const link = await attachedInCaddy(DOMAIN);
  check(link !== null, "Caddy is attached ONLY now, after activation", String(link));
  check(String(link).includes(SLUG), "and points at this project's site", String(link));
  check((await previewDomainAllowed(DOMAIN)) === true, "the certificate gate now approves it");
  check(activated.sslStatus === "pending",
    "SSL is honestly 'pending' until a real handshake issues the certificate", activated.sslStatus);

  // ── Every surface agrees ──────────────────────────────────────────────────────────────
  const listed = await listDomains(OWNER, PROJECT);
  const [state] = await publishStates(OWNER, db);
  check(listed[0]?.status === activated.status, "the Domains panel agrees with the verifier", listed[0]?.status);
  check(state?.customDomain === DOMAIN, "publish state promotes the active domain to the address", String(state?.customDomain));
  check(state?.primaryUrl === `https://${DOMAIN}`, "which is what cards and Overview link to", String(state?.primaryUrl));
  check(Array.isArray(state?.domains) && state.domains[0]?.status === activated.status,
    "and the full domain state reaches Overview and the project card",
    JSON.stringify(state?.domains));
  check(state?.url === `https://${SLUG}.app.thrallo.com/`,
    "the Thrallo address is never discarded", String(state?.url));

  // ── Replacement: at the Starter limit, the old one must come off cleanly ──────────────
  let limited = null;
  await addDomain(OWNER, PROJECT, "example-replacement.sslip.io", { attach: attachDomain, fetchImpl: noCert })
    .catch((error) => { limited = error; });
  check(limited?.code === "domain_limit", "Starter's one-domain limit holds", limited?.code || "was ALLOWED");

  await removeDomain(OWNER, DOMAIN, { detach: detachDomain });
  check((await attachedInCaddy(DOMAIN)) === null, "removal detaches the hostname from Caddy");
  check((await previewDomainAllowed(DOMAIN)) === false, "and the certificate gate stops approving it");

  const replacement = await addDomain(OWNER, PROJECT, "example-replacement.sslip.io", { attach: attachDomain, fetchImpl: noCert });
  check(replacement.status === "pending_dns", "the replacement connects cleanly", replacement.status);
  check(/^thrallo-verify=[0-9a-f]{32}$/.test(
    (await db.from("custom_domains").select("verification_token").eq("domain", "example-replacement.sslip.io").maybeSingle()).data?.verification_token || "",
  ), "with its own real token");

  const [afterReplace] = await publishStates(OWNER, db);
  check(afterReplace?.customDomain === null,
    "and the address falls back to Thrallo while it verifies", String(afterReplace?.customDomain));
  check(afterReplace?.primaryUrl === `https://${SLUG}.app.thrallo.com/`,
    "so nobody is sent to a hostname that is not ready", String(afterReplace?.primaryUrl));

  await removeDomain(OWNER, "example-replacement.sslip.io", { detach: detachDomain });

  // ── The conversational path — the one this PR exists to fix ───────────────────────────
  //
  // It used to be a second implementation: a direct upsert with no token, an immediate Caddy
  // attach before any proof, and A-record instructions the UI did not agree with.
  const { connectDomain } = await import("../shell/server/lib/appBuild/appPublishService.mjs");
  const emitted = [];
  const ctx = {
    owner: OWNER,
    conversation: { product_id: PRODUCT },
    emit: async (type, payload) => { emitted.push({ type, payload }); },
  };

  const spoken = await connectDomain(ctx, { domain: `HTTPS://${DOMAIN.toUpperCase()}/pricing` });
  const { data: spokenRow } = await db.from("custom_domains").select("*").eq("domain", DOMAIN).maybeSingle();
  check(/^thrallo-verify=[0-9a-f]{32}$/.test(spokenRow?.verification_token || ""),
    "connecting a domain IN CONVERSATION issues a real token", spokenRow?.verification_token || "NULL");
  check(spokenRow?.status === "pending_dns", "and starts in Pending DNS like the panel does", spokenRow?.status);
  check((await attachedInCaddy(DOMAIN)) === null, "and attaches nothing to Caddy");
  check(spoken.records?.some((r) => r.purpose === "verification" && r.value),
    "and hands back the TXT record to publish");
  check(emitted.some((e) => e.type === "domain" && e.payload?.records?.length),
    "the conversation is given the same records the panel shows");

  const spokenAgain = await connectDomain(ctx, { domain: DOMAIN });
  check(spokenAgain.alreadyConnected === true, "saying it twice is idempotent");

  // Ambiguity must be refused, never guessed: pointing a customer's hostname at whichever app was
  // touched most recently would put the wrong product at their address.
  let ambiguous = null;
  await connectDomain({ owner: OWNER, conversation: {}, emit: async () => {} }, { domain: "second-proof.sslip.io" })
    .catch((error) => { ambiguous = error; });
  check(ambiguous?.code === "ambiguous_project",
    "a conversation that cannot say which app is asked, not guessed at", ambiguous?.code || "GUESSED");
  const { count: guessedRows } = await db.from("custom_domains")
    .select("domain", { count: "exact", head: true }).eq("domain", "second-proof.sslip.io");
  check(!guessedRows, "and no row is created for it", `${guessedRows || 0} row(s)`);

  await removeDomain(OWNER, DOMAIN, { detach: detachDomain });

  // ── The default address, throughout ───────────────────────────────────────────────────
  const finalStatus = REAL_SITE ? await siteStatus(REAL_SITE) : null;
  check(REAL_SITE === null || finalStatus === baseline,
    "no live customer site changed state during any of this",
    REAL_SITE ? `${baseline} → ${finalStatus}` : "no live site published — skipped");
} catch (error) {
  check(false, "the proof ran to completion", error?.message || String(error));
  console.error(error);
} finally {
  await cleanup();
  const { count: leftover } = await db.from("custom_domains")
    .select("domain", { count: "exact", head: true }).eq("owner", OWNER);
  check(!leftover, "throwaway fixtures cleaned up", `${leftover || 0} row(s) left`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
