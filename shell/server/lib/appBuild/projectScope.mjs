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

export const DEFAULT_COLUMNS = "id, name, tree, product_id, updated_at";

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
 * Returns `{ project, scope, productId }`. `project` is null when nothing matches; `scope` says
 * how it was resolved so callers can explain themselves accurately.
 */
export async function resolveConversationProject(ctx, {
  projectId = null, productName = null, columns = DEFAULT_COLUMNS, client = serviceClient(),
} = {}) {
  const owner = ctx?.owner;
  if (!owner) return { project: null, scope: "no_owner", productId: null };

  const select = () => client.from("projects").select(columns)
    .eq("owner", owner).not("tree", "is", null)
    .order("updated_at", { ascending: false }).limit(1);

  if (projectId) {
    // Owner-scoped by the base query, so a projectId belonging to someone else resolves to null
    // rather than to their project.
    const { data } = await select().eq("id", projectId);
    return { project: data?.[0] || null, scope: "explicit", productId: data?.[0]?.product_id || null };
  }

  let productId = null;
  let scope = "conversation";

  if (productName) {
    const { data: product } = await client.from("ca_products")
      .select("id").eq("owner", owner).ilike("name", productName).maybeSingle();
    // A name that matches nothing must not silently widen the search to every project — that is
    // how "publish the CRM" published something else entirely.
    if (!product) return { project: null, scope: "unknown_product", productId: null };
    productId = String(product.id);
    scope = "named_product";
  } else if (ctx?.conversation?.product_id) {
    productId = String(ctx.conversation.product_id);
  }

  if (productId) {
    const { data } = await select().eq("product_id", productId);
    // Deliberately no fallback. A conversation about a product that has nothing built yet gets
    // null, and the capability tells the user that — it does not reach for another app.
    return { project: data?.[0] || null, scope, productId };
  }

  // Only conversations with no product at all get here.
  const { data } = await select();
  return { project: data?.[0] || null, scope: "owner_latest", productId: data?.[0]?.product_id || null };
}

// Every project row belonging to a product, newest first. A rebuild creates a NEW project row
// under the same product, so "the site for this product" spans several of them.
export async function projectsForProduct(owner, productId, client = serviceClient()) {
  if (!productId) return [];
  const { data } = await client.from("projects")
    .select("id, updated_at").eq("owner", owner).eq("product_id", String(productId))
    .order("updated_at", { ascending: false });
  return data || [];
}
