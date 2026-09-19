// The billing and entitlements installation plan (WP12).
//
// Billing is the one capability where guessing is worst. A plan catalogue invented from prose
// would decide what a customer's customers are charged, and a feature gate invented from a
// journey title would lock someone out of something they paid for. So this derivation is the
// narrowest in the compiler:
//
//   - A plan exists only where the contract DECLARES one — a plan/tier/subscription entity with
//     names, or an explicit `plans` section. Never from the word "premium" in a sentence.
//   - A feature gate exists only where the contract names the plan alongside the thing gated.
//   - No product ids are invented. A plan with no configured product cannot be bought, and the
//     module says so rather than starting a checkout that fails at the provider.
//
// Where the contract is silent this plan is empty and no billing module is installed, which is
// the right answer for the overwhelming majority of applications.

export const BILLING_PLAN_VERSION = 1;

const PLAN_ENTITY_NAME = /^(?:plan|tier|subscription[-_ ]?plan|pricing[-_ ]?plan|package|membership[-_ ]?tier)s?$/i;
const SUBSCRIPTION_ENTITY_NAME = /^(?:subscription|membership|billing)s?$/i;
// A payment SIGNAL is the build profile saying the application takes money. Prose is not enough:
// "premium fixtures" is a product line, not a pricing tier.
const PAYMENT_SIGNAL = "payments";
const FEATURE_FIELD = /^(?:features?|includes?|entitlements?|permissions?)$/i;
const LIMIT_FIELD = /^(?:limits?|quotas?|max[-_ ]?\w+|allowance)$/i;
const PRICE_FIELD = /^(?:price|amount|cost|monthly[-_ ]?price|annual[-_ ]?price)$/i;

const listOf = (value) => (Array.isArray(value) ? value : []);
const lower = (value) => String(value || "").trim().toLowerCase();

/** Is this entity the application's declared plan catalogue? */
export function isPlanEntity(entity) {
  if (!entity?.name || !PLAN_ENTITY_NAME.test(String(entity.name))) return false;
  const fields = listOf(entity.fields).map((field) => String(field?.name || field));
  // A plan row describes what a tier includes or what it costs. A "plan" entity that is really a
  // project plan — a schedule with dates and tasks — is a domain record and stays one.
  return fields.some((name) => FEATURE_FIELD.test(name) || LIMIT_FIELD.test(name) || PRICE_FIELD.test(name));
}

/**
 * The plan catalogue a contract declares. Plans come from an explicit `billing.plans` section
 * where the contract has one, or from a declared plan entity's own sample rows — never from prose.
 */
export function deriveBillingPlan(contract, { entitySchema = null } = {}) {
  const signalled = listOf(contract?.buildProfile?.requirementSignals).includes(PAYMENT_SIGNAL);
  const declared = listOf(contract?.billing?.plans);
  const planEntity = listOf(contract?.entities).find(isPlanEntity) || null;
  const subscriptionEntity = listOf(contract?.entities)
    .find((entity) => SUBSCRIPTION_ENTITY_NAME.test(String(entity?.name || "")));

  if (!declared.length && !planEntity && !signalled) return { plans: [], features: [], limits: [] };

  const plans = declared.length
    ? declared.map((row, index) => ({
      id: String(row?.id || row?.name || `plan-${index + 1}`),
      title: String(row?.title || row?.name || row?.id || `Plan ${index + 1}`),
      // A product id is CONFIGURATION, not a contract value: it belongs to a deployment's own
      // provider account. Declared here only when the contract carries one explicitly.
      productId: row?.productId ? String(row.productId) : null,
      features: listOf(row?.features).map(String),
      limits: { ...(row?.limits || {}) },
      default: row?.default === true || index === 0,
    }))
    : [];

  // With a plan entity but no declared rows, the catalogue is the ENTITY, read at runtime. The
  // compiler records what shape to expect rather than inventing tiers nobody priced.
  const catalogueEntity = !declared.length && planEntity ? String(planEntity.name) : null;

  const features = [...new Set(plans.flatMap((plan) => plan.features))];
  const limits = [...new Set(plans.flatMap((plan) => Object.keys(plan.limits)))];
  return {
    plans,
    features,
    limits,
    ...(catalogueEntity ? { catalogueEntity } : {}),
    ...(subscriptionEntity ? { subscriptionEntity: String(subscriptionEntity.name) } : {}),
    // A durable entity the contract also declares as a plan must not get an entity store fighting
    // the module for ownership; recorded so the evidence says which side owns it.
    durablePlanEntity: Boolean(catalogueEntity && listOf(entitySchema?.entities).some((name) => lower(name) === lower(catalogueEntity))),
    source: declared.length ? "contract.billing.plans" : planEntity ? `entity:${catalogueEntity}` : "signal:payments",
  };
}

/** Deterministic probes: the lifecycle, the limit, and the webhook that must not apply twice. */
export function billingVerificationPlan({ plans = [], limits = [] } = {}) {
  if (!plans.length) return [];
  const probes = [
    { id: "billing.denied", expect: "a feature outside the plan is refused with the plan that would allow it" },
    { id: "billing.lifecycle", expect: "a cancelled subscription keeps access until the period it paid for ends" },
    { id: "billing.idempotent", expect: "the same provider event applied twice changes nothing" },
  ];
  if (limits.length) probes.push({ id: "billing.limit", expect: "a limit is enforced where the record is created, not by a disabled button" });
  return probes;
}
