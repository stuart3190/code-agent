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
  // Prefer the contract's actual field identity over a second generic alias. A booking entity
  // with guestName/guestEmail/guestPhone needs three controls, not six parallel `guestName` +
  // `name` facts that can drift independently.
  const declaredSuffixes = new Set(declared.map((name) => normalized(name).match(/(name|email|phone)$/)?.[1]).filter(Boolean));
  semantic = semantic.filter((name) => !declaredSuffixes.has(normalized(name))
    || declared.some((declaredName) => normalized(declaredName) === normalized(name)));
  const fallback = words(text).filter((word) => !STOP.has(word)).slice(0, 2);
  const candidates = unique([...declared, ...semantic, ...(declared.length || semantic.length ? [] : fallback)]);
  const semanticKey = (name) => {
    const value = normalized(name);
    if (/date|day/.test(value)) return "date";
    if (/slot|time/.test(value)) return "slot";
    if (/party|quantity|people|guestcount|adult|child/.test(value)) return "partySize";
    if (/email/.test(value)) return "email";
    if (/phone|telephone|mobile/.test(value)) return "phone";
    if (/name/.test(value)) return "name";
    return value;
  };
  const seen = new Set();
  return candidates.filter((name) => {
    const key = semanticKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, kind === "input" ? 8 : 4);
}

