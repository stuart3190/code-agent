// Which project does "it" mean?
//
// Every app capability — publish, repair, preview, QA, export, connect a domain — used to resolve
// this the same wrong way: the owner's globally newest project with a tree, ordered by updated_at.
// The conversation was never consulted, even though it carries a product_id. So "publish it" in
// one conversation could publish an app belonging to another, "fix the login" could apply a
// surgical repair to the wrong tree, and "send me the code" could hand over a different project's
// source.
//
// The rule that fixes it: a conversation about a product NEVER escapes that product. If the
// conversation has a product and nothing has been built for it, the honest answer is "there's
// nothing built yet" — never a different app that happens to be newer.

import { serviceClient } from "../supabase.mjs";

async function checkedLookup(query) {
  const response = await query;
  if (response.error) throw Object.assign(new Error("Your project could not be checked. Please retry.", { cause: response.error }), {
    code: "project_lookup_unavailable", classification: "platform", status: 503, retryable: true,
  });
  return response;
}

export const DEFAULT_COLUMNS = "id, name, tree, product_id, created_at, updated_at, builder_version, bv2_green_snapshot_id, budget_approval_id";

/**
 * Resolve the project a capability should act on.
 *
 * Precedence, strongest first:
 *   1. An explicit projectId — the caller already knows.
 *   2. A named product ("publish the CRM one") — a deliberate override by the user.
 *   3. The conversation's own product — the default, and the one that was missing.
 *   4. The owner's newest project — ONLY for conversations that have no product at all
 *      (older conversations predate product ids). Never reached when a product is known.
 *
 * `allowOwnerFallback: false` removes step 4 entirely, for capabilities where guessing is worse
 * than refusing. Connecting a custom domain is the clearest case: pointing a customer's own
 * hostname at whichever app was touched most recently is not a mild inconvenience, it publishes
 * the wrong product at their address.
 *
 * Returns `{ project, scope, productId }`. `project` is null when nothing matches; `scope` says
 * how it was resolved so callers can explain themselves accurately.
 */
export async function resolveConversationProject(ctx, {
  projectId = null, productName = null, columns = DEFAULT_COLUMNS, client = serviceClient(),
  allowOwnerFallback = true, includeUnverified = false,
} = {}) {
  const owner = ctx?.owner;
  if (!owner) return { project: null, scope: "no_owner", productId: null };

  const select = () => {
    const query = client.from("projects").select(columns).eq("owner", owner);
    // Delivery/edit/publish capabilities may only resolve materialized legacy projects or a
    // verified V2 snapshot. Repair is deliberately different: a failed first-green V2 build has
    // neither, but its immutable working/candidate checkpoint is exactly what repair must resume.
    // Callers must opt in so an unfinished project can never leak into a delivery capability.
    if (!includeUnverified) query.or("tree.not.is.null,bv2_green_snapshot_id.not.is.null");
    // A preview restart legitimately touches updated_at on an older green project. For repair,
    // product lineage is project creation order: a later first-green attempt must remain the
    // target even when an older preview was re-served afterward.
    return query.order(includeUnverified ? "created_at" : "updated_at", { ascending: false }).limit(1);
  };

  if (projectId) {
    // Owner-scoped by the base query, so a projectId belonging to someone else resolves to null
    // rather than to their project.
    const { data } = await checkedLookup(select().eq("id", projectId));
    return { project: data?.[0] || null, scope: "explicit", productId: data?.[0]?.product_id || null };
  }

  let productId = null;
  let scope = "conversation";

  if (productName) {
    const { data: product } = await checkedLookup(client.from("ca_products")
      .select("id").eq("owner", owner).ilike("name", productName).maybeSingle());
    // A name that matches nothing must not silently widen the search to every project — that is
    // how "publish the CRM" published something else entirely.
    if (!product) return { project: null, scope: "unknown_product", productId: null };
    productId = String(product.id);
    scope = "named_product";
  } else if (ctx?.conversation?.product_id) {
    productId = String(ctx.conversation.product_id);
  }

  if (productId) {
    const { data } = await checkedLookup(select().eq("product_id", productId));
    // Deliberately no fallback. A conversation about a product that has nothing built yet gets
    // null, and the capability tells the user that — it does not reach for another app.
    return { project: data?.[0] || null, scope, productId };
  }

  // Only conversations with no product at all get here.
  if (!allowOwnerFallback) return { project: null, scope: "ambiguous", productId: null };
  const { data } = await checkedLookup(select());
  return { project: data?.[0] || null, scope: "owner_latest", productId: data?.[0]?.product_id || null };
}

