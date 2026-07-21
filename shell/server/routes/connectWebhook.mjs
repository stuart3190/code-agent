import { requireEnv } from "../lib/env.mjs";
import { stripe } from "../lib/services.mjs";
import { serviceClient } from "../lib/supabase.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function recordSession(event) {
  const session = event.data.object;
  const projectId = session.metadata?.buildr_project;
  const productId = session.metadata?.buildr_product;
  const appUserId = session.metadata?.buildr_app_user;
  if (!projectId || !productId || !event.account) return { ignored: true };
  const client = serviceClient();
  const { data: product } = await client.from("payment_products")
    .select("id,owner,project_id,currency,unit_amount,usage_units").eq("id", productId).eq("project_id", projectId).maybeSingle();
  if (!product) return { ignored: true };
  const { data: linked } = await client.from("project_integrations")
    .select("config").eq("project_id", projectId).eq("owner", product.owner)
    .eq("provider", "stripe_connect").eq("environment", "live").maybeSingle();
  if (linked?.config?.account_id !== event.account) return { ignored: true };
  const paid = event.type === "checkout.session.async_payment_failed" ? "failed"
    : session.payment_status === "paid" || event.type === "checkout.session.async_payment_succeeded" ? "paid" : "pending";
  const { error } = await client.from("payment_orders").upsert({
    project_id: product.project_id,
    owner: product.owner,
    app_user_id: appUserId || null,
    product_id: product.id,
    stripe_account_id: event.account,
    stripe_session_id: session.id,
    stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null,
    amount_total: session.amount_total ?? product.unit_amount,
    currency: session.currency || product.currency,
    customer_email: session.customer_details?.email || session.customer_email || null,
    status: paid,
    updated_at: new Date().toISOString(),
  }, { onConflict: "stripe_session_id" });
  if (error) throw new Error(`connect order record: ${error.message}`);
  if (paid === "paid" && appUserId && Number(product.usage_units || 0) > 0) {
    const { error: grantError } = await client.from("app_usage_ledger").insert({ project_id: product.project_id,
      app_user_id: appUserId, delta: product.usage_units, kind: "grant", ref: `stripe:${session.id}`, product_id: product.id });
    if (grantError && grantError.code !== "23505") throw new Error(`usage grant: ${grantError.message}`);
  }
  return { recorded: true };
}

export async function handleConnectWebhook(req, res, rawBody) {
  let event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, req.headers["stripe-signature"], requireEnv("STRIPE_CONNECT_WEBHOOK_SECRET"));
  } catch (error) {
    console.error(`[stripe-connect:signature] ${error?.message || error}`);
    return json(res, 400, { error: "signature verification failed" });
  }
  try {
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"].includes(event.type)) {
      await recordSession(event);
    }
    return json(res, 200, { received: true });
  } catch (error) {
    console.error(`[stripe-connect:handler] ${error?.stack || error}`);
    return json(res, 500, { error: "webhook processing failed" });
  }
}
