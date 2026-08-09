// Machine-readable interaction and data-flow authority for generated workflows.
//
// This is deliberately generic: it describes controls, state transitions and durable edges from
// the implementation contract. It does not render JSX or prescribe a booking visual template.

import { parse } from "@babel/parser";

import { aggregateCapabilityFacts } from "./capabilityLint.mjs";
import { bindCapabilities, bookingModulePlan } from "./contractTiering.mjs";

const SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
const PLATFORM = /^src\/lib\/(?:capabilities\/|backend\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
const AST_SKIP = new Set(["loc", "start", "end", "extra", "errors", "comments", "tokens"]);
const STOP = new Set(["select", "choose", "pick", "enter", "provide", "complete", "click", "press",
  "submit", "confirm", "review", "show", "display", "open", "page", "form", "details", "available",
  "booking", "reservation", "guest", "visitor", "the", "and", "then", "with", "from", "into"]);

const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (value) => String(value || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
const unique = (values) => [...new Set(values.filter(Boolean))];

function actionKinds(step) {
  const text = `${step?.action || ""} ${step?.target || ""}`.toLowerCase();
  const kinds = [];
  if (/\b(select|choose|pick)\b/.test(text)) kinds.push("selection");
  if (/\b(enter|type|fill|provide|complete)\b/.test(text)) kinds.push("input");
  if (/\b(review|summary)\b/.test(text)) kinds.push("review");
  if (/\b(confirm|submit|book|reserve|create)\b/.test(text)) kinds.push("mutation");
  if (/\b(reload|refresh|recover|restore|sign[ -]?in)\b/.test(text)) kinds.push("recovery");
  if (/\b(look ?up|find|search)\b/.test(text)) kinds.push("lookup");
  if (/\bcancel\b/.test(text)) kinds.push("cancellation");
  if (!kinds.length && /\b(open|navigate|visit|go to)\b/.test(text)) kinds.push("navigation");
  if (!kinds.length && /\b(click|press|tap|continue|next|back|use)\b/.test(text)) kinds.push("action");
  return unique(kinds);
}

function fieldCandidates(contract, text, kind) {
  const haystack = normalized(text);
  const allDeclared = (contract?.entities || []).flatMap((entity) => entity?.fields || []);
  const declared = allDeclared
    .map((field) => String(field?.name || "")).filter(Boolean)
    .filter((name) => haystack.includes(normalized(name))
      || words(name.replace(/([a-z])([A-Z])/g, "$1 $2")).some((word) => haystack.includes(normalized(word))));
  let semantic = [
    ["date", /date|day/], ["slot", /slot|time/], ["partySize", /party|quantity|people|guest|adult|child/],
    ["name", /name/], ["email", /email/], ["phone", /phone|telephone/], ["contact", /contact|details/],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (kind === "selection") semantic = semantic.filter((name) => ["date", "slot", "partySize"].includes(name));
  if (kind === "input") semantic = semantic.filter((name) => ["partySize", "name", "email", "phone", "contact"].includes(name));
  if (semantic.includes("contact") && semantic.some((name) => ["name", "email", "phone"].includes(name))) {
    semantic = semantic.filter((name) => name !== "contact");
  }
  if (kind === "input" && /contact|details|guest|customer|profile/i.test(text)) {
    declared.push(...allDeclared.map((field) => String(field?.name || "")).filter((name) => /name|email|phone|contact/i.test(name)));
  }
  const fallback = words(text).filter((word) => !STOP.has(word)).slice(0, 2);
  return unique([...declared, ...semantic, ...(declared.length || semantic.length ? [] : fallback)])
    .slice(0, kind === "input" ? 8 : 4);
}

function ownerModules(modulePlan, kind) {
  const byFactory = (factory) => modulePlan.find((module) => module.factory === factory)?.path || null;
  const visual = modulePlan.find((module) => /flow|composition/i.test(module.role || ""))?.path || null;
  if (["mutation", "cancellation", "lookup"].includes(kind)) return unique([byFactory("makeBookingSystem")]);
  if (["selection", "input", "review", "recovery", "action"].includes(kind)) {
    return unique([byFactory("makeWizardMachine"), visual]);
  }
  return unique([visual]);
}

function controlRequirement(kind, field, step) {
  const name = field || String(step?.target || step?.action || "control");
  if (kind === "input") return { purpose: name, roles: ["textbox", "spinbutton", "combobox"], accessibleName: name };
  if (kind === "selection") return { purpose: name, roles: ["button", "radio", "option", "combobox"],
    accessibleName: name, selectedState: true };
  if (["mutation", "cancellation", "lookup", "action"].includes(kind)) {
    return { purpose: name, roles: ["button"], accessibleName: String(step?.target || step?.action || name) };
  }
  return null;
}

/** Derive the interaction/data-flow contract once, before implementation generation. */
export function buildInteractionContract(contract, {
  modulePlan = bookingModulePlan(contract, contract?.journeys || []),
  bindings = bindCapabilities(contract),
} = {}) {
  const flows = [];
  for (const journey of contract?.journeys || []) {
    const draftWrites = [];
    let durableRecord = null;
    for (const [stepIndex, step] of (journey.steps || []).entries()) {
      const kinds = actionKinds(step);
      for (const kind of kinds) {
        const fields = ["selection", "input"].includes(kind)
          ? fieldCandidates(contract, `${step.action || ""} ${step.target || ""}`, kind) : [null];
        for (const field of fields.length ? fields : [null]) {
          const writes = [];
          const reads = [];
          if (["selection", "input"].includes(kind)) {
            const path = `${journey.id}.draft.${field || `value${stepIndex + 1}`}`;
            writes.push(path);
            draftWrites.push(path);
          } else if (kind === "review") reads.push(...(draftWrites.length ? draftWrites : [`${journey.id}.durable.record`]));
          else if (kind === "mutation") {
            reads.push(...(draftWrites.length ? draftWrites : [`${journey.id}.input`]));
            durableRecord ||= `${journey.id}.durable.record`;
            writes.push(durableRecord, `${journey.id}.durable.reference`);
          } else if (["recovery", "lookup"].includes(kind)) {
            reads.push(durableRecord || `${journey.id}.durable.reference`);
            writes.push(`${journey.id}.restored`);
          } else if (kind === "cancellation") {
            reads.push(durableRecord || `${journey.id}.durable.reference`);
            writes.push(`${journey.id}.durable.status`);
          }
          const owners = ownerModules(modulePlan, kind);
          flows.push({
            id: `${journey.id}:${stepIndex + 1}:${kind}${field ? `:${normalized(field)}` : ""}`,
            journeyId: journey.id,
            stepIndex,
            kind,
            semanticPurpose: step.action,
            stateOwner: owners[0] || `journey:${journey.id}`,
            responsibleModules: owners,
            action: step.action,
            valueWritten: field || null,
            reads: unique(reads),
            writes: unique(writes),
            dependsOn: unique(reads),
            nextStateRequirement: step.expect,
            observable: step.expect,
            control: controlRequirement(kind, field, step),
            capability: ["mutation", "cancellation", "lookup"].includes(kind)
              ? (bindings.some((binding) => binding.name === "booking") ? "makeBookingSystem" : "makeEntityStore")
              : bindings.some((binding) => binding.name === "wizard") ? "makeWizardMachine" : null,
          });
        }
      }
    }
  }
  const plan = { version: 1, flows };
  const verdict = validateInteractionContract(plan);
  return { ...plan, valid: verdict.ok, problems: verdict.problems };
}

/** Reject a broken ownership/data-flow graph before implementation generation. */
export function validateInteractionContract(plan) {
  const problems = [];
  const produced = new Set();
  for (const flow of plan?.flows || []) {
    if (!flow.id || !flow.journeyId) problems.push("interaction flow is missing identity");
    if ((flow.writes || []).length && !flow.stateOwner) problems.push(`${flow.id} writes state without an owner`);
    const missing = (flow.reads || []).filter((path) => !produced.has(path)
      && !/\.(?:durable\.(?:record|reference)|input)$/.test(path));
    if (missing.length) problems.push(`${flow.id} reads state before it is produced: ${missing.join(", ")}`);
    if (flow.kind === "review" && !(flow.reads || []).length) problems.push(`${flow.id} review has no source values`);
    if (flow.kind === "mutation" && !(flow.reads || []).length) problems.push(`${flow.id} mutation consumes no contracted input state`);
    if (flow.kind === "cancellation" && flow.capability !== "makeBookingSystem" && flow.capability !== "makeEntityStore") {
      problems.push(`${flow.id} cancellation has no durable operation owner`);
    }
    if (flow.control && (!flow.control.accessibleName || !(flow.control.roles || []).length)) {
      problems.push(`${flow.id} interactive control has no driveable semantic contract`);
    }
    for (const path of flow.writes || []) produced.add(path);
  }
  return { ok: problems.length === 0, problems };
}

export function interactionContractBrief(plan) {
  if (!(plan?.flows || []).length) return "INTERACTION CONTRACT: no interactive state transitions in this scope.";
  return [
    "INTERACTION CONTRACT (machine-enforced JSON; implement these state/data-flow edges before styling):",
    JSON.stringify({ version: plan.version, flows: plan.flows }, null, 2),
    "Controls need semantic HTML/ARIA names and selection state. Visual design remains unrestricted.",
  ].join("\n");
}

export function scopeInteractionContract(plan, journeys = []) {
  const ids = new Set((journeys || []).map((journey) => journey?.id).filter(Boolean));
  return { version: plan?.version || 1, flows: (plan?.flows || []).filter((flow) => ids.has(flow.journeyId)) };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (AST_SKIP.has(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

function literal(node) {
  if (["StringLiteral", "Literal"].includes(node?.type)) return String(node.value || "");
  if (node?.type === "JSXText") return String(node.value || "");
  if (node?.type === "JSXExpressionContainer") return literal(node.expression);
  if (node?.type === "TemplateLiteral" && !node.expressions?.length) return node.quasis.map((row) => row.value.cooked).join("");
  return "";
}

function attr(opening, name) {
  const row = (opening?.attributes || []).find((item) => item.type === "JSXAttribute" && item.name?.name === name);
  if (!row) return null;
  if (!row.value) return "true";
  return literal(row.value);
}

function jsxName(node) {
  return node?.name?.type === "JSXIdentifier" ? node.name.name : null;
}

function collectControls(tree) {
  const controls = [];
  for (const [file, raw] of Object.entries(tree || {})) {
    if (!SOURCE.test(file) || PLATFORM.test(file)) continue;
    let ast;
    try {
      ast = parse(String(raw), { sourceType: "module", plugins: [/\.tsx?$/.test(file) ? "typescript" : null,
        /\.(?:jsx|tsx)$/.test(file) ? "jsx" : null].filter(Boolean) });
    } catch { continue; }
    walk(ast, (node) => {
      if (node.type !== "JSXElement") return;
      const opening = node.openingElement;
      const tag = jsxName(opening);
      const role = attr(opening, "role") || ({ input: attr(opening, "type") === "number" ? "spinbutton" : "textbox",
        textarea: "textbox", select: "combobox", button: "button", option: "option" }[tag]);
      if (!role) return;
      const childText = (node.children || []).map(literal).join(" ");
      const name = [attr(opening, "aria-label"), attr(opening, "name"), attr(opening, "id"),
        attr(opening, "placeholder"), attr(opening, "title"), childText,
        String(raw).slice(node.start ?? 0, Math.min(node.end ?? 0, (node.start ?? 0) + 600))].filter(Boolean).join(" ");
      controls.push({ file, tag, role, name, selectedState: ["aria-pressed", "aria-selected", "checked"].some((key) => attr(opening, key) !== null) });
    });
  }
  return controls;
}

function nameMatches(control, required) {
  const wanted = words(String(required || "").replace(/([a-z])([A-Z])/g, "$1 $2")).filter((word) => !STOP.has(word));
  const actual = normalized(control.name);
  return !wanted.length || wanted.some((word) => actual.includes(normalized(word)));
}

/** Generic pre-browser lint: driveability plus obvious review/confirmation/cancellation breaks. */
export function lintInteractiveWorkflow(tree, { interactionContract, modulePlan = [], bindings = [] } = {}) {
  const findings = [];
  const controls = collectControls(tree);
  const reject = (code, message, flow = null, details = {}) => findings.push({ code, message,
    journeyId: flow?.journeyId || null, interactionId: flow?.id || null, ...details });

  for (const flow of interactionContract?.flows || []) {
    if (!flow.control) continue;
    const matches = controls.filter((control) => flow.control.roles.includes(control.role)
      && nameMatches(control, flow.control.accessibleName));
    if (!matches.length) {
      reject("interaction_control_undriveable", `${flow.id} has no semantic ${flow.control.roles.join("/")} control named for ${flow.control.accessibleName}`, flow,
        { expectedRoles: flow.control.roles, accessibleName: flow.control.accessibleName });
    } else if (flow.control.selectedState && !matches.some((control) => control.selectedState || ["radio", "option", "combobox"].includes(control.role))) {
      reject("selection_state_unobservable", `${flow.id} selectable control does not expose selected state`, flow,
        { files: unique(matches.map((row) => row.file)) });
    }
  }

  const moduleSource = (pattern) => modulePlan.filter((module) => pattern.test(module.role || ""))
    .map((module) => String(tree?.[module.path] || "")).join("\n");
  const reviewSource = moduleSource(/review/i);
  const reviewReads = unique((interactionContract?.flows || []).filter((flow) => flow.kind === "review").flatMap((flow) => flow.reads || []));
  if (reviewReads.length && reviewSource) {
    const missing = reviewReads.filter((path) => !normalized(reviewSource).includes(normalized(path.split(".").at(-1))));
    if (missing.length) reject("review_data_flow_missing", `review presentation does not read contracted values: ${missing.join(", ")}`, null, { missing });
  }
  const confirmationSource = moduleSource(/confirmation/i);
  if (confirmationSource && (interactionContract?.flows || []).some((flow) => flow.kind === "mutation")) {
    if (!/(reference|record|result|booking|reservation)/i.test(confirmationSource)) {
      reject("confirmation_data_flow_missing", "confirmation presentation is not derived from a durable mutation result");
    }
    if (/\b(?:Math\.random|Date\.now|randomUUID)\s*\(/.test(confirmationSource)) {
      reject("fabricated_confirmation_reference", "confirmation reference is fabricated locally instead of using the durable mutation result");
    }
  }
  if ((interactionContract?.flows || []).some((flow) => flow.kind === "cancellation")) {
    const facts = aggregateCapabilityFacts(tree, bindings).get("makeBookingSystem");
    if (!facts?.invoked?.has("cancelBooking")) reject("durable_cancellation_missing", "cancellation does not invoke the required durable capability operation");
  }
  return { ok: findings.length === 0, findings, problems: findings.map((row) => JSON.stringify(row)), controls };
}

/** Structured browser-failure context for one causal repair rather than symptom patching. */
export function interactionFailureDiagnostics({ contract, interactionContract, journeyResults }) {
  const journeys = new Map((contract?.journeys || []).map((journey) => [journey.id, journey]));
  const flows = interactionContract?.flows || [];
  const diagnostics = [];
  for (const result of journeyResults?.journeys || []) {
    const journey = journeys.get(result.id);
    for (const [stepIndex, step] of (result.steps || []).entries()) {
      if (step.status === "pass") continue;
      const related = flows.filter((flow) => flow.journeyId === result.id && flow.stepIndex === stepIndex);
      const expectedBefore = unique(related.flatMap((flow) => flow.dependsOn || []));
      if (!expectedBefore.length) {
        expectedBefore.push(...unique(related.map((flow) => flow.kind === "selection"
          ? `${flow.valueWritten || "control"}:unselected`
          : flow.kind === "input" ? `${flow.valueWritten || "field"}:empty` : null)));
      }
      diagnostics.push({
        code: "interaction_verification_failure",
        journeyId: result.id,
        stepIndex,
        status: step.status,
        expectedStateBefore: expectedBefore,
        userAction: step.action || journey?.steps?.[stepIndex]?.action || null,
        expectedStateAfter: step.expect || journey?.steps?.[stepIndex]?.expect || null,
        actualObservedState: step.detail || "no observable transition",
        responsibleModules: unique([...(result.owners || []), ...related.flatMap((flow) => flow.responsibleModules || [])]),
        stateOwners: unique(related.map((flow) => flow.stateOwner)),
        capabilities: unique(related.map((flow) => flow.capability)),
        dataOperations: (contract?.operations || []).filter((operation) => operation.journey === result.id
          || related.some((flow) => normalized(operation.entity) && normalized(flow.semanticPurpose).includes(normalized(operation.entity))))
          .map((operation) => operation.id || operation.description).filter(Boolean),
        downstreamDependencies: unique(flows.filter((flow) => flow.journeyId === result.id
          && flow.stepIndex > stepIndex && (flow.reads || []).some((path) => related.some((owner) => (owner.writes || []).includes(path))))
          .map((flow) => flow.id)),
      });
    }
  }
  return diagnostics;
}