/**
 * The user's latest message names this product when the full product name appears as its own
 * phrase. A shorter shared word ("calculator", "plan") is not a name, and neither is a name the
 * model inferred from the owner's other products.
 */
export function userNamedProduct(userText, productName) {
  const name = String(productName || "").trim().replace(/\s+/g, " ");
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(String(userText || ""));
}

export async function latestUserText(ctx) {
  if (typeof ctx?.latestUserText === "string") return ctx.latestUserText;
  const list = ctx?.conversations?.listTurns;
  if (typeof list !== "function" || !ctx?.conversation?.id || !ctx?.owner) return "";
  try {
    const turns = await list.call(ctx.conversations, ctx.owner, ctx.conversation.id, { limit: 30 });
    const latest = [...(turns || [])].reverse().find((turn) => turn?.role === "user");
    return String(latest?.content || "");
  } catch (error) {
    console.warn(`[project-scope] user text unavailable: ${error.message}`);
    return "";
  }
}

/**
 * Edit and repair target the conversation's own app. A model-supplied product name may select a
 * different app only when the user's current message actually names that app. Echoing the
 * conversation's own product is allowed. Anything else is refused before a job is created.
 */
export async function resolveEditRepairProject(ctx, {
  productName = null, userText = "", columns = DEFAULT_COLUMNS, client = serviceClient(),
  includeUnverified = false,
} = {}) {
  const requested = String(productName || "").trim();
  if (!requested) {
    return resolveConversationProject(ctx, { columns, client, includeUnverified });
  }
  const owner = ctx?.owner;
  if (!owner) return { project: null, scope: "no_owner", productId: null };
  const { data: product } = await checkedLookup(client.from("ca_products")
    .select("id, name").eq("owner", owner).ilike("name", requested).maybeSingle());
  if (!product) return { project: null, scope: "unknown_product", productId: null };
  const namedId = String(product.id);
  const conversationProductId = ctx?.conversation?.product_id ? String(ctx.conversation.product_id) : null;
  const sameProduct = conversationProductId != null && namedId === conversationProductId;
  if (!sameProduct && !userNamedProduct(userText, product.name || requested)) {
    let currentName = null;
    if (conversationProductId) {
      const { data: current } = await checkedLookup(client.from("ca_products")
        .select("name").eq("owner", owner).eq("id", conversationProductId).maybeSingle());
      currentName = current?.name || null;
    }
    return {
      project: null, scope: "unrequested_product", productId: namedId, blocked: true,
      requestedName: product.name || requested, currentName,
    };
  }
  return resolveConversationProject(ctx, { productName: requested, columns, client, includeUnverified });
}

export function unrequestedProductMessage(resolved) {
  const requested = String(resolved?.requestedName || "that app");
  if (resolved?.currentName) {
    return `I didn't change "${requested}". This conversation is for ${resolved.currentName}, and you didn't name the other app.`;
  }
  return `I didn't change "${requested}" because you didn't name it in this message. This conversation stays on its own app.`;
}

// Every project row belonging to a product, newest first. A rebuild creates a NEW project row
// under the same product, so "the site for this product" spans several of them.
export async function projectsForProduct(owner, productId, client = serviceClient()) {
  if (!productId) return [];
  const { data } = await checkedLookup(client.from("projects")
    .select("id, updated_at").eq("owner", owner).eq("product_id", String(productId))
    .order("updated_at", { ascending: false }));
  return data || [];
}
