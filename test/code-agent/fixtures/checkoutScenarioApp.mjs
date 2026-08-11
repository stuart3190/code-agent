// A checkout/order lifecycle, built to prove the scenario architecture is not about booking.
//
// Same platform primitives as every other fixture — makeWizardMachine, useCapabilityState,
// useSemanticSelection, useSemanticField — and no makeBookingSystem anywhere. The contract that
// drives it is authored fresh and derived by the production deriveBuildSpec, so scenario
// classification, prerequisites, durable lifecycle keying, flow_start/flow_advance and validity
// intent are all exercised through their real derivation rather than hand-written.
//
// Persistence is sessionStorage so the durable lifecycle (create → recover → cancel → recover the
// cancelled state) can run offline. That substitution is stated plainly: it proves the VERIFIER
// drives these journeys; it does not prove durable backend persistence.

const PERSISTENCE = `const KEY = "thrallo-checkout-wizard";
export const sessionPersistence = {
  async save(state) { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch {} },
  async load() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } },
  async clear() { try { sessionStorage.removeItem(KEY); } catch {} },
};

const ORDERS = "thrallo-checkout-orders";
export const orderStore = {
  all() { try { return JSON.parse(sessionStorage.getItem(ORDERS) || "[]"); } catch { return []; } },
  save(row) {
    const rows = orderStore.all().filter((r) => r.reference !== row.reference);
    rows.push(row);
    try { sessionStorage.setItem(ORDERS, JSON.stringify(rows)); } catch {}
  },
  find(reference, email) {
    return orderStore.all().find((r) => r.reference.toLowerCase() === String(reference || "").trim().toLowerCase()
      && r.buyerEmail.toLowerCase() === String(email || "").trim().toLowerCase()) || null;
  },
};
`;

const DATA = `import { makeWizardMachine } from "../lib/capabilities/wizard.js";
import { sessionPersistence, orderStore } from "./persistence.js";

export const SPEEDS = [
  { value: "standard", label: "Standard", note: "Arrives in four working days" },
  { value: "express", label: "Express", note: "Arrives next working day" },
];
export const CARDS = [{ value: "visa", label: "Visa" }, { value: "amex", label: "Amex" }];
export const ITEM_COUNTS = [1, 2, 3];
export const speedOf = (v) => SPEEDS.find((s) => s.value === v) || null;
export const cardOf = (v) => CARDS.find((c) => c.value === v) || null;
export const validEmail = (value) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(value || ""));

export { orderStore };

export const wizard = makeWizardMachine({
  id: "place-order",
  steps: ["delivery", "card", "items", "buyer", "review"],
  initialValues: { started: false, deliverySpeed: null, cardBrand: null, itemCount: null, buyerEmail: "" },
  persistence: sessionPersistence,
  validate: ({ stepId, values }) => {
    const errors = {};
    if (stepId === "delivery" && !values.deliverySpeed) errors.deliverySpeed = "required";
    if (stepId === "card" && !values.cardBrand) errors.cardBrand = "required";
    if (stepId === "items" && !values.itemCount) errors.itemCount = "required";
    if (stepId === "buyer" && !validEmail(values.buyerEmail)) errors.buyerEmail = "a valid email is required";
    return errors;
  },
  onConfirm: async (values) => {
    const reference = "ORD-" + String(values.deliverySpeed || "").slice(0, 3).toUpperCase() + "-8812";
    orderStore.save({ ...values, reference, status: "Confirmed" });
    return { reference };
  },
});
`;

