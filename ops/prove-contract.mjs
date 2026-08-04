// PR4 acceptance: every build carries a contract of what "built" means.
//
// Two halves. The deterministic half checks that the vocabulary rejects the vague statements the
// brief forbids and accepts the observable ones. The live half sends a real request through the
// real contract agent on the deployed provider and asserts the result is usable by PR5-PR7 —
// because a contract that validates in a unit test but that no model can actually produce is a
// schema, not a feature.
//
//   node ops/prove-contract.mjs             # deterministic only
//   node ops/prove-contract.mjs --live      # also calls the model (spends tokens)

import { loadEnv } from "../shell/server/lib/env.mjs";
import {
  validateContract, isVague, contractBrief, primaryJourney, contractSummary,
} from "../shell/shared/implementationContract.mjs";

loadEnv();
const LIVE = process.argv.includes("--live");
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

console.log("PR4 — the implementation contract\n");

// ── 1. the vocabulary refuses what the brief forbids ──────────────────────────────────────────
console.log("1. broad statements are not accepted as contracts");
for (const vague of ["add booking functionality", "implement authentication", "support payments",
  "user management", "CRUD", "make it work", "build the dashboard"]) {
  check(`rejected: "${vague}"`, isVague(vague) === true);
}
for (const observable of [
  "submitting a duplicate slot shows an error and stores no second booking",
  "the booking is still shown after a full page reload",
  "continue is disabled until a slot is selected",
  "the owner list displays a booking created by a visitor",
]) {
  check(`accepted: "${observable.slice(0, 52)}…"`, isVague(observable) === false);
}

// ── 2. a contract of slogans fails rather than being trusted ──────────────────────────────────
console.log("\n2. a contract made of slogans is refused");
const slogans = {
  summary: "A booking app", journeys: [{
    id: "j1", title: "Booking", priority: "primary",
    steps: [{ action: "book", expect: "add booking functionality" }, { action: "manage", expect: "CRUD" }],
  }],
  acceptance: [{ id: "a1", statement: "booking works" }],
  entities: [], operations: [], routes: [], states: [], deferred: [],
};
const refused = validateContract(slogans);
check("it does not validate", refused.ok === false, `${refused.problems.length} problems`);
check("and it says why", refused.problems.some((p) => /observable/.test(p)));

// ── 3. the live agent, on the deployed provider ───────────────────────────────────────────────
if (LIVE) {
  console.log("\n3. a real contract from the real model");
  const { generateContract } = await import("../shell/server/lib/appBuild/contractAgent.mjs");
  const { createCodexProvider } = await import("../src/providers/codexProvider.mjs");
  const { createAnthropicProvider } = await import("../src/providers/anthropicProvider.mjs");
  const provider = process.env.OPENAI_API_KEY ? createCodexProvider() : createAnthropicProvider({ cache: false });

  const REQUEST = [
    "Build a booking website for a pick-your-own strawberry farm. Visitors choose a date and a",
    "90-minute picking slot, enter their name, email and phone, and get a confirmation with a",
    "booking reference. Slots have limited capacity and must not be overbooked. Visitors can look",
    "up and cancel a booking using the reference and their email. The farm owner can see all",
    "bookings. Payment is on arrival — no card payment in the app.",
  ].join(" ");

  const started = Date.now();
  const result = await generateContract({ provider, prompt: REQUEST, log: (l) => console.log(`     ${l}`) });
  const elapsed = Date.now() - started;

  if (!check("a contract was produced", !!result.contract, `${result.attempts} attempt(s), ${(elapsed / 1000).toFixed(1)}s`)) {
    console.log(`     problems: ${result.problems.join("; ")}`);
  } else {
    const contract = result.contract;
    console.log(`     ${contractSummary(contract)}`);
    check("it validates", validateContract(contract).ok === true);

    const primary = primaryJourney(contract);
    check("exactly one journey is primary",
      contract.journeys.filter((j) => j.priority === "primary").length === 1, primary?.title || "none");
    check("the primary journey has real steps", (primary?.steps || []).length >= 2,
      `${(primary?.steps || []).length} steps`);
    check("every step names something observable",
      (primary?.steps || []).every((s) => !isVague(s.expect)));

    // The things the brief said a booking contract must contain, found in what the model produced.
    const text = JSON.stringify(contract).toLowerCase();
    const required = [
      ["availability is loaded", /slot|availab|capacity/],
      ["a slot is selected", /select|choos|pick/],
      ["customer details are entered", /name|email|phone/],
      ["submission is validated", /valid|require|invalid/],
      ["the booking is persisted", /persist|db\.entity|store|sav/],
      ["duplicates are refused", /duplicat|overbook|capacity|unavailab|taken|full/],
      ["a confirmation is shown", /confirm|reference/],
      ["the owner can manage bookings", /owner|admin|manage/],
      ["data survives a refresh", /reload|refresh|persist|surviv/],
    ];
    for (const [label, pattern] of required) check(`covers: ${label}`, pattern.test(text));

    check("stored data is declared as entities", (contract.entities || []).length > 0,
      (contract.entities || []).map((e) => e.name).join(", "));
    check("backend operations are named", (contract.operations || []).length > 0);
    check("payment is recorded as deferred rather than faked",
      (contract.deferred || []).some((d) => /pay|card/i.test(d.item)),
      (contract.deferred || []).map((d) => d.item).join(", ") || "nothing deferred");

    const brief = contractBrief(contract);
    check("the builder brief states the checks", /PRIMARY JOURNEY/.test(brief) && /EVERY VISIBLE CONTROL/.test(brief));
    check("and warns against faking", /FAILURE of this contract even if the page looks finished/.test(brief));
    console.log(`\n     brief: ${brief.length} characters`);
  }
} else {
  console.log("\n3. skipped — pass --live to generate a real contract from the deployed model");
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : "PASSED — every check"}`);
process.exit(failures ? 1 : 0);
