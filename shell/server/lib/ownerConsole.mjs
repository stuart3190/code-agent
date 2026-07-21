import { requireFeature } from "./features.mjs";
import { auditEvent } from "./projectState.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

export function summarizeConsole(users = [], records = [], orders = []) {
  const entityCounts = {};
  for (const record of records) entityCounts[record.type] = (entityCounts[record.type] || 0) + 1;
  const paidOrders = orders.filter((order) => order.status === "paid");
  return {
    stats: {
      users: users.length,
      activeUsers: users.filter((user) => user.status === "active").length,
      records: records.length,
      paidOrders: paidOrders.length,
      revenueByCurrency: paidOrders.reduce((totals, order) => ({ ...totals, [order.currency]: (totals[order.currency] || 0) + order.amount_total }), {}),
    },
    entityCounts,
  };
}

export async function ownerConsoleOverview(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "owner_console");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const [{ data: users, error: userError }, { data: records, error: recordError }, { data: orders, error: orderError }] = await Promise.all([
    client.from("app_users").select("id,email,status,created_at,updated_at").eq("app_id", projectId).order("created_at", { ascending: false }).limit(100),
    client.from("entities").select("id,type,data,created_at").eq("app_id", projectId).order("created_at", { ascending: false }).limit(200),
    client.from("payment_orders").select("id,amount_total,currency,customer_email,status,created_at").eq("project_id", projectId).eq("owner", owner.id)
      .order("created_at", { ascending: false }).limit(50),
  ]);
  if (userError) throw new Error(`console users: ${userError.message}`);
  if (recordError) throw new Error(`console data: ${recordError.message}`);
  if (orderError) throw new Error(`console orders: ${orderError.message}`);
  const summary = summarizeConsole(users || [], records || [], orders || []);
  return {
    ...summary,
    users: users || [],
    records: records || [],
    orders: orders || [],
    truncated: { users: (users || []).length === 100, records: (records || []).length === 200 },
  };
}

export async function setAppUserStatus(owner, projectId, mappingId, status, client = serviceClient()) {
  await requireFeature(owner, "owner_console");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  if (!["active", "disabled"].includes(status)) throw Object.assign(new Error("status must be active or disabled"), { code: "bad_status" });
  const { data: mapping, error } = await client.from("app_users").select("id,auth_user_id,email,status")
    .eq("id", mappingId).eq("app_id", projectId).maybeSingle();
  if (error) throw new Error(`console user lookup: ${error.message}`);
  if (!mapping) return false;
  const { error: authError } = await client.auth.admin.updateUserById(mapping.auth_user_id, {
    ban_duration: status === "disabled" ? "876000h" : "none",
  });
  if (authError) throw new Error(`console user auth: ${authError.message}`);
  const { error: updateError } = await client.from("app_users").update({ status, updated_at: new Date().toISOString() }).eq("id", mapping.id);
  if (updateError) throw new Error(`console user update: ${updateError.message}`);
  await auditEvent({ owner: owner.id, projectId, action: `app_user.${status}`, target: mapping.id, metadata: { email: mapping.email } }, client).catch(() => {});
  return { id: mapping.id, status };
}

export async function deleteAppRecord(owner, projectId, recordId, client = serviceClient()) {
  await requireFeature(owner, "owner_console");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const { data, error } = await client.from("entities").delete().eq("id", recordId).eq("app_id", projectId).select("id,type").maybeSingle();
  if (error) throw new Error(`console record delete: ${error.message}`);
  if (!data) return false;
  await auditEvent({ owner: owner.id, projectId, action: "app_record.deleted", target: data.id, metadata: { type: data.type } }, client).catch(() => {});
  return true;
}
