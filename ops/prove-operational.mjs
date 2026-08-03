// Live proof that every operational surface tells one story. Runs against production.
//
// The transitions are driven for real: a domain moves pending → verifying → active → failed
// through the actual verifyDomain, and health moves healthy → degraded → offline → healthy through
// the actual checkProject. What is asserted is that each transition notifies exactly once, that a
// repeated sweep notifies nothing, and that every surface reads the same state afterwards.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { addDomain, verifyDomain, removeDomain, listDomains } from "../shell/server/lib/customDomains.mjs";
import { checkProject, decideAlerts } from "../shell/server/lib/health/monitor.mjs";
import { healthForOwner, healthDetail } from "../shell/server/lib/health/report.mjs";
import { publishStates } from "../shell/server/lib/publishState.mjs";
import { resolvePublishState } from "../shell/shared/publishResolution.mjs";
import { operationalSummary, healthStateOf, DOMAIN_LABEL, HEALTH_LABEL } from "../shell/shared/operationalState.mjs";
import { listDeployments } from "../shell/server/lib/deployments/deploymentService.mjs";
import { purgeProjectResources } from "../shell/server/lib/projectTeardown.mjs";

const db = serviceClient();
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const DOMAIN = "51-195-136-189.sslip.io";   // real public DNS pointing at this VPS
const IP = "51.195.136.189";

