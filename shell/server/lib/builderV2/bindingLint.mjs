// BUILD-TIME BINDING LINT — is every contracted control actually addressable?
//
// The browser's mechanics probe addresses controls by `data-thrallo-control`. A generated app that
// HAND-WIRES a control carries no such attribute, so the probe cannot see it, and the defect first
// appears as a step failure part-way through a paid qualification. Run #8 (2026-08-12) died on
// step 2 of 8 that way: a date chooser whose options never took a selected state, invisible to the
// probe because nothing addressed it.
//
// This runs after emit and before the app is served. It is DETECTION ONLY — it repairs nothing,
// and it does not touch the verifier, the probe or the correction tier.
//
// THE HARD PART IS NOT FINDING UNBOUND ELEMENTS. It is not condemning bound ones. The preferred
// binding is a SPREAD:
//
//     <input {...field.inputProps} />        // useSemanticField injects the attribute at runtime
//
// and not one of Thrallo's four passing browser fixtures contains a literal `data-thrallo-control`
// in its JSX. A lint that looked for the attribute as text would fail every correctly-built app and
// pass none. So a spread is resolved to its binding where it can be, and where it cannot be — a
// wrapper component, forwarded props — the element is UNRESOLVED and is never failed. That is the
// same rule as the PROVEN/SUSPECT split, for the same reason: unknown is not broken.

import { parse } from "@babel/parser";

import { identityMatches, semanticAliases, semanticKey } from "./controlIdentity.mjs";
import { ADVANCE_ACTION_NAME, actionIdFor, controlIdFor } from "./verificationManifest.mjs";

/** How an element gets its machine identity, or fails to. */
export const BINDING = Object.freeze({
  LITERAL: "BOUND_LITERAL",       // the attribute is written on the element
  BINDING: "BOUND_VIA_BINDING",   // a spread that resolves to a capability binding
  UNRESOLVED: "UNRESOLVED",       // a spread this file cannot trace — never a failure
  UNBOUND: "UNBOUND",             // neither: the probe cannot address it
});

// The capability helpers that inject a machine identity, and the prop objects they return.
const BINDING_FACTORIES = /\b(useSemanticField|useSemanticSelection|useSemanticAction|useFlowAdvance)\s*\(/;
const BINDING_PROPS = /\b(inputProps|groupProps|optionProps|buttonProps|labelProps|statusProps)\b/;

// Native elements that are interactive by tag alone. `a` is deliberately absent: a link navigates,
// it is not a contracted control, and flagging links would bury the signal.
const NATIVE = new Set(["input", "textarea", "select", "button", "option"]);
// ARIA roles that promise an interaction.
const ROLES = new Set(["button", "option", "tab", "checkbox", "radio", "switch",
  "combobox", "listbox", "menuitem", "textbox", "slider", "spinbutton"]);
const HANDLERS = ["onClick", "onChange", "onInput", "onSubmit"];

const SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
// Platform infrastructure: it DEFINES the bindings, so linting it is circular.
const PLATFORM = /^src\/lib\//;

const text = (node) => {
  if (!node) return "";
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "JSXExpressionContainer") return text(node.expression);
  if (node.type === "TemplateLiteral") return node.quasis.map((q) => q.value.cooked).join(" ");
  return "";
};

const attrNode = (opening, name) => (opening.attributes || [])
  .find((row) => row?.type === "JSXAttribute" && row.name?.name === name) || null;
const attr = (opening, name) => text(attrNode(opening, name)?.value);
const jsxName = (opening) => {
  const node = opening.name;
  if (node?.type === "JSXIdentifier") return node.name;
  if (node?.type === "JSXMemberExpression") return `${node.object?.name || ""}.${node.property?.name || ""}`;
  return "";
};

/**
 * What makes an element interactive. Three independent claims, any one of which is enough: it is a
 * native control, it announces a role that promises interaction, or it handles an interaction.
 */
function interactivity(opening) {
  const tag = jsxName(opening);
  const role = attr(opening, "role");
  const handlers = HANDLERS.filter((name) => attrNode(opening, name));
  const type = String(attr(opening, "type") || "").toLowerCase();
  // A hidden input is not something a person or a browser driver operates.
  if (NATIVE.has(tag.toLowerCase()) && type === "hidden") return null;
  if (NATIVE.has(tag.toLowerCase())) return { via: "native", tag, role, handlers };
  if (ROLES.has(String(role).toLowerCase())) return { via: "role", tag, role, handlers };
  // A handler alone counts only with a role: a div that happens to take a click is chrome far more
  // often than it is a contracted control, and every such div would be noise.
  if (handlers.length && role) return { via: "handler", tag, role, handlers };
  return null;
}

