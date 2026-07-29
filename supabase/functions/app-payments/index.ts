// Authenticated checkout for generated apps. Products and connected accounts are selected from
// server-managed records; the browser can never choose an amount or Stripe destination.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (status: number, body: unknown, origin: string) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });

function safePath(value: unknown, fallback: string) {
  const path = String(value || fallback);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return fallback;
  return path.slice(0, 500);
}

async function allowedOrigin(appId: string, origin: string) {
  if (!origin.startsWith("https://")) return false;
  const host = new URL(origin).hostname.toLowerCase();
  const { data: site } = await svc.from("published_sites").select("slug").eq("project_id", appId).maybeSingle();
  if (site && host === `${site.slug}.app.buildr101.com`) return true;
  const { data: domain } = await svc.from("custom_domains").select("domain")
    .eq("project_id", appId).eq("domain", host).not("verified_at", "is", null).maybeSingle();
  return !!domain;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin);
  if (!STRIPE_SECRET_KEY) return json(503, { error: "Payments are not configured yet." }, origin);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: authData, error: authError } = await svc.auth.getUser(token);
  if (authError || !authData.user) return json(401, { error: "Sign in before checkout." }, origin);
  let body: { appId?: string; productId?: string; successPath?: string; cancelPath?: string };
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }, origin); }
  const appId = String(body.appId || "");
  const productId = String(body.productId || "");
  if (!/^[0-9a-f-]{36}$/i.test(appId) || !/^[0-9a-f-]{36}$/i.test(productId)) {
    return json(400, { error: "Valid app and product are required." }, origin);
  }
  if (!(await allowedOrigin(appId, origin))) return json(403, { error: "Checkout must start from this app's live domain." }, origin);
  const { data: appUser } = await svc.from("app_users").select("email")
    .eq("app_id", appId).eq("auth_user_id", authData.user.id).maybeSingle();
  if (!appUser) return json(403, { error: "This account does not belong to this app." }, origin);
  const { data: product } = await svc.from("payment_products")
    .select("id,project_id,owner,name,description,currency,unit_amount,active")
    .eq("id", productId).eq("project_id", appId).eq("active", true).maybeSingle();
  if (!product) return json(404, { error: "Product is unavailable." }, origin);
  const { data: feature } = await svc.from("feature_flags").select("enabled").eq("key", "saas_runtime").maybeSingle();
  if (!feature?.enabled) return json(503, { error: "Payments are not available yet." }, origin);
  const { data: linked } = await svc.from("project_integrations").select("status,config")
    .eq("project_id", appId).eq("owner", product.owner).eq("provider", "stripe_connect")
    .eq("environment", "live").maybeSingle();
  const accountId = linked?.config?.account_id;
  if (!accountId || linked.status !== "connected") return json(409, { error: "The app owner has not finished payment setup." }, origin);

  const successPath = safePath(body.successPath, "/?checkout=success");
  const cancelPath = safePath(body.cancelPath, "/?checkout=cancel");
  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": product.currency,
    "line_items[0][price_data][unit_amount]": String(product.unit_amount),
    "line_items[0][price_data][product_data][name]": product.name,
    "line_items[0][quantity]": "1",
    success_url: `${origin}${successPath}${successPath.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${cancelPath}`,
    customer_email: appUser.email,
    "metadata[buildr_project]": appId,
    "metadata[buildr_product]": product.id,
    "metadata[buildr_app_user]": authData.user.id,
    "payment_intent_data[metadata][buildr_project]": appId,
    "payment_intent_data[metadata][buildr_product]": product.id,
    "payment_intent_data[metadata][buildr_app_user]": authData.user.id,
  });
  if (product.description) params.set("line_items[0][price_data][product_data][description]", product.description);
  const feeBps = Math.max(0, Math.min(2500, Number(linked.config?.platform_fee_bps || 0)));
  if (feeBps) params.set("payment_intent_data[application_fee_amount]", String(Math.floor(product.unit_amount * feeBps / 10000)));
  const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Stripe-Account": accountId, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const checkout = await stripeResponse.json();
  if (!stripeResponse.ok || !checkout.url) {
    console.error(`Stripe Checkout failed: ${stripeResponse.status} ${checkout?.error?.type || "unknown"}`);
    return json(502, { error: "Checkout could not be started." }, origin);
  }
  return json(200, { id: checkout.id, url: checkout.url }, origin);
});
