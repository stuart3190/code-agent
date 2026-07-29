import { optionalEnv } from "./env.mjs";
import { requireFeature } from "./features.mjs";
import { auditEvent } from "./projectState.mjs";
import { stripe } from "./services.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

const PROVIDER = "stripe_connect";

export function cleanProduct(input = {}) {
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const currency = String(input.currency || "gbp").trim().toLowerCase();
  const unitAmount = Number(input.unitAmount);
  const usageUnits = Math.max(0, Math.min(1_000_000_000, Number(input.usageUnits || 0)));
  const actionScope = Array.isArray(input.actionScope) ? input.actionScope.map((value) => String(value).trim()).filter((value) => /^[a-z][a-z0-9_.-]{1,79}$/.test(value)).slice(0, 100) : [];
  if (!name || name.length > 120) throw Object.assign(new Error("Product name must be 1 to 120 characters."), { code: "bad_product" });
  if (description.length > 500) throw Object.assign(new Error("Product description must be 500 characters or less."), { code: "bad_product" });
  if (!/^[a-z]{3}$/.test(currency)) throw Object.assign(new Error("Currency must be a three-letter code."), { code: "bad_product" });
  if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0 || unitAmount > 100_000_000) {
    throw Object.assign(new Error("Price must be a positive amount in the currency's smallest unit."), { code: "bad_product" });
  }
  return { name, description, currency, unit_amount: unitAmount, usage_units: Math.floor(usageUnits), action_scope: actionScope };
}

async function integration(owner, projectId, client) {
  const { data, error } = await client.from("project_integrations")
    .select("id,status,config,last_error,updated_at")
    .eq("owner", owner).eq("project_id", projectId).eq("environment", "live").eq("provider", PROVIDER).maybeSingle();
  if (error) throw new Error(`stripe integration: ${error.message}`);
  return data;
}

export async function paymentOverview(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "saas_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const linked = await integration(owner.id, projectId, client);
  let account = null;
  if (linked?.config?.account_id) {
    try {
      const remote = await stripe().accounts.retrieve(linked.config.account_id);
      account = {
        id: remote.id,
        chargesEnabled: !!remote.charges_enabled,
        payoutsEnabled: !!remote.payouts_enabled,
        detailsSubmitted: !!remote.details_submitted,
      };
      await client.from("project_integrations").update({
        status: remote.charges_enabled ? "connected" : "pending",
        config: { ...linked.config, ...account, account_id: remote.id },
        last_error: null, updated_at: new Date().toISOString(),
      }).eq("id", linked.id);
    } catch (error) {
      account = { id: linked.config.account_id, error: "Stripe account status is temporarily unavailable." };
    }
  }
  const [{ data: products, error: productError }, { data: orders, error: orderError }] = await Promise.all([
    client.from("payment_products").select("id,name,description,currency,unit_amount,usage_units,action_scope,active,created_at,updated_at")
      .eq("owner", owner.id).eq("project_id", projectId).order("created_at", { ascending: false }),
    client.from("payment_orders").select("id,product_id,amount_total,currency,customer_email,status,created_at")
      .eq("owner", owner.id).eq("project_id", projectId).order("created_at", { ascending: false }).limit(20),
  ]);
  if (productError) throw new Error(`payment products: ${productError.message}`);
  if (orderError) throw new Error(`payment orders: ${orderError.message}`);
  return { account, products: products || [], orders: orders || [] };
}

export async function beginStripeOnboarding(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "saas_runtime");
  if (!(await ownedProject(owner.id, projectId, "id,name", client))) return null;
  let linked = await integration(owner.id, projectId, client);
  let accountId = linked?.config?.account_id;
  if (!accountId) {
    const account = await stripe().accounts.create({
      type: "express",
      email: owner.email || undefined,
      business_profile: { product_description: "Payments for an app built with Buildr101" },
      metadata: { buildr_owner: owner.id, buildr_project: projectId },
    });
    accountId = account.id;
    const { data, error } = await client.from("project_integrations").upsert({
      owner: owner.id, project_id: projectId, provider: PROVIDER, environment: "live",
      status: "pending", config: { account_id: accountId }, last_error: null, updated_at: new Date().toISOString(),
    }, { onConflict: "project_id,environment,provider" }).select("id,status,config").single();
    if (error) throw new Error(`stripe integration create: ${error.message}`);
    linked = data;
    await auditEvent({ owner: owner.id, projectId, action: "stripe.connect.created", target: accountId }, client).catch(() => {});
  }
  const base = optionalEnv("APP_URL", "http://localhost:5173").replace(/\/$/, "");
  const link = await stripe().accountLinks.create({
    account: accountId,
    refresh_url: `${base}/?stripe=refresh&project=${encodeURIComponent(projectId)}`,
    return_url: `${base}/?stripe=return&project=${encodeURIComponent(projectId)}`,
    type: "account_onboarding",
  });
  return { url: link.url, accountId };
}

export async function createPaymentProduct(owner, projectId, input, client = serviceClient()) {
  await requireFeature(owner, "saas_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const row = cleanProduct(input);
  const { data, error } = await client.from("payment_products").insert({
    owner: owner.id, project_id: projectId, ...row,
  }).select("id,name,description,currency,unit_amount,usage_units,action_scope,active,created_at,updated_at").single();
  if (error) throw new Error(`payment product create: ${error.message}`);
  await auditEvent({ owner: owner.id, projectId, action: "payment.product.created", target: data.id }, client).catch(() => {});
  return data;
}

export async function updatePaymentProduct(owner, projectId, productId, input, client = serviceClient()) {
  await requireFeature(owner, "saas_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const patch = input.delete ? null : { ...cleanProduct(input), active: input.active !== false, updated_at: new Date().toISOString() };
  const query = client.from("payment_products");
  const { data, error } = patch
    ? await query.update(patch).eq("id", productId).eq("project_id", projectId).eq("owner", owner.id)
      .select("id,name,description,currency,unit_amount,usage_units,action_scope,active,created_at,updated_at").maybeSingle()
    : await query.delete().eq("id", productId).eq("project_id", projectId).eq("owner", owner.id).select("id").maybeSingle();
  if (error) throw new Error(`payment product update: ${error.message}`);
  if (data) await auditEvent({ owner: owner.id, projectId, action: patch ? "payment.product.updated" : "payment.product.deleted", target: productId }, client).catch(() => {});
  return data || false;
}