/**
 * Resolve how (and whether) this element is bound.
 *
 * A spread is traced by SOURCE TEXT rather than by evaluating the program: `{...field.inputProps}`
 * is matched to a `field` declared from a binding factory in the same file. That is deliberately
 * conservative — anything it cannot follow becomes UNRESOLVED, which never fails a build.
 */
function bindingOf(opening, fileSource, raw) {
  const literalControl = attrNode(opening, "data-thrallo-control");
  const literalAction = attrNode(opening, "data-thrallo-action");
  const literal = literalAction || literalControl;
  if (literal) return { binding: BINDING.LITERAL, evidence: "attribute",
    attribute: literalAction ? "data-thrallo-action" : "data-thrallo-control",
    machineId: text(literal.value) || null };

  const spreads = (opening.attributes || []).filter((row) => row?.type === "JSXSpreadAttribute");
  if (!spreads.length) return { binding: BINDING.UNBOUND, evidence: null };

  for (const spread of spreads) {
    const expression = raw.slice(spread.argument.start, spread.argument.end);
    // WHICH CONTROL a spread binds is not written on the element — it is written in the factory
    // call that produced the props. `const dates = useSemanticSelection({ name: "eventDate" })`
    // says so exactly, and that is a far stronger link than any text on the JSX, which for a
    // correctly bound control is usually absent altogether.
    const root = expression.match(/^[A-Za-z_$][\w$]*/)?.[0];
    const declaration = root
      ? (fileSource.match(new RegExp(`\\b(?:const|let|var)\\s+${root}\\s*=\\s*[\\s\\S]{0,240}`)) || [])[0] || ""
      : "";
    const factory = (declaration.match(/\b(useSemanticField|useSemanticSelection|useSemanticAction|useFlowAdvance)\s*\(/)
      || [])[1] || null;
    const boundName = factory === "useFlowAdvance" ? ADVANCE_ACTION_NAME
      : factory ? (declaration.match(/name\s*:\s*["'`]([^"'`]+)["'`]/) || [])[1] || null
      : null;
    const actionName = factory === "useSemanticSelection"
      ? (declaration.match(/actionName\s*:\s*["'`]([^"'`]+)["'`]/) || [])[1] || null
      : null;

    if (BINDING_FACTORIES.test(declaration)) {
      return { binding: BINDING.BINDING, evidence: expression.slice(0, 60), boundName,
        actionName, factory };
    }
    if (BINDING_PROPS.test(expression)) {
      return { binding: BINDING.UNRESOLVED, evidence: expression.slice(0, 60) };
    }
    // A spread this file cannot follow. It may well be bound — a wrapper component, props forwarded
    // from a parent — and condemning it is exactly the false positive that made the old static
    // finding unusable.
    return { binding: BINDING.UNRESOLVED, evidence: expression.slice(0, 60) };
  }
  return { binding: BINDING.UNBOUND, evidence: null };
}

/** Everything about this element that could name a contracted control. */
function identitiesOf(node, opening, raw, labels) {
  const id = attr(opening, "id");
  const label = labels.find((row) => (id && row.htmlFor === id)
    || (row.start <= (node.start ?? -1) && row.end >= (node.end ?? -1)));
  const childText = (node.children || [])
    .map((child) => (child.type === "JSXText" ? child.value : ""))
    .join(" ").replace(/\s+/g, " ").trim();
  return [attr(opening, "aria-label"), label?.text, id, attr(opening, "name"),
    attr(opening, "placeholder"), attr(opening, "title"), childText]
    .map((value) => String(value || "").trim()).filter(Boolean);
}

function walkFile(file, source, elements) {
  let ast;
  try {
    ast = parse(String(source), { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: true });
  } catch { return; }
  const raw = String(source);
  const labels = [];
  const visit = (node, fn) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const row of node) visit(row, fn); return; }
    if (node.type) fn(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (value && typeof value === "object") visit(value, fn);
    }
  };
  // Labels first, so a control can be identified by the text that names it.
  visit(ast, (node) => {
    if (node.type !== "JSXElement" || jsxName(node.openingElement).toLowerCase() !== "label") return;
    labels.push({
      htmlFor: attr(node.openingElement, "htmlFor") || attr(node.openingElement, "for"),
      text: (node.children || []).map((child) => (child.type === "JSXText" ? child.value : "")).join(" ").trim(),
      start: node.start ?? -1, end: node.end ?? -1,
    });
  });
  // A SELECTION IS TWO ELEMENTS. The group holds the identity — `<div role="group" id="eventDate">`
  // — and the options hold the interaction. Examined separately, the group is not interactive and
  // the options are anonymous (their text is usually `{value}`, an expression), so a per-element
  // walk sees neither and reports the contracted control missing. That is exactly the shape run #8
  // failed on. Identity is therefore INHERITED from the nearest naming ancestor, which is also how
  // a screen reader resolves a grouped control.
  const inheritedFor = new Map();
  const descend = (node, inherited) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const row of node) descend(row, inherited); return; }
    let next = inherited;
    if (node.type === "JSXElement") {
      inheritedFor.set(node, inherited);
      const own = identitiesOf(node, node.openingElement, raw, labels);
      // A container that names itself passes that name down; an interactive element does not
      // (a button inside a button is not a thing, and a form should not name its fields).
      if (own.length && !interactivity(node.openingElement)) next = [...inherited, ...own];
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (value && typeof value === "object") descend(value, next);
    }
  };
  descend(ast, []);

  visit(ast, (node) => {
    if (node.type !== "JSXElement") return;
    const opening = node.openingElement;
    const interactive = interactivity(opening);
    if (!interactive) {
      // A CONTAINER THAT MIGHT BE THE BINDING. `<div {...groupProps} id="eventDate">` is not itself
      // operated, so it is never a failure — but it may be exactly where a group binding lands, and
      // if this file cannot follow the spread it must be allowed to cover the control it names.
      // Otherwise the hand-wired options inside it would be condemned for a binding that is
      // probably there. Unknown is not broken, one level up.
      const spread = (opening.attributes || []).some((row) => row?.type === "JSXSpreadAttribute");
      const identities = spread ? identitiesOf(node, opening, raw, labels) : [];
      if (spread && identities.length) {
        const resolved = bindingOf(opening, raw, raw);
        elements.push({
          file, line: node.loc?.start?.line || null, element: `<${jsxName(opening)}>`,
          via: "container", binding: resolved.binding, bindingEvidence: resolved.evidence,
          boundName: resolved.boundName || null, actionName: resolved.actionName || null,
          factory: resolved.factory || null, attribute: resolved.attribute || null,
          machineId: resolved.machineId || null,
          identities, inheritedIdentities: inheritedFor.get(node) || [], coversOnly: true,
        });
      }
      return;
    }
    const { binding, evidence, boundName = null, actionName = null, factory = null,
      attribute = null, machineId = null } = bindingOf(opening, raw, raw);
    elements.push({
      file, line: node.loc?.start?.line || null,
      element: `<${jsxName(opening)}${interactive.role ? ` role="${interactive.role}"` : ""}>`,
      via: interactive.via, binding, bindingEvidence: evidence,
      // What the BINDING says this control is — the authoritative link when one exists.
      boundName, actionName, factory, attribute, machineId,
      identities: identitiesOf(node, opening, raw, labels),
      // …plus whatever names the container it sits in, so a grouped chooser is identifiable.
      inheritedIdentities: inheritedFor.get(node) || [],
    });
  });
}