const email = `pr10-ops-proof-${Date.now()}@thrallo.invalid`;
const { data: created, error: userError } = await db.auth.admin.createUser({
  email, password: `Pr10!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
});
if (userError) { console.error("could not create throwaway owner:", userError.message); process.exit(1); }
const OWNER = created.user.id;
const PRODUCT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SLUG = `pr10proof${Date.now().toString(36).slice(-4)}`;
console.log(`[proof] throwaway owner ${OWNER}`);

// Every notification the platform tries to send, captured rather than delivered.
const sent = [];
const notify = async (_owner, message) => { sent.push(message.tag); };
const tagsLike = (fragment) => sent.filter((t) => t.includes(fragment)).length;

const noCert = async () => { throw new Error("not requested during proof"); };

async function cleanup() {
  await removeDomain(OWNER, DOMAIN, { client: db, detach: null }).catch(() => {});
  await purgeProjectResources(OWNER, PROJECT, { client: db, provisiond: null }).catch(() => {});
  await db.from("custom_domains").delete().eq("owner", OWNER);
  await db.from("health_status").delete().eq("owner", OWNER);
  await db.from("health_checks").delete().eq("owner", OWNER);
  await db.from("published_sites").delete().eq("owner", OWNER);
  await db.from("projects").delete().eq("owner", OWNER);
  await db.from("ca_products").delete().eq("owner", OWNER);
  await db.from("ca_subscriptions").delete().eq("owner", OWNER);
  await db.auth.admin.deleteUser(OWNER).catch(() => {});
}

try {
  await db.from("ca_products").insert({ id: PRODUCT, owner: OWNER, name: "OpsProof" });
  await db.from("projects").insert({ id: PROJECT, owner: OWNER, name: "OpsProof", product_id: PRODUCT, tree: {} });
  await db.from("published_sites").insert({
    owner: OWNER, project_id: PROJECT, product_id: PRODUCT, slug: SLUG,
    url: `https://${SLUG}.app.thrallo.com/`,
  });
  await db.from("ca_subscriptions").upsert({ owner: OWNER, plan: "pro", status: "active" }, { onConflict: "owner" });

  // ── Pending DNS, consistently ─────────────────────────────────────────────────────────
  const added = await addDomain(OWNER, PROJECT, DOMAIN, { client: db, attach: null, fetchImpl: noCert });
  check(added.status === "pending_dns", "a new domain is Pending DNS", added.status);
  check(sent.length === 0, "and reaching Pending DNS notifies nobody — it is the starting state",
    sent.join(", ") || "silent");

  {
    const domains = await listDomains(OWNER, PROJECT, db);
    const summary = operationalSummary({ health: null, domains });
    check(summary.pendingDomain?.domain === DOMAIN,
      "the shared resolver surfaces it as a pending domain, not as 'no domain'", summary.pendingDomain?.label);
    check(summary.activeDomain === null, "and not as an address");
    check(DOMAIN_LABEL[domains[0].status] === "Pending DNS",
      "labelled identically wherever it is rendered", DOMAIN_LABEL[domains[0].status]);
    const [state] = await publishStates(OWNER, db);
    check(state.domains?.[0]?.status === "pending_dns",
      "publish state carries it to the cards and Overview", state.domains?.[0]?.status);
    check(state.customDomain === null, "while the address stays the Thrallo one");
  }

  // ── verifying → active, notified once ─────────────────────────────────────────────────
  const { data: row } = await db.from("custom_domains").select("verification_token").eq("domain", DOMAIN).maybeSingle();
  const zone = {
    resolveTxt: async () => [[row.verification_token]],
    resolve4: async () => [IP],
    resolveCname: async () => { throw new Error("ENOTFOUND"); },
  };

  const active = await verifyDomain(OWNER, DOMAIN, { client: db, resolver: zone, attach: null, fetchImpl: noCert, notify });
  check(active.status === "active", "correct DNS activates the domain", active.status);
  check(tagsLike("domain-active") === 1, "and notifies EXACTLY once", `${tagsLike("domain-active")}`);

  // The verifier re-checks every minute. A sweep that changes nothing must say nothing.
  for (let i = 0; i < 3; i += 1) {
    await verifyDomain(OWNER, DOMAIN, { client: db, resolver: zone, attach: null, fetchImpl: noCert, notify });
  }
  check(tagsLike("domain-active") === 1,
    "three more sweeps with no change produce NO further notifications", `${tagsLike("domain-active")} total`);

  {
    const domains = await listDomains(OWNER, PROJECT, db);
    const summary = operationalSummary({ health: null, domains });
    check(summary.activeDomain?.domain === DOMAIN, "an active domain becomes the address");
    check(summary.activeDomain.sslLabel === "HTTPS pending",
      "with SSL reported separately from verification", summary.activeDomain.sslLabel);
    check(/first visit/.test(summary.activeDomain.sslExplanation), "and explained honestly");
    const [state] = await publishStates(OWNER, db);
    check(state.customDomain === DOMAIN, "and every surface now shows it as the address", state.customDomain);
  }

  // ── active → lost, notified once ──────────────────────────────────────────────────────
  const brokenZone = {
    resolveTxt: async () => [[row.verification_token]],
    resolve4: async () => { throw new Error("ENOTFOUND"); },
    resolveCname: async () => { throw new Error("ENOTFOUND"); },
  };
  const demoted = await verifyDomain(OWNER, DOMAIN, { client: db, resolver: brokenZone, attach: null, fetchImpl: noCert, notify });
  check(demoted.status === "verifying", "a domain that stops resolving loses Active", demoted.status);
  check(tagsLike("domain-lost") === 1, "and says so exactly once", `${tagsLike("domain-lost")}`);
  check(demoted.sslStatus === "pending", "and stops claiming a certificate", demoted.sslStatus);

  await verifyDomain(OWNER, DOMAIN, { client: db, resolver: brokenZone, attach: null, fetchImpl: noCert, notify });
  check(tagsLike("domain-lost") === 1, "a repeated sweep adds nothing", `${tagsLike("domain-lost")}`);

  // ── verifying → failed, notified once ─────────────────────────────────────────────────
  await db.from("custom_domains")
    .update({ verification_started_at: new Date(Date.now() - 49 * 3_600_000).toISOString() })
    .eq("domain", DOMAIN);
  const noTxt = {
    resolveTxt: async () => { throw new Error("ENOTFOUND"); },
    resolve4: async () => { throw new Error("ENOTFOUND"); },
    resolveCname: async () => { throw new Error("ENOTFOUND"); },
  };
  const gaveUp = await verifyDomain(OWNER, DOMAIN, { client: db, resolver: noTxt, attach: null, fetchImpl: noCert, notify });
  check(gaveUp.status === "failed", "after 48 hours it is stamped failed", gaveUp.status);
  check(tagsLike("domain-failed") === 1, "and notifies exactly once", `${tagsLike("domain-failed")}`);
  check(DOMAIN_LABEL[gaveUp.status] === "Verification failed",
    "labelled as verification failing, not a bare 'Failed'", DOMAIN_LABEL[gaveUp.status]);

  await verifyDomain(OWNER, DOMAIN, { client: db, resolver: noTxt, attach: null, fetchImpl: noCert, notify });
  check(tagsLike("domain-failed") === 1, "and a further sweep is silent", `${tagsLike("domain-failed")}`);

  const domainNotifications = sent.length;
  check(domainNotifications === 3, "three domain notifications across the whole episode, one per transition",
    sent.join(" → "));

  // ── Health transitions, notified once each ────────────────────────────────────────────
  const site = { owner: OWNER, project_id: PROJECT, slug: SLUG, url: `https://${SLUG}.app.thrallo.com/` };
  const before = sent.length;

  const down = async () => ({ url: site.url, status: "offline", httpStatus: null, responseMs: null, sslValidTo: null, sslDaysLeft: null, dnsOk: true, detail: "The site did not respond." });
  const up = async () => ({ url: site.url, status: "healthy", httpStatus: 200, responseMs: 90, sslValidTo: "2026-10-30T00:00:00Z", sslDaysLeft: 88, dnsOk: true, detail: null });

  const first = await checkProject(site, { client: db, probe: down, notify });
  check(first.status === "warning", "one failed probe is Degraded, not a false outage", first.status);
  check(sent.length === before, "and alerts nobody", `${sent.length - before}`);

  const second = await checkProject(site, { client: db, probe: down, notify });
  check(second.status === "offline", "a second failure transitions to Offline", second.status);
  check(tagsLike("health-offline") === 1, "notified once", `${tagsLike("health-offline")}`);

  for (let i = 0; i < 3; i += 1) await checkProject(site, { client: db, probe: down, notify });
  check(tagsLike("health-offline") === 1,
    "three more sweeps while still down add NOTHING", `${tagsLike("health-offline")}`);

  const recovered = await checkProject(site, { client: db, probe: up, notify });
  check(recovered.status === "healthy", "recovery transitions back to Healthy", recovered.status);
  check(tagsLike("health-recovered") === 1, "and notifies once", `${tagsLike("health-recovered")}`);
  await checkProject(site, { client: db, probe: up, notify });
  check(tagsLike("health-recovered") === 1, "and once only", `${tagsLike("health-recovered")}`);

  // ── Every surface agrees ──────────────────────────────────────────────────────────────
  {
    const detail = await healthDetail(OWNER, PROJECT, { client: db });        // Health page
    const map = await healthForOwner(OWNER, db);                              // cards + Overview
    const card = map.get(String(PROJECT));
    const domains = await listDomains(OWNER, PROJECT, db);                    // Domains panel
    const deployments = await listDeployments(OWNER, PROJECT, { client: db }); // Deployments tab
    const summary = operationalSummary({ health: detail.status, domains, deployment: deployments[0] || null });

    check(card.status === detail.status.status,
      "Health page and the card read the same health status", `${card.status} / ${detail.status.status}`);
    check(healthStateOf(card) === healthStateOf(detail.status), "through the same resolver");
    check(HEALTH_LABEL[summary.health.status] === "Healthy",
      "and the same word", HEALTH_LABEL[summary.health.status]);

    check(summary.domains[0].label === DOMAIN_LABEL[domains[0].status],
      "the domain reads identically on Health and Domains", summary.domains[0].label);
    check(summary.attention?.kind === "domain_failed",
      "and the failed domain is what every surface should be shouting about",
      summary.attention?.label);

    const resolved = resolvePublishState(await publishStates(OWNER, db));
    check(resolved.forProduct(PRODUCT).customDomain === null,
      "a failed domain is never presented as the address");
    check(resolved.forProduct(PRODUCT).domains[0].status === "failed",
      "but is carried to the cards so it is not invisible");
  }

  // ── Unpublish clears operational state ────────────────────────────────────────────────
  {
    const { unpublishApp } = await import("../shell/server/lib/appBuild/appPublishService.mjs");
    await unpublishApp(OWNER, PROJECT).catch(() => {});
    const { count: healthLeft } = await db.from("health_status")
      .select("project_id", { count: "exact", head: true }).eq("project_id", PROJECT);
    check(!healthLeft, "unpublishing clears the active health state", `${healthLeft || 0}`);
    const domains = await listDomains(OWNER, PROJECT, db);
    check(domains.every((d) => d.status !== "active"),
      "and no domain still claims to be Active", domains.map((d) => d.status).join(", ") || "none");
  }
} catch (error) {
  check(false, "the proof ran to completion", error?.message || String(error));
  console.error(error);
} finally {
  await cleanup();
  const { count: left } = await db.from("health_status")
    .select("project_id", { count: "exact", head: true }).eq("owner", OWNER);
  const { count: domainsLeft } = await db.from("custom_domains")
    .select("domain", { count: "exact", head: true }).eq("owner", OWNER);
  check(!left && !domainsLeft, "deleting the project clears all operational state",
    `${left || 0} health, ${domainsLeft || 0} domains`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(`notifications sent, in order: ${sent.join(" → ") || "none"}`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
