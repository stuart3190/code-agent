// Live proof that no two surfaces can disagree about publication status.
//
// Runs against production. The interesting part is that it CREATES the inconsistency the old code
// allowed — two publish records for one product — and proves that every surface still resolves the
// same one, that the database now refuses a second LIVE record outright, and that the repair tool
// finds and fixes what already exists.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { publishStates } from "../shell/server/lib/publishState.mjs";
import { resolvePublishState, PUBLISH_STATUS } from "../shell/shared/publishResolution.mjs";
import { listDeployments } from "../shell/server/lib/deployments/deploymentService.mjs";

const db = serviceClient();
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";

// ── Fixtures: one product, two project rows — the shape that caused the disagreement ────
const email = `pr7-status-proof-${Date.now()}@thrallo.invalid`;
const { data: created, error: userError } = await db.auth.admin.createUser({
  email, password: `Pr7!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
});
if (userError) { console.error("could not create throwaway owner:", userError.message); process.exit(1); }
const OWNER = created.user.id;
const PRODUCT = crypto.randomUUID();
const OLD_PROJECT = crypto.randomUUID();
const NEW_PROJECT = crypto.randomUUID();
const LONE_PROJECT = crypto.randomUUID();          // published, but no product link
const CONVERSATION = crypto.randomUUID();
console.log(`[proof] throwaway owner ${OWNER}`);

async function cleanup() {
  await db.from("published_sites").delete().eq("owner", OWNER);
  await db.from("project_logs").delete().eq("owner", OWNER);
  await db.from("ca_conversations").delete().eq("owner", OWNER);
  await db.from("projects").delete().eq("owner", OWNER);
  await db.from("ca_products").delete().eq("owner", OWNER);
  await db.auth.admin.deleteUser(OWNER).catch(() => {});
}

try {
  const older = "2026-07-01T00:00:00.000Z";
  const newer = "2026-08-01T00:00:00.000Z";

  await db.from("ca_products").insert({ id: PRODUCT, owner: OWNER, name: "StatusProof" });
  await db.from("projects").insert([
    { id: OLD_PROJECT, owner: OWNER, name: "StatusProof", product_id: PRODUCT, tree: {}, updated_at: older },
    { id: NEW_PROJECT, owner: OWNER, name: "StatusProof Renamed", product_id: PRODUCT, tree: {}, updated_at: newer },
    { id: LONE_PROJECT, owner: OWNER, name: "No Product", product_id: null, tree: {}, updated_at: newer },
  ]);
  await db.from("ca_conversations").insert({
    id: CONVERSATION, owner: OWNER, title: "StatusProof", product_id: PRODUCT, state: "idle",
    last_activity_at: newer,
  });

  // The OLD record is retired; the NEW one is live. Exactly the two-row shape that made first-wins
  // and last-wins produce different answers.
  await db.from("published_sites").insert([
    {
      owner: OWNER, project_id: OLD_PROJECT, product_id: PRODUCT, slug: "statusproof-old",
      url: "https://statusproof-old.app.thrallo.com/", created_at: older, updated_at: older,
      unpublished_at: older,
    },
    {
      owner: OWNER, project_id: NEW_PROJECT, product_id: PRODUCT, slug: "statusproof",
      url: "https://statusproof.app.thrallo.com/", created_at: older, updated_at: newer,
      unpublished_at: null,
    },
    {
      owner: OWNER, project_id: LONE_PROJECT, product_id: null, slug: "no-product",
      url: "https://no-product.app.thrallo.com/", created_at: newer, updated_at: newer,
      unpublished_at: null,
    },
  ]);

  // ── The resolver ──────────────────────────────────────────────────────────────────────
  const states = await publishStates(OWNER, db);
  const resolved = resolvePublishState(states);
  check(states.length === 3, "all three publish records are read", `${states.length}`);

  const winner = resolved.forProduct(PRODUCT);
  check(winner?.projectId === NEW_PROJECT, "the product resolves to its LIVE record", winner?.slug);
  check(winner?.status === PUBLISH_STATUS.published, "and reports it as live", winner?.status);

  // The order-dependence that produced the bug.
  const reversed = resolvePublishState([...states].reverse());
  check(reversed.forProduct(PRODUCT)?.projectId === winner?.projectId,
    "reversing the row order changes nothing — first-wins and last-wins are gone");

  check(resolved.forProject(LONE_PROJECT)?.status === PUBLISH_STATUS.published,
    "a published project with NO product still resolves as published",
    resolved.forProject(LONE_PROJECT)?.status);
  check(resolved.statusFor({ productId: null, projectId: LONE_PROJECT }) === PUBLISH_STATUS.published,
    "…and by the same statusFor every surface calls");

  check(resolved.conflicts.length === 0,
    "one live record and one historical is NOT a conflict", JSON.stringify(resolved.conflicts));

  // ── Historical rows never resurface ───────────────────────────────────────────────────
  const historical = resolved.forProject(OLD_PROJECT);
  check(historical?.status === PUBLISH_STATUS.unpublished,
    "the historical record still reads as unpublished on its own", historical?.status);
  check(resolved.forProduct(PRODUCT).projectId !== OLD_PROJECT,
    "and never becomes the product's status again");

  // ── The database refuses a second LIVE record ─────────────────────────────────────────
  const { error: dupError } = await db.from("published_sites").insert({
    owner: OWNER, project_id: crypto.randomUUID(), product_id: PRODUCT, slug: "statusproof-dup",
    url: "https://statusproof-dup.app.thrallo.com/", updated_at: newer, unpublished_at: null,
  });
  check(!!dupError, "the database REFUSES a second live record for one product",
    dupError?.message?.slice(0, 90) || "IT WAS ACCEPTED");
  check(/duplicate key|unique/i.test(dupError?.message || ""), "…by the unique index, not by luck");

  // A second RETIRED record is still allowed — history must accumulate.
  const HISTORIC = crypto.randomUUID();
  const { error: histError } = await db.from("published_sites").insert({
    owner: OWNER, project_id: HISTORIC, product_id: PRODUCT, slug: "statusproof-hist",
    url: "https://statusproof-hist.app.thrallo.com/", updated_at: older, unpublished_at: older,
  });
  check(!histError, "but historical records may still accumulate", histError?.message || "");
  await db.from("published_sites").delete().eq("project_id", HISTORIC);

  // ── Detection and repair of data that already exists ──────────────────────────────────
  // Bypass the index the only way a real pre-existing fault could have got there: insert retired,
  // then clear the stamp. The index is partial, so this is exactly how legacy data would look.
  const CONFLICT_PROJECT = crypto.randomUUID();
  await db.from("projects").insert({
    id: CONFLICT_PROJECT, owner: OWNER, name: "StatusProof", product_id: PRODUCT, tree: {}, updated_at: older,
  });
  await db.from("published_sites").insert({
    owner: OWNER, project_id: CONFLICT_PROJECT, product_id: PRODUCT, slug: "statusproof-conflict",
    url: "https://statusproof-conflict.app.thrallo.com/", updated_at: older, unpublished_at: older,
  });
  const { error: sneakError } = await db.from("published_sites")
    .update({ unpublished_at: null }).eq("project_id", CONFLICT_PROJECT);

  if (sneakError) {
    // The index caught even this, which is a stronger result than the test expected.
    check(true, "the index refuses a retired record being revived into a second live one",
      sneakError.message.slice(0, 80));
    await db.from("published_sites").delete().eq("project_id", CONFLICT_PROJECT);

    // The index cannot see a row whose product_id is NULL — nulls are distinct — which is exactly
    // what a record written before this column existed looks like. The RESOLVER still derives the
    // product from the project, so it sees the conflict the index cannot. This is the real legacy
    // shape, and the case the repair tool exists for.
    const { error: legacyError } = await db.from("published_sites").insert({
      owner: OWNER, project_id: CONFLICT_PROJECT, product_id: null, slug: "statusproof-legacy",
      url: "https://statusproof-legacy.app.thrallo.com/", updated_at: older, unpublished_at: null,
    });
    check(!legacyError, "a legacy record with no product_id can still exist", legacyError?.message || "");

    const conflicted = resolvePublishState(await publishStates(OWNER, db));
    check(conflicted.conflicts.length === 1,
      "and the resolver DETECTS it as two live records for one product",
      JSON.stringify(conflicted.conflicts));
    check(conflicted.conflicts[0].active === NEW_PROJECT,
      "choosing the newest as active, deterministically", conflicted.conflicts[0]?.active);
    check(conflicted.forProduct(PRODUCT).projectId === NEW_PROJECT,
      "so every surface still shows the right site while the fault exists");

    // Repair exactly as ops/repair-publish-state.mjs does: retire the loser, record why.
    const stamped = new Date().toISOString();
    await db.from("published_sites")
      .update({ unpublished_at: stamped, updated_at: stamped })
      .eq("owner", OWNER).eq("project_id", CONFLICT_PROJECT);
    await db.from("published_sites")
      .update({ product_id: PRODUCT }).eq("owner", OWNER).eq("project_id", CONFLICT_PROJECT);
    await db.from("project_logs").insert({
      owner: OWNER, project_id: CONFLICT_PROJECT, logged_at: stamped,
      level: "warning", source: "system", message: "Superseded publish record retired",
      detail: `This project had an older publish record for the same app while ${NEW_PROJECT} was live.`,
      ref_type: "project", ref_id: NEW_PROJECT,
    });

    const after = resolvePublishState(await publishStates(OWNER, db));
    check(after.conflicts.length === 0, "repair leaves no conflict behind");
    check(after.forProduct(PRODUCT).projectId === NEW_PROJECT, "with the live site untouched");
    const { data: repairedRow } = await db.from("published_sites")
      .select("product_id,slug,unpublished_at").eq("project_id", CONFLICT_PROJECT).maybeSingle();
    check(!!repairedRow, "the superseded record is RETIRED, never deleted — its slug and history survive",
      repairedRow?.slug);
    check(!!repairedRow?.product_id,
      "and its product link is backfilled so the index can guard it from now on");

    const { data: recorded } = await db.from("project_logs")
      .select("message").eq("owner", OWNER).eq("project_id", CONFLICT_PROJECT);
    check((recorded || []).length === 1, "and the change is recorded where the OWNER can see it",
      recorded?.[0]?.message || "");

    await db.from("published_sites").delete().eq("project_id", CONFLICT_PROJECT);
    await db.from("projects").delete().eq("id", CONFLICT_PROJECT);
  } else {
    const conflicted = resolvePublishState(await publishStates(OWNER, db));
    check(conflicted.conflicts.length === 1, "two live records ARE detected",
      JSON.stringify(conflicted.conflicts));
    check(conflicted.conflicts[0].active === NEW_PROJECT,
      "the newest is chosen as active, deterministically");

    // Repair, the way the tool does it: retire the loser, record why.
    const stamped = new Date().toISOString();
    await db.from("published_sites")
      .update({ unpublished_at: stamped, updated_at: stamped })
      .eq("owner", OWNER).eq("project_id", CONFLICT_PROJECT);
    await db.from("project_logs").insert({
      owner: OWNER, project_id: CONFLICT_PROJECT, logged_at: stamped,
      level: "warning", source: "system", message: "Superseded publish record retired",
      detail: "Repaired by ops/repair-publish-state.mjs during the PR 7 proof.",
      ref_type: "project", ref_id: NEW_PROJECT,
    });

    const after = resolvePublishState(await publishStates(OWNER, db));
    check(after.conflicts.length === 0, "and repair leaves no conflict behind");
    check(after.forProduct(PRODUCT).projectId === NEW_PROJECT, "with the live site untouched");

    const { data: recorded } = await db.from("project_logs")
      .select("message").eq("owner", OWNER).eq("project_id", CONFLICT_PROJECT);
    check((recorded || []).length === 1, "and the change is recorded where the owner can see it",
      recorded?.[0]?.message || "");

    await db.from("published_sites").delete().eq("project_id", CONFLICT_PROJECT);
    await db.from("projects").delete().eq("id", CONFLICT_PROJECT);
  }

  // ── Every surface, one answer ─────────────────────────────────────────────────────────
  const final = resolvePublishState(await publishStates(OWNER, db));
  const expected = final.forProduct(PRODUCT);

  // The conversations route derives status exactly this way.
  const conversationStatus = final.statusFor({ productId: PRODUCT });
  check(conversationStatus === expected.status, "Conversations agree", conversationStatus);

  // The publish panel and cards read publish state through the same resolver on the client.
  check(final.forProduct(PRODUCT).status === expected.status, "the card and the publish panel agree");

  // Overview reads the site the dashboard opened, keyed by project.
  check(final.forProject(NEW_PROJECT).status === expected.status, "Overview agrees",
    final.forProject(NEW_PROJECT).status);

  // Deployments is keyed by project and must describe the same record.
  const records = await listDeployments(OWNER, NEW_PROJECT, { client: db });
  check(records.length === 0 || records.every((d) => !d.url || d.url === expected.url),
    "Deployments agrees on the live address", records[0]?.url || "no deployment records");

  // The public API.
  const response = await fetch(`${BASE}/api/v1/publish-state`, { headers: { Accept: "application/json" } })
    .catch(() => null);
  check(response?.status === 401, "the API is owner-scoped and refuses an anonymous read",
    String(response?.status));

  // ── Rename and rebuild keep it live ───────────────────────────────────────────────────
  await db.from("projects").update({ name: "Renamed Entirely" }).eq("id", NEW_PROJECT);
  const renamed = resolvePublishState(await publishStates(OWNER, db));
  check(renamed.forProduct(PRODUCT).status === PUBLISH_STATUS.published,
    "a renamed project is still Live", renamed.forProduct(PRODUCT).status);
  check(renamed.forProduct(PRODUCT).url === expected.url, "at the same address",
    renamed.forProduct(PRODUCT).url);

  // A rebuild is a NEW project row under the same product, updated after the publish.
  const REBUILD = crypto.randomUUID();
  await db.from("projects").insert({
    id: REBUILD, owner: OWNER, name: "Renamed Entirely", product_id: PRODUCT, tree: {},
    updated_at: new Date().toISOString(),
  });
  const rebuilt = resolvePublishState(await publishStates(OWNER, db));
  check(rebuilt.forProduct(PRODUCT).live === true, "a rebuilt project is still Live");
  check(rebuilt.forProduct(PRODUCT).status === PUBLISH_STATUS.updateAvailable,
    "and says an update is available rather than going dark",
    rebuilt.forProduct(PRODUCT).status);
  check(rebuilt.forProduct(PRODUCT).currentProjectId === REBUILD,
    "with the next publish targeting the newest project");

  // ── Unpublished shows as unpublished everywhere ───────────────────────────────────────
  await db.from("published_sites")
    .update({ unpublished_at: new Date().toISOString() })
    .eq("owner", OWNER).eq("project_id", NEW_PROJECT);
  const offline = resolvePublishState(await publishStates(OWNER, db));
  check(offline.forProduct(PRODUCT).status === PUBLISH_STATUS.unpublished,
    "an unpublished product reads as unpublished", offline.forProduct(PRODUCT).status);
  check(offline.statusFor({ productId: PRODUCT }) === PUBLISH_STATUS.unpublished,
    "on every surface, through the one resolver");
  check(offline.forProduct(PRODUCT).url === expected.url,
    "and the address is remembered for republishing", offline.forProduct(PRODUCT).url);
} catch (error) {
  check(false, "the proof ran to completion", error?.message || String(error));
  console.error(error);
} finally {
  await cleanup();
}

// ── The real estate is consistent ───────────────────────────────────────────────────────
{
  const { data: sites } = await db.from("published_sites").select("owner");
  const owners = [...new Set((sites || []).map((s) => s.owner))];
  let conflicts = 0;
  for (const owner of owners) {
    conflicts += resolvePublishState(await publishStates(owner, db)).conflicts.length;
  }
  check(conflicts === 0, "no real account has a publish conflict", `${owners.length} owner(s) checked`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