const FLOW = `import { useState } from "react";
import { useCapabilityState, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard, SPEEDS, CARDS, ITEM_COUNTS, speedOf, cardOf, validEmail, orderStore } from "../data/checkout.js";

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const manage = typeof window !== "undefined" && window.location.pathname.startsWith("/manage");
  if (manage) return <Manage />;

  const speed = useSemanticSelection({ name: "deliverySpeed", value: values.deliverySpeed,
    onSelect: async (v) => { await wizard.select("deliverySpeed", v); await wizard.next(); } });
  const card = useSemanticSelection({ name: "cardBrand", value: values.cardBrand,
    onSelect: (v) => wizard.select("cardBrand", v) });
  const items = useSemanticSelection({ name: "itemCount", value: values.itemCount,
    onSelect: (v) => wizard.select("itemCount", v) });
  const buyerEmail = useSemanticField({ name: "buyerEmail", type: "email", value: values.buyerEmail,
    invalid: Boolean(values.buyerEmail) && !validEmail(values.buyerEmail),
    onChange: (v) => wizard.setValue("buyerEmail", v) });

  const chosenSpeed = speedOf(values.deliverySpeed);
  const chosenCard = cardOf(values.cardBrand);
  const buyerValid = validEmail(values.buyerEmail);
  const continueDisabled = state.stepId === "buyer" && !buyerValid;

  if (state.status === "confirmed") {
    const reference = state.confirmation ? state.confirmation.reference : "";
    return <main>
      <h1>Order Confirmed</h1>
      <p>The confirmation screen. Status: Confirmed. Durable order reference {reference}.</p>
      <p>The confirmed order state is recovered on reload and the same order reference remains visible.</p>
      <p>{chosenSpeed ? chosenSpeed.label : ""} · {chosenCard ? chosenCard.label : ""} · {String(values.itemCount)} items</p>
      <p>{values.buyerEmail}</p>
      <div><a href="/manage">Look up order</a></div>
    </main>;
  }

  if (!values.started) return <main>
    <h1>Northwind Supply</h1>
    <p>The Northwind Supply storefront headline and catalogue summary, with a start checkout control.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start checkout</button></div>
    <div><a href="/manage">Look up order</a></div>
  </main>;

  return <main>
    <p>Checkout wizard: current wizard step indicator — delivery options.</p>

    {state.stepId === "delivery" ? <>
      <h3>Delivery speeds</h3>
      <div {...speed.groupProps}>
        {SPEEDS.map((s) => (
          <button key={s.value} {...speed.optionProps(s.value, "delivery Speed " + s.label)}>
            <span style={{ display: "block" }}>Delivery Speed {s.label}</span>
            <span style={{ display: "block" }}>{s.note}</span>
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "card" ? <>
      <p>Accepted card brands for {chosenSpeed ? chosenSpeed.label : ""} delivery are shown.</p>
      <div {...card.groupProps}>
        {CARDS.map((c) => (
          <button key={c.value} {...card.optionProps(c.value, "card Brand " + c.label)}>
            <span style={{ display: "block" }}>Card Brand {c.label}</span>
            {values.cardBrand === c.value ? <span style={{ display: "block" }}>selected card brand highlighted</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "items" ? <>
      <p>Item count control: the selected item count is displayed for this order.</p>
      <div {...items.groupProps}>
        {ITEM_COUNTS.map((n) => (
          <button key={n} {...items.optionProps(n, "item Count " + n)}>
            <span style={{ display: "block" }}>Item Count {n}</span>
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "buyer" ? <>
      <p>Buyer details step: the buyer email field is visible.</p>
      <div><label {...buyerEmail.labelProps} /><input {...buyerEmail.inputProps} /></div>
      {values.buyerEmail && !buyerValid
        ? <p role="alert">Email validation message: enter a valid buyer email address.</p> : null}
      {buyerValid ? <p>Validation messages clear.</p> : null}
    </> : null}

    {state.stepId === "review" ? <section>
      <h3>Review</h3>
      <p>The exact selected delivery speed {chosenSpeed ? chosenSpeed.label : ""}, card brand {chosenCard ? chosenCard.label : ""}, item count {String(values.itemCount)} and buyer email {values.buyerEmail} are visible before confirmation.</p>
      <div><button type="button" onClick={() => { wizard.confirm().catch(() => {}); }}>Confirm order</button></div>
    </section> : null}

    <div><button type="button" disabled={continueDisabled} onClick={() => { wizard.next(); }}>Continue</button></div>
    <div><a href="/manage">Look up order</a></div>
  </main>;
}

function Manage() {
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [found, setFound] = useState(() => {
    try {
      const remembered = JSON.parse(sessionStorage.getItem("thrallo-checkout-found") || "null");
      return remembered || orderStore.all()[0] || null;
    } catch { return null; }
  });
  const [prompt, setPrompt] = useState(false);
  const referenceField = useSemanticField({ name: "reference", value: reference, onChange: setReference });
  const emailField = useSemanticField({ name: "buyerEmail", type: "email", value: email, onChange: setEmail });

  const remember = (row) => {
    setFound(row);
    try { sessionStorage.setItem("thrallo-checkout-found", JSON.stringify(row)); } catch {}
  };
  const lookup = () => {
    const row = orderStore.find(reference, email) || orderStore.all()[0] || null;
    if (row) remember(row);
  };
  const cancel = () => {
    const row = { ...found, status: "Cancelled" };
    orderStore.save(row);
    remember(row);
    setPrompt(false);
  };

  return <main>
    <h1>Manage order</h1>
    <p>An order reference lookup form is visible.</p>
    <div><label {...referenceField.labelProps} /><input {...referenceField.inputProps} /></div>
    <div><label {...emailField.labelProps} /><input {...emailField.inputProps} /></div>
    <div><button type="button" onClick={lookup}>Look up order</button></div>
    {found ? <section>
      <p>The order details are displayed. Status {found.status}. Reference {found.reference}.</p>
      <p>{found.buyerEmail} · {String(found.itemCount)} items · {found.deliverySpeed} · {found.cardBrand}</p>
      {found.status === "Cancelled"
        ? <p>This order reloads into an explicit Cancelled state with no active cancel control.</p>
        : <div><button type="button" onClick={() => setPrompt(true)}>Cancel order</button></div>}
      {prompt ? <div>
        <p role="alert">A cancellation confirmation prompt is displayed. Are you sure?</p>
        <button type="button" onClick={cancel}>Confirm cancellation</button>
        <button type="button" onClick={() => setPrompt(false)}>Keep order</button>
      </div> : null}
    </section> : null}
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

export function checkoutScenarioApp() {
  return {
    "src/data/persistence.js": PERSISTENCE,
    "src/data/checkout.js": DATA,
    "src/components/Flow.jsx": FLOW,
    "src/App.jsx": APP,
  };
}

/** The contract, authored as prose and derived by the production deriveBuildSpec. */
export const CHECKOUT_CONTRACT = {
  summary: "Northwind Supply checkout", projectType: "web app", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Store" }, { path: "/manage", name: "Manage order" }],
  entities: [{ name: "order", fields: [
    { name: "deliverySpeed", type: "string" }, { name: "cardBrand", type: "string" },
    { name: "itemCount", type: "number" }, { name: "buyerEmail", type: "string" },
    { name: "reference", type: "string" }, { name: "status", type: "string" }] }],
  operations: [
    { name: "create-order", entity: "order", kind: "create" },
    { name: "read-order-by-reference", entity: "order", kind: "read" },
    { name: "cancel-order", entity: "order", kind: "update" }],
  journeys: [
    { id: "place-order", title: "A buyer places and recovers a confirmed order", priority: "primary", steps: [
      { action: "open the store page", target: "/",
        expect: "the Northwind Supply storefront headline and catalogue summary are shown" },
      { action: "begin checkout", target: "start checkout control",
        expect: "the current wizard step indicator and the delivery options are shown" },
      { action: "select a delivery speed", target: "delivery speed picker",
        expect: "accepted card brands for that delivery speed are shown" },
      { action: "select a card brand", target: "card brand picker",
        expect: "the selected card brand highlighted and the item count control are shown" },
      { action: "choose an item count", target: "item count control",
        expect: "the selected item count is displayed for this order" },
      { action: "enter a valid buyer email", target: "buyer details form",
        expect: "the buyer email field is visible and validation messages clear" },
      { action: "review the order", target: "review step",
        expect: "the exact selected delivery speed, card brand, item count and buyer email are visible before confirmation" },
      { action: "confirm the order", target: "confirm order control",
        expect: "a confirmation screen appears with status Confirmed and a durable order reference" },
      { action: "reload the page", target: "browser reload",
        expect: "the confirmed order state is recovered and the same order reference remains visible" },
    ] },
    { id: "recover-existing-order", title: "A buyer recovers an existing order", priority: "secondary", steps: [
      { action: "open the order lookup area", target: "/manage",
        expect: "an order reference lookup form is visible" },
      { action: "enter a valid confirmed order reference and matching email", target: "lookup form",
        expect: "the order details are displayed with status Confirmed" },
      { action: "reload the page", target: "browser reload",
        expect: "the recovered order remains displayed with the same status and reference" },
    ] },
    { id: "cancel-order", title: "A buyer cancels a confirmed order", priority: "secondary", steps: [
      { action: "open a confirmed order", target: "/manage",
        expect: "the order details and a cancel order control are visible" },
      { action: "choose to cancel the order", target: "cancel order control",
        expect: "a cancellation confirmation prompt is displayed" },
      { action: "confirm cancellation", target: "confirm cancellation control",
        expect: "the order status changes to Cancelled and the order reference remains visible" },
      { action: "reload the page", target: "browser reload",
        expect: "the order reloads into an explicit Cancelled state with no active cancel control" },
    ] },
    { id: "buyer-validation", title: "Buyer email validation", priority: "secondary", steps: [
      { action: "advance to the buyer details step", target: "checkout wizard",
        expect: "the buyer email field is visible" },
      { action: "enter an invalid buyer email", target: "buyer email field",
        expect: "an email validation message is shown and the continue control remains disabled" },
      { action: "enter a valid buyer email and required details", target: "buyer details form",
        expect: "validation messages clear and the continue control becomes enabled" },
    ] },
  ],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};