/**
 * The contracted-intersection rule.
 *
 * An unbound interactive element is only a BUILD FAILURE when it plausibly serves a control the
 * contract names and nothing else in the tree serves that control bound. Uncontracted chrome — a
 * nav toggle, an accordion, a modal close — is reported and never fails: the contract does not name
 * it, the model was never asked to bind it, and failing builds over it would block correct work.
 *
 * @returns {{ok: boolean, findings: Array, elements: Array, coverage: Array, residualGap: string}}
 */
export function lintControlBindings(tree, { interactionContract, authoritativeFiles = null } = {}) {
  const authoritative = authoritativeFiles
    ? new Set([...authoritativeFiles].map((file) => String(file))) : null;
  const inAuthority = (file) => !authoritative || authoritative.has(file);
  const elements = [];
  for (const [file, source] of Object.entries(tree || {})) {
    if (!SOURCE.test(file) || PLATFORM.test(file) || !inAuthority(file)) continue;
    walkFile(file, source, elements);
  }

  // Binding factories called with something other than a string literal — a field bound inside a
  // loop, where the name is a variable. Each one can bind a control no static reader can name.
  const dynamicBindings = [];
  const FACTORY_CALL = /use(?:SemanticField|SemanticSelection|SemanticAction|FlowAdvance)\s*\(\s*\{[^}]*\}/g;
  for (const [file, source] of Object.entries(tree || {})) {
    if (!SOURCE.test(file) || PLATFORM.test(file) || !inAuthority(file)) continue;
    for (const call of String(source).match(FACTORY_CALL) || []) {
      if (!/^useFlowAdvance\b/.test(call) && !/name\s*:\s*['"`]/.test(call)) {
        dynamicBindings.push(`${file}: ${call.replace(/\s+/g, " ").slice(0, 70)}`);
      }
    }
  }

  const findings = [];
  const coverage = [];
  const claimed = new Set();

  const requiredBindingFor = (flow, key) => {
    const name = String(key || "");
    if (["input", "selection"].includes(flow.kind)) {
      const helper = flow.kind === "selection" ? "useSemanticSelection" : "useSemanticField";
      return {
        helper,
        name,
        attribute: "data-thrallo-control",
        machineId: flow.control?.machineId || controlIdFor(name),
        spread: flow.kind === "selection" ? "groupProps + optionProps(option)" : "inputProps",
      };
    }
    if (flow.kind === "flow_start" && flow.control?.logicalField) {
      const actionName = String(flow.control.accessibleName || flow.control.purpose || name);
      return {
        helper: "useSemanticSelection",
        name,
        actionName,
        attribute: "data-thrallo-control + data-thrallo-action",
        machineId: flow.control?.machineId || actionIdFor(actionName),
        spread: "groupProps + optionProps(option)",
      };
    }
    const helper = flow.kind === "flow_advance" ? "useFlowAdvance" : "useSemanticAction";
    const bindingName = flow.kind === "flow_advance" ? ADVANCE_ACTION_NAME
      : String(flow.operationId || flow.control?.accessibleName || flow.control?.purpose || name);
    return {
      helper,
      name: bindingName,
      attribute: "data-thrallo-action",
      machineId: flow.control?.machineId || actionIdFor(bindingName),
      spread: "buttonProps",
    };
  };

  for (const flow of interactionContract?.flows || []) {
    if (!flow.control) continue;
    const key = flow.control.logicalField || flow.control.accessibleName;
    if (!key) continue;
    const names = flow.control.accessibleNames?.length
      ? flow.control.accessibleNames : semanticAliases(key);
    // THREE WAYS AN ELEMENT CAN CLAIM A CONTRACTED CONTROL, strongest first.
    //  1. its binding factory NAMES the control  — `useSemanticField({ name: "guestName" })`
    //  2. its literal attribute carries the control's IDENTITY — data-thrallo-control="ctl_…"
    //  3. only for UNBOUND elements: the text on it matches the control's semantic key
    // The first two are exact. The third is the fragile one, and it is the only one used to
    // condemn anything — which is why the residual gap below is stated with every result.
    const actionFlow = !["input", "selection"].includes(flow.kind);
    const expectedActionName = String(flow.control?.accessibleName || flow.control?.purpose || key);
    const expectedBindingName = actionFlow && flow.operationId ? String(flow.operationId) : String(key);
    const claims = (row) => {
      if (row.actionName && actionFlow) return semanticKey(row.actionName) === semanticKey(expectedActionName);
      if (row.boundName) return [key, expectedBindingName]
        .some((candidate) => semanticKey(row.boundName) === semanticKey(candidate));
      if (row.machineId) return [flow.control?.machineId, controlIdFor(key), actionIdFor(key), controlIdFor(flow.control.accessibleName || key),
        actionIdFor(flow.control.accessibleName || key)].includes(row.machineId);
      // A resolved helper whose semantic name is unknown is not proof that THIS control is bound.
      // In particular useFlowAdvance always emits the canonical "advance" action; visible copy on
      // that button cannot turn it into an arbitrary contracted action identity.
      if (row.binding === BINDING.BINDING) return false;
      return [...row.identities, ...(row.inheritedIdentities || [])].some((identity) =>
        identityMatches([identity], names) || semanticKey(identity) === semanticKey(key));
    };
    const matches = elements.filter(claims);
    for (const row of matches) claimed.add(row);

    const compatibleBinding = (row) => {
      if (row.binding === BINDING.UNBOUND) return false;
      if (row.binding === BINDING.LITERAL) {
        return row.attribute === (actionFlow ? "data-thrallo-action" : "data-thrallo-control")
          && (!row.machineId || row.machineId === flow.control?.machineId);
      }
      if (flow.kind === "input") return row.factory === "useSemanticField";
      if (flow.kind === "selection") return row.factory === "useSemanticSelection";
      if (flow.kind === "flow_advance") return row.factory === "useFlowAdvance";
      if (flow.kind === "flow_start" && row.factory === "useSemanticSelection") {
        return semanticKey(row.actionName) === semanticKey(expectedActionName);
      }
      return row.factory === "useSemanticAction"
        && (!flow.operationId || semanticKey(row.boundName) === semanticKey(expectedBindingName));
    };
    const bound = matches.filter((row) => row.binding !== BINDING.UNBOUND);
    const compatibleBound = matches.filter(compatibleBinding);
    const provenBound = matches.filter((row) => [BINDING.LITERAL, BINDING.BINDING].includes(row.binding));
    // A bound implementation on a later surface must not mask a second, hand-wired implementation
    // of the same contracted control. This is narrower than the general textual binding lint: the
    // unbound element must itself carry the contracted semantic identity, and another element must
    // prove the platform binding exists elsewhere. That exact mixed state is internally
    // inconsistent and is safe to correct before a paid browser pass.
    const shadowedUnbound = matches.filter((row) => row.binding === BINDING.UNBOUND && !row.coversOnly
      && [...row.identities, ...(row.inheritedIdentities || [])]
        .some((identity) => semanticKey(identity) === semanticKey(key)));
    const requiredBinding = requiredBindingFor(flow, key);
    coverage.push({ interactionId: flow.id, control: key, matched: matches.length, bound: bound.length,
      compatibleBound: compatibleBound.length,
      authoritativeSurface: Boolean(authoritative) });

    if (!matches.length && dynamicBindings.length) {
      // A DYNAMIC BINDING BINDS A CONTROL THIS FILE CANNOT NAME.
      //
      //   const fields = Object.fromEntries(NAMES.map((name) => [name, useSemanticField({ name })]))
      //
      // is correct, common, and binds every field in the list — but the factory is called with a
      // variable, so no name can be read out of it and the elements carry no static identity at
      // all. Measured against `opaqueIdentityApp`, a fixture that passes in a real browser, the
      // textual rule reported SEVEN contracted controls missing. A build must never fail for that.
      coverage[coverage.length - 1].undetermined = true;
      findings.push({
        code: "contract_control_coverage_undetermined", fails: false, interactionId: flow.id,
        control: key, inferredKey: semanticKey(key), journeyId: flow.journeyId || null,
        requiredBinding, authoritativeSurface: Boolean(authoritative),
        dynamicBindings: dynamicBindings.slice(0, 3),
        message: `no static element names the contracted control "${key}", but this tree binds `
          + `controls dynamically (${dynamicBindings[0]}) — coverage cannot be decided offline`,
      });
      continue;
    }
    if (!matches.length) {
      // Nothing in the tree even looks like this control. The app is missing a control the
      // contract requires, which no amount of binding would fix.
      findings.push({
        code: "contract_control_missing", fails: true, interactionId: flow.id,
        control: key, inferredKey: semanticKey(key), expectedRoles: flow.control.roles || [],
        journeyId: flow.journeyId || null, responsibleModules: flow.responsibleModules || [],
        requiredBinding, authoritativeSurface: Boolean(authoritative),
        message: `no element in the generated tree names the contracted control "${key}"`,
      });
      continue;
    }
    if (bound.length && !compatibleBound.length) {
      findings.push({
        code: "contract_control_wrong_binding", fails: true, interactionId: flow.id,
        control: key, inferredKey: semanticKey(key), journeyId: flow.journeyId || null,
        requiredBinding, authoritativeSurface: Boolean(authoritative),
        elements: bound.filter((row) => !row.coversOnly).map((row) => ({
          file: row.file, line: row.line, element: row.element, via: row.via,
          factory: row.factory, boundName: row.boundName, actionName: row.actionName,
          attribute: row.attribute, machineId: row.machineId,
        })),
        message: `the contracted ${flow.kind} control "${key}" is bound through an incompatible `
          + `semantic primitive; apply ${requiredBinding.helper} with the declared machine identity`,
      });
    } else if (provenBound.length && shadowedUnbound.length) {
      findings.push({
        code: "contract_control_binding_conflict", fails: true, interactionId: flow.id,
        control: key, inferredKey: semanticKey(key), journeyId: flow.journeyId || null,
        requiredBinding, authoritativeSurface: Boolean(authoritative),
        shadowedByBoundDuplicate: true,
        elements: shadowedUnbound.map((row) => ({ file: row.file, line: row.line, element: row.element,
          via: row.via, identities: row.identities.slice(0, 4) })),
        message: `the contracted control "${key}" has a machine-bound implementation, but `
          + `${shadowedUnbound.map((row) => `${row.file}:${row.line}`).join(", ")} also implements `
          + "that exact control without machine identity; bind the journey-facing implementation",
      });
    } else if (!bound.length) {
      // Present, hand-wired, and therefore invisible to the browser's mechanics probe.
      findings.push({
        code: "contract_control_unbound", fails: true, interactionId: flow.id,
        control: key, inferredKey: semanticKey(key), journeyId: flow.journeyId || null,
        requiredBinding, authoritativeSurface: Boolean(authoritative),
        elements: matches.filter((row) => !row.coversOnly).map((row) => ({ file: row.file, line: row.line, element: row.element,
          via: row.via, identities: row.identities.slice(0, 4) })),
        message: `the contracted control "${key}" is hand-wired at `
          + `${matches.map((row) => `${row.file}:${row.line}`).join(", ")} with no machine identity, `
          + "so verification cannot address it",
      });
    }
  }

  // Everything else that is interactive and unaddressable: reported, never failed.
  for (const row of elements) {
    if (row.coversOnly || row.binding !== BINDING.UNBOUND || claimed.has(row)) continue;
    findings.push({
      code: "uncontracted_control_unbound", fails: false,
      file: row.file, line: row.line, element: row.element, via: row.via,
      inferredKey: semanticKey(row.identities[0] || "") || null,
      identities: row.identities.slice(0, 4),
      message: `${row.element} at ${row.file}:${row.line} carries no machine identity and matches no `
        + "contracted control — reported for visibility, not a build failure",
    });
  }

  // COVERAGE IS A CLAIM THIS WALKER OFTEN CANNOT MAKE.
  //
  // Three of the four ways a correct app binds a control — a wrapper component, a store, a factory
  // called with a variable — are structurally outside the reach of a static reader. Where any of
  // them is present, "no contracted control was found unbound" is not a statement about the app;
  // it is a statement about what could be seen. The report says so at TREE level, so a consumer
  // cannot mistake a quiet result for a proof, and so that driving the false-rejection rate to
  // zero could never be achieved by simply ceasing to fire wherever indirection appears.
  const unresolved = elements.filter((row) => row.binding === BINDING.UNRESOLVED);
  const undeterminedReasons = [
    ...(dynamicBindings.length ? [`${dynamicBindings.length} control(s) bound dynamically: ${dynamicBindings[0]}`] : []),
    ...(unresolved.length ? [`${unresolved.length} element(s) carry a spread this walker cannot follow `
      + `(${unresolved[0].file}:${unresolved[0].line})`] : []),
  ];

  return {
    ok: !findings.some((row) => row.fails),
    findings, elements, coverage,
    authoritativeSurface: Boolean(authoritative),
    ignoredSourceFiles: authoritative ? Object.keys(tree || {}).filter((file) => SOURCE.test(file)
      && !PLATFORM.test(file) && !authoritative.has(file)).sort() : [],
    // True whenever ANY binding in the tree was unreadable — not merely for the controls affected.
    coverageUndetermined: undeterminedReasons.length > 0,
    undeterminedReasons,
    // STATED WITH THE RESULT, EVERY TIME. The intersection depends on a TEXTUAL match between an
    // element's accessible name, id or label and the contracted control's semantic key. A control
    // labelled divergently from its key — "Choose your evening" against `eventDate` — matches
    // nothing here and is not caught. A green lint means no contracted control was found unbound;
    // it is not a proof that every contracted control is bound.
    residualGap: "matching is textual (accessible name / id / label vs semantic key); a control "
      + "labelled divergently from its contracted key is not detected. A green result is not a "
      + "proof of bound coverage.",
  };
}
