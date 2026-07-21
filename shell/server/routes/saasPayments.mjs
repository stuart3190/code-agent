import { beginStripeOnboarding, createPaymentProduct, paymentOverview, updatePaymentProduct } from "../lib/saasPayments.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function known(error, res) {
  if (error?.code === "bad_product") { json(res, 400, { error: error.message, code: error.code }); return true; }
  if (error?.code === "upgrade_required") { json(res, 402, { error: error.message, code: error.code }); return true; }
  if (error?.code === "feature_unavailable") { json(res, 404, { error: error.message, code: error.code }); return true; }
  return false;
}

export async function handlePaymentOverview(req, res, url, owner) {
  try {
    const projectId = url.searchParams.get("projectId");
    if (!projectId) return json(res, 400, { error: "projectId is required" });
    const result = await paymentOverview(owner, projectId);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) { if (!known(error, res)) throw error; }
}

export async function handleStripeOnboarding(req, res, body, owner) {
  try {
    if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
    const result = await beginStripeOnboarding(owner, body.projectId);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) { if (!known(error, res)) throw error; }
}

export async function handlePaymentProducts(req, res, body, owner) {
  try {
    if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
    const result = body.productId
      ? await updatePaymentProduct(owner, body.projectId, body.productId, body)
      : await createPaymentProduct(owner, body.projectId, body);
    return result == null ? json(res, 404, { error: "project not found" })
      : result === false ? json(res, 404, { error: "product not found" })
        : json(res, 200, { product: result });
  } catch (error) { if (!known(error, res)) throw error; }
}