function fieldAliases(field) {
  const raw = String(field || "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  const aliases = [raw];
  const lower = raw.toLowerCase();
  if (/name/.test(lower)) aliases.push("name");
  if (/email/.test(lower)) aliases.push("email");
  if (/phone|telephone/i.test(raw)) aliases.push("phone", "telephone");
  if (/slot|time/i.test(raw)) aliases.push("slot", "time");
  if (/date|day/i.test(raw)) aliases.push("date", "day");
  if (/party|quantity|guest|people/i.test(raw)) aliases.push("party size", "guests", "people");
  return unique(aliases.map((value) => value.trim()).filter(Boolean));
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
  if (kind === "input") {
    const aliases = fieldAliases(name);
    const inputTypes = /email/i.test(name) ? ["email"] : /phone|telephone/i.test(name)
      ? ["tel", "text"] : /party|quantity|number/i.test(name) ? ["number", "text"] : ["text"];
    return { purpose: name, logicalField: field || name, roles: ["textbox", "spinbutton", "combobox"],
      inputTypes, accessibleName: aliases[0], accessibleNames: aliases, editable: true };
  }
  if (kind === "selection") return { purpose: name, roles: ["button", "radio", "option", "combobox"],
    logicalField: field || name, accessibleName: fieldAliases(name)[0], accessibleNames: fieldAliases(name), selectedState: true };
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
          const stateOwner = owners[0] || `journey:${journey.id}`;
          const control = controlRequirement(kind, field, step);
          if (control) Object.assign(control, {
            stateOwner,
            statePath: writes[0] || null,
            validationOwner: kind === "input" ? stateOwner : null,
          });
          flows.push({
            id: `${journey.id}:${stepIndex + 1}:${kind}${field ? `:${normalized(field)}` : ""}`,
            journeyId: journey.id,
            stepIndex,
            kind,
            semanticPurpose: step.action,
            stateOwner,
            responsibleModules: owners,
            action: step.action,
            valueWritten: field || null,
            reads: unique(reads),
            writes: unique(writes),
            dependsOn: unique(reads),
            nextStateRequirement: step.expect,
            observable: step.expect,
            control,
            capability: ["mutation", "cancellation", "lookup"].includes(kind)
              ? (bindings.some((binding) => binding.name === "booking") ? "makeBookingSystem" : "makeEntityStore")
              : bindings.some((binding) => binding.name === "wizard") ? "makeWizardMachine" : null,
          });
        }
      }
    }
  }
  for (const flow of flows) {
    if (!flow.control) continue;
    flow.control.downstream = unique(flows.filter((candidate) => candidate.journeyId === flow.journeyId
      && candidate.stepIndex > flow.stepIndex
      && (candidate.reads || []).some((path) => (flow.writes || []).includes(path))).map((candidate) => candidate.id));
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
    "Every contracted control must be present, editable when it accepts input, semantically identifiable through standard HTML/ARIA, connected to its declared state owner, and propagated to downstream review/confirmation consumers.",
    "Use label/htmlFor, a wrapping label, aria-label, or aria-labelledby for accessible names; name/id/placeholder may assist location but do not replace an accessible name.",
    "Visual design remains unrestricted.",
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

function attrRow(opening, name) {
  return (opening?.attributes || []).find((item) => item.type === "JSXAttribute" && item.name?.name === name) || null;
}

function attrSource(raw, opening, name) {
  const row = attrRow(opening, name);
  return row && Number.isInteger(row.start) && Number.isInteger(row.end) ? String(raw).slice(row.start, row.end) : "";
}

function staticBooleanAttr(opening, name) {
  const row = attrRow(opening, name);
  if (!row) return false;
  if (!row.value) return true;
  if (["StringLiteral", "Literal"].includes(row.value.type)) return String(row.value.value).toLowerCase() !== "false";
  const expression = row.value.type === "JSXExpressionContainer" ? row.value.expression : null;
  if (expression?.type === "BooleanLiteral") return expression.value;
  return null; // dynamic: browser verification remains authoritative
}

function jsxName(node) {
  return node?.name?.type === "JSXIdentifier" ? node.name.name : null;
}

function handlerDefinition(raw, handlerSource) {
  const name = String(handlerSource || "").match(/=\{\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1];
  if (!name) return "";
  const pattern = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`);
  const match = pattern.exec(raw);
  return match ? String(raw).slice(match.index, match.index + 1200) : "";
}

function nativeRole(tag, opening) {
  const lower = String(tag || "").toLowerCase();
  const component = ["input", "textarea", "select", "button", "option"].includes(lower) ? lower : null;
  if (component === "input") {
    const type = String(attr(opening, "type") || "text").toLowerCase();
    if (type === "number") return "spinbutton";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return { textarea: "textbox", select: "combobox", button: "button", option: "option" }[component] || null;
}

/** Source-backed facts used by both the deterministic lint and browser-repair diagnostics. */
export function collectInteractionControls(tree) {
  const controls = [];
  for (const [file, raw] of Object.entries(tree || {})) {
    if (!SOURCE.test(file) || PLATFORM.test(file)) continue;
    let ast;
    try {
      ast = parse(String(raw), { sourceType: "module", plugins: [/\.tsx?$/.test(file) ? "typescript" : null,
        /\.(?:jsx|tsx)$/.test(file) ? "jsx" : null].filter(Boolean) });
    } catch { continue; }
    const labels = [];
    const namedText = new Map();
    walk(ast, (node) => {
      if (node.type !== "JSXElement") return;
      const opening = node.openingElement;
      const tag = jsxName(opening);
      const childText = (node.children || []).map(literal).join(" ").replace(/\s+/g, " ").trim();
      const id = attr(opening, "id");
      if (id && childText) namedText.set(id, childText);
      if (String(tag || "").toLowerCase() === "label") {
        labels.push({ htmlFor: attr(opening, "htmlFor") || attr(opening, "for"), text: childText,
          start: node.start ?? -1, end: node.end ?? -1 });
      }
    });
    walk(ast, (node) => {
      if (node.type !== "JSXElement") return;
      const opening = node.openingElement;
      const tag = jsxName(opening);
      const role = attr(opening, "role") || nativeRole(tag, opening);
      if (!role) return;
      const childText = (node.children || []).map(literal).join(" ").replace(/\s+/g, " ").trim();
      const id = attr(opening, "id");
      const label = labels.find((row) => (id && row.htmlFor === id)
        || (row.start <= (node.start ?? -1) && row.end >= (node.end ?? -1)));
      const ariaLabel = attr(opening, "aria-label");
      const labelledBy = attr(opening, "aria-labelledby");
      const labelledByText = labelledBy ? labelledBy.split(/\s+/).map((key) => namedText.get(key)).filter(Boolean).join(" ") : "";
      const title = attr(opening, "title");
      const accessibleName = ariaLabel || labelledByText || label?.text || title || null;
      const nameAttr = attr(opening, "name");
      const placeholder = attr(opening, "placeholder");
      const type = String(attr(opening, "type") || (String(tag).toLowerCase().includes("textarea") ? "textarea" : "text")).toLowerCase();
      const changeHandlerSource = [attrSource(raw, opening, "onChange"), attrSource(raw, opening, "onInput")].filter(Boolean).join(" ");
      const resolvedHandlerSource = handlerDefinition(String(raw), changeHandlerSource);
      const valueSource = [attrSource(raw, opening, "value"), attrSource(raw, opening, "defaultValue"),
        attrSource(raw, opening, "checked")].filter(Boolean).join(" ");
      controls.push({
        file, line: node.loc?.start?.line || null, span: { start: node.start ?? null, end: node.end ?? null },
        tag, role, inputType: type, name: unique([accessibleName, nameAttr, id, placeholder, title, childText]).join(" "),
        accessibleName, ariaLabel: ariaLabel || null, labelledBy: labelledBy || null,
        label: label?.text || null, nameAttr: nameAttr || null, id: id || null,
        placeholder: placeholder || null, title: title || null,
        locatorIdentities: unique([accessibleName, ariaLabel, labelledByText, label?.text, nameAttr, id, placeholder, title, childText]),
        disabled: staticBooleanAttr(opening, "disabled"), readOnly: staticBooleanAttr(opening, "readOnly"),
        controlled: Boolean(attrRow(opening, "value") || attrRow(opening, "checked")),
        hasChangeHandler: Boolean(changeHandlerSource), changeHandlerSource, resolvedHandlerSource, valueSource,
        selectedState: ["aria-pressed", "aria-selected", "checked"].some((key) => attrRow(opening, key) !== null),
      });
    });
  }
  return controls;
}

function nameMatches(control, required) {
  const requiredNames = Array.isArray(required) ? required : [required];
  const wanted = requiredNames.flatMap((name) => words(String(name || "").replace(/([a-z])([A-Z])/g, "$1 $2")))
    .filter((word) => !STOP.has(word));
  const actual = (control.locatorIdentities || [control.name]).map(normalized);
  return !wanted.length || wanted.some((word) => actual.some((name) => name.includes(normalized(word))));
}

function stateConnection(control, flow) {
  const aliases = unique([flow.valueWritten, flow.control?.logicalField, ...(flow.control?.accessibleNames || [])]);
  const evidence = normalized([control.valueSource, control.changeHandlerSource, control.resolvedHandlerSource].join(" "));
  if (aliases.some((alias) => evidence.includes(normalized(alias)))) return true;
  const actualName = normalized(control.nameAttr);
  const named = Boolean(actualName) && aliases.some((alias) => normalized(alias)
    && (actualName === normalized(alias) || actualName.endsWith(normalized(alias)) || normalized(alias).endsWith(actualName)));
  const generic = /targetname|currenttargetname|formdata/.test(evidence);
  // A named uncontrolled field can be read by its containing form. AST lint deliberately stops
  // here; only the browser can prove the later transition.
  return named && (!control.controlled || generic);
}

/** Generic pre-browser lint: driveability plus obvious review/confirmation/cancellation breaks. */
export function lintInteractiveWorkflow(tree, { interactionContract, modulePlan = [], bindings = [] } = {}) {
  const findings = [];
  const controls = collectInteractionControls(tree);
  const reject = (code, message, flow = null, details = {}) => findings.push({ code, message,
    journeyId: flow?.journeyId || null, interactionId: flow?.id || null, ...details });

  for (const flow of interactionContract?.flows || []) {
    if (!flow.control) continue;
    const roleMatches = controls.filter((control) => flow.control.roles.includes(control.role));
    const matches = roleMatches.filter((control) =>
      nameMatches(control, flow.control.accessibleNames || flow.control.accessibleName));
    if (!matches.length) {
      const provenanceMatches = flow.control.editable ? roleMatches.filter((control) => stateConnection(control, flow)) : [];
      if (provenanceMatches.length) {
        reject("interaction_control_undriveable", `${flow.id} has no standards-based accessible identity`, flow, {
          field: flow.control.logicalField, expectedRoles: flow.control.roles,
          accessibleName: flow.control.accessibleName, expectedStateOwner: flow.stateOwner,
          reason: "missing_accessible_identity", controls: provenanceMatches,
        });
        continue;
      }
      reject("interaction_control_undriveable", `${flow.id} has no semantic ${flow.control.roles.join("/")} control named for ${flow.control.accessibleName}`, flow,
        { field: flow.control.logicalField, expectedRoles: flow.control.roles,
          accessibleName: flow.control.accessibleName, expectedStateOwner: flow.stateOwner,
          reason: "missing_editable_control", responsibleModules: flow.responsibleModules });
      continue;
    }
    const compatible = matches.filter((control) => !flow.control.inputTypes?.length
      || !control.inputType || flow.control.inputTypes.includes(control.inputType));
    if (flow.control.editable && flow.control.inputTypes?.length && !compatible.length) {
      reject("interaction_control_undriveable", `${flow.id} uses the wrong control type`, flow, {
        field: flow.control.logicalField, reason: "invalid_control_type", expectedInputTypes: flow.control.inputTypes,
        expectedStateOwner: flow.stateOwner, controls: matches,
      });
      continue;
    }
    const candidates = compatible.length ? compatible : matches;
    if (flow.control.editable && candidates.every((control) => control.disabled === true || control.readOnly === true)) {
      reject("interaction_control_undriveable", `${flow.id} has no editable control`, flow, {
        field: flow.control.logicalField, reason: candidates.every((control) => control.disabled === true) ? "disabled" : "readonly",
        expectedStateOwner: flow.stateOwner, controls: candidates,
      });
    } else if (flow.control.editable && candidates.every((control) => !control.accessibleName)) {
      reject("interaction_control_undriveable", `${flow.id} has no standards-based accessible identity`, flow, {
        field: flow.control.logicalField, reason: "missing_accessible_identity", expectedStateOwner: flow.stateOwner,
        controls: candidates,
      });
    } else if (flow.control.editable && candidates.every((control) => control.controlled && !control.hasChangeHandler)) {
      reject("interaction_control_undriveable", `${flow.id} is controlled but has no input/change transition`, flow, {
        field: flow.control.logicalField, reason: "controlled_without_change_handler", expectedStateOwner: flow.stateOwner,
        controls: candidates,
      });
    } else if (flow.control.editable && candidates.every((control) => !stateConnection(control, flow))) {
      reject("interaction_control_undriveable", `${flow.id} is not connected to the contracted state owner`, flow, {
        field: flow.control.logicalField, reason: "state_owner_not_connected", expectedStateOwner: flow.stateOwner,
        controls: candidates,
      });
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
export function interactionFailureDiagnostics({ contract, interactionContract, journeyResults, tree = null }) {
  const journeys = new Map((contract?.journeys || []).map((journey) => [journey.id, journey]));
  const flows = interactionContract?.flows || [];
  const diagnostics = [];
  for (const result of journeyResults?.journeys || []) {
    const journey = journeys.get(result.id);
    for (const [stepIndex, step] of (result.steps || []).entries()) {
      if (["pass", "not_reached", "skipped"].includes(step.status)) continue;
      const related = flows.filter((flow) => flow.journeyId === result.id && flow.stepIndex === stepIndex);
      const sourceControls = tree ? collectInteractionControls(tree).filter((control) => related.some((flow) =>
        flow.control && flow.control.roles.includes(control.role)
        && (nameMatches(control, flow.control.accessibleNames || flow.control.accessibleName)
          || ((flow.responsibleModules || []).includes(control.file) && stateConnection(control, flow))))) : [];
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
        controlEvidence: step.controlEvidence || null,
        expectedControls: related.filter((flow) => flow.control).map((flow) => ({
          field: flow.control.logicalField, roles: flow.control.roles,
          accessibleNames: flow.control.accessibleNames || [flow.control.accessibleName],
          expectedStateOwner: flow.stateOwner,
        })),
        renderedControlFacts: step.controlEvidence?.renderedControls || sourceControls,
        attemptedLocators: step.controlEvidence?.attemptedLocators || [],
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
