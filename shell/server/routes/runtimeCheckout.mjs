import { stripe } from "../lib/services.mjs";
import { ownerFromToken, serviceClient } from "../lib/supabase.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function safePath(value, fallback) {
  const result = String(value || fallback);
  return result.startsWith("/") && !result.startsWith("//") && !result.includes("\\") ? result.slice(0, 500) : fallback;
}

async function originOwnsApp(client, appId, origin) {
  try {
    if (!origin?.startsWith("https://")) return false;
    const host = new URL(origin).hostname.toLowerCase();
    const { data: site } = await client.from("published_sites").select("slug").eq("project_id", appId).maybeSingle();
    if (site && host === `${site.slug}.app.buildr101.com`) return true;
    const { data: domain } = await client.from("custom_domains").select("domain").eq("project_id", appId)
      .eq("domain", host).not("verified_at", "is", null).maybeSingle();
    return !!domain;
  } catch { return false; }
}

export async function handleRuntimeCheckout(req, res, body, accessToken, origin) {
  const appId = String(body?.appId || "");
  const productId = String(body?.productId || "");
  if (!/^[0-9a-f-]{36}$/i.test(appId) || !/^[0-9a-f-]{36}$/i.test(productId)) {
    return json(res, 400, { error: "Valid app and product are required." });
  }
  const appUser = await ownerFromToken(accessToken);
  if (!appUser) return json(res, 401, { error: "Sign in before checkout." });
  const client = serviceClient();
  if (!(await originOwnsApp(client, appId, origin))) return json(res, 403, { error: "Checkout must start from this app's live domain." });
  const { data: mapping } = await client.from("app_users").select("email,status")
    .eq("app_id", appId).eq("auth_user_id", appUser.id).maybeSingle();
  if (!mapping || mapping.status !== "active") return json(res, 403, { error: "This account cannot start checkout." });
  const { data: feature } = await client.from("feature_flags").select("enabled").eq("key", "saas_runtime").maybeSingle();
  if (!feature?.enabled) return json(res, 503, { error: "Payments are not available yet." });
  const { data: product } = await client.from("payment_products")
    .select("id,project_id,owner,name,description,currency,unit_amount,usage_units,active")
    .eq("id", productId).eq("project_id", appId).eq("active", true).maybeSingle();
  if (!product) return json(res, 404, { error: "Product is unavailable." });
  const { data: linked } = await client.from("project_integrations").select("status,config")
    .eq("project_id", appId).eq("owner", product.owner).eq("provider", "stripe_connect")
    .eq("environment", "live").maybeSingle();
  const accountId = linked?.config?.account_id;
  if (!accountId || linked.status !== "connected") return json(res, 409, { error: "The app owner has not finished payment setup." });
  const successPath = safePath(body.successPath, "/?checkout=success");
  const cancelPath = safePath(body.cancelPath, "/?checkout=cancel");
  const feeBps = Math.max(0, Math.min(2500, Number(linked.config?.platform_fee_bps || 0)));
  try {
    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      line_items: [{ price_data: { currency: product.currency, unit_amount: product.unit_amount,
        product_data: { name: product.name, ...(product.description ? { description: product.description } : {}) } }, quantity: 1 }],
      success_url: `${origin}${successPath}${successPath.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}${cancelPath}`,
      customer_email: mapping.email,
      metadata: { buildr_project: appId, buildr_product: product.id, buildr_app_user: appUser.id },
      payment_intent_data: {
        metadata: { buildr_project: appId, buildr_product: product.id, buildr_app_user: appUser.id },
        ...(feeBps ? { application_fee_amount: Math.floor(product.unit_amount * feeBps / 10_000) } : {}),
      },
    }, { stripeAccount: accountId });
    return json(res, 200, { id: session.id, url: session.url });
  } catch (error) {
    console.error(`[runtime-checkout] ${error?.message || error}`);
    return json(res, 502, { error: "Checkout could not be started." });
  }
}
