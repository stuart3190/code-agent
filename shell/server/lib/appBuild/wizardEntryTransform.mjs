// Deterministic alignment and causal latching for generated flow-entry controls.
//
// This is intentionally proof-driven. It does not guess from domain words: it resolves concrete
// state and semantic-control relationships in the generated AST, then uses the interaction
// contract to prove the entry action and its first outcome. Dynamic, cross-component or otherwise
// ambiguous shapes are left untouched for ordinary browser verification and targeted repair.

import path from "node:path";
import { parse } from "@babel/parser";

const GENERATED_FILE = /^src\/.*\.(?:jsx?|tsx?)$/;
const PLATFORM_PATH = /^src\/lib\/(?:capabilities\/|backend\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
const AST_KEYS_TO_SKIP = new Set(["loc", "start", "end", "extra", "errors", "comments", "tokens"]);

function walk(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (AST_KEYS_TO_SKIP.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}

function parseModule(file, source) {
  const typescript = /\.tsx?$/.test(file);
  return parse(String(source), {
    sourceType: "module",
    plugins: [typescript ? "typescript" : null, /\.(?:jsx|tsx)$/.test(file) ? "jsx" : null].filter(Boolean),
    errorRecovery: false,
  });
}

function propertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (["StringLiteral", "NumericLiteral"].includes(node?.type)) return String(node.value);
  return null;
}

function objectProperty(object, name) {
  if (object?.type !== "ObjectExpression") return null;
  return (object.properties || []).find((row) => row.type === "ObjectProperty"
    && !row.computed && propertyName(row.key) === name)?.value || null;
}

function literalString(node) {
  return node?.type === "StringLiteral" ? node.value : null;
}

function resolveGeneratedImport(importer, specifier, files) {
  if (!specifier?.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [base, ...[".js", ".jsx", ".ts", ".tsx"].map((ext) => `${base}${ext}`),
    ...[".js", ".jsx", ".ts", ".tsx"].map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => files.has(candidate)) || null;
}

function staticSteps(expression, declarations, seen = new Set()) {
  if (!expression) return null;
  if (expression.type === "Identifier") {
    if (seen.has(expression.name)) return null;
    const next = declarations.get(expression.name);
    return next ? staticSteps(next, declarations, new Set([...seen, expression.name])) : null;
  }
  if (expression.type !== "ArrayExpression" || !(expression.elements || []).length) return null;
  const steps = [];
  for (const element of expression.elements || []) {
    const direct = literalString(element);
    const fromObject = literalString(objectProperty(element, "id"));
    const id = direct ?? fromObject;
    if (!id) return null;
    steps.push(id);
  }
  return [...new Set(steps)];
}

function normalizeControlName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function importedWizard(local, module, definitions) {
  const imported = module.imports.get(local);
  if (!imported) return null;
  return definitions.get(`${imported.file}:${imported.imported}`) || null;
}

function wizardFromExpression(expression, module, definitions) {
  if (!expression) return null;
  if (expression.type === "Identifier") {
    return module.localWizards.get(expression.name) || importedWizard(expression.name, module, definitions);
  }
  if (expression.type !== "CallExpression" && expression.type !== "OptionalCallExpression") return null;
  if (expression.callee?.type === "Identifier" && expression.callee.name === "useCapabilityState") {
    return wizardFromExpression(expression.arguments?.[0], module, definitions);
  }
  if (["MemberExpression", "OptionalMemberExpression"].includes(expression.callee?.type)
    && propertyName(expression.callee.property) === "getState") {
    return wizardFromExpression(expression.callee.object, module, definitions);
  }
  return null;
}

function wizardReferences(expression, aliases) {
  const found = new Set();
  walk(expression, (node, parent) => {
    if (node.type !== "Identifier") return;
    if (["MemberExpression", "OptionalMemberExpression"].includes(parent?.type)
      && parent.property === node && !parent.computed) return;
    const wizard = aliases.get(node.name);
    if (wizard) found.add(wizard);
  });
  return found;
}

function expressionMentionsWizardStep(expression, stateVariables) {
  let found = null;
  walk(expression, (node) => {
    if (!["MemberExpression", "OptionalMemberExpression"].includes(node.type)) return;
    if (node.object?.type !== "Identifier" || !stateVariables.has(node.object.name)) return;
    if (["stepId", "step", "currentStep", "current"].includes(propertyName(node.property))) {
      found = stateVariables.get(node.object.name);
    }
  });
  return found;
}

function flowStartBindings(module, wantedNames) {
  const bindings = new Set();
  walk(module.ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    const call = node.init;
    if (!["CallExpression", "OptionalCallExpression"].includes(call?.type)
      || call.callee?.type !== "Identifier"
      || !["useSemanticAction", "useFlowStart"].includes(call.callee.name)) return;
    const options = call.arguments?.[0];
    const names = [literalString(objectProperty(options, "name")), literalString(objectProperty(options, "label"))]
      .map(normalizeControlName).filter(Boolean);
    if (names.some((name) => wantedNames.has(name))) bindings.add(node.id.name);
  });
  return bindings;
}

function semanticBindings(module, wantedNames) {
  const bindings = new Set();
  walk(module.ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    const call = node.init;
    if (!["CallExpression", "OptionalCallExpression"].includes(call?.type)
      || call.callee?.type !== "Identifier"
      || !["useSemanticSelection", "useSemanticField", "useFlowAdvance", "useSemanticAction"]
        .includes(call.callee.name)) return;
    const options = call.arguments?.[0];
    const names = [literalString(objectProperty(options, "name")), literalString(objectProperty(options, "label"))]
      .map(normalizeControlName).filter(Boolean);
    if (names.some((name) => wantedNames.has(name))) bindings.add(node.id.name);
  });
  return bindings;
}

function jsxElementMatchesBinding(node, bindings, allowedProps) {
  if (node?.type !== "JSXElement") return false;
  return (node.openingElement?.attributes || []).some((attribute) => attribute.type === "JSXSpreadAttribute"
    && ["MemberExpression", "OptionalMemberExpression"].includes(attribute.argument?.type)
    && attribute.argument.object?.type === "Identifier"
    && bindings.has(attribute.argument.object.name)
    && allowedProps.has(propertyName(attribute.argument.property)));
}

function jsxElementMatchesFlowStart(node, bindings, wantedNames) {
  if (node?.type !== "JSXElement") return false;
  return (node.openingElement?.attributes || []).some((attribute) => {
    if (attribute.type === "JSXSpreadAttribute"
      && ["MemberExpression", "OptionalMemberExpression"].includes(attribute.argument?.type)
      && attribute.argument.object?.type === "Identifier"
      && bindings.has(attribute.argument.object.name)
      && ["buttonProps", "linkProps", "actionProps"].includes(propertyName(attribute.argument.property))) {
      return true;
    }
    if (attribute.type !== "JSXAttribute" || attribute.name?.name !== "aria-label") return false;
    const value = attribute.value?.type === "StringLiteral" ? attribute.value.value
      : literalString(attribute.value?.expression);
    return wantedNames.has(normalizeControlName(value));
  });
}

function nearestFunction(node, parents) {
  let current = node;
  while (current) {
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]
      .includes(current.type)) return current;
    current = parents.get(current);
  }
  return null;
}

function expressionMentionsMember(expression, objectName, memberName) {
  let found = false;
  walk(expression, (node) => {
    if (found || !["MemberExpression", "OptionalMemberExpression"].includes(node.type)) return;
    if (node.object?.type === "Identifier" && node.object.name === objectName
      && propertyName(node.property) === memberName) found = true;
  });
  return found;
}

function expressionMentionsProperty(expression, memberName) {
  let found = false;
  walk(expression, (node) => {
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)
      && propertyName(node.property) === memberName) found = true;
  });
  return found;
}

function expressionReferencesAlias(expression, aliases) {
  let found = false;
  walk(expression, (node, parent) => {
    if (node.type !== "Identifier" || !aliases.has(node.name)) return;
    if (["MemberExpression", "OptionalMemberExpression"].includes(parent?.type)
      && parent.property === node && !parent.computed) return;
    found = true;
  });
  return found;
}

function contractEntrySpecs(contract) {
  const flows = contract?.interactionContract?.flows || [];
  const specs = [];
  for (let index = 0; index < flows.length; index += 1) {
    const start = flows[index];
    if (start?.kind !== "flow_start"
      || !(start.writes || []).some((write) => String(write).split(".").at(-1) === "flowStarted")) continue;
    const startNames = new Set([start.control?.accessibleName, ...(start.control?.accessibleNames || [])]
      .map(normalizeControlName).filter(Boolean));
    if (!startNames.size) continue;
    const outcome = flows.slice(index + 1).find((flow) => flow?.journeyId === start.journeyId
      && flow.control
      && [flow.control.logicalField, flow.control.accessibleName, ...(flow.control.accessibleNames || [])]
        .some((name) => normalizeControlName(name)));
    if (!outcome) continue;
    const outcomeNames = new Set([outcome.control.logicalField, outcome.control.accessibleName,
      ...(outcome.control.accessibleNames || [])].map(normalizeControlName).filter(Boolean));
    if (outcomeNames.size) specs.push({ startNames, outcomeNames });
  }
  return specs;
}

function jsxContainsFlowStart(node, bindings, wantedNames) {
  let found = false;
  walk(node, (child) => {
    if (found || child.type !== "JSXOpeningElement") return;
    for (const attribute of child.attributes || []) {
      if (attribute.type === "JSXSpreadAttribute"
        && ["MemberExpression", "OptionalMemberExpression"].includes(attribute.argument?.type)
        && attribute.argument.object?.type === "Identifier"
        && bindings.has(attribute.argument.object.name)
        && ["buttonProps", "linkProps", "actionProps"].includes(propertyName(attribute.argument.property))) {
        found = true;
        return;
      }
      if (attribute.type === "JSXAttribute" && attribute.name?.name === "aria-label") {
        const value = attribute.value?.type === "StringLiteral" ? attribute.value.value
          : literalString(attribute.value?.expression);
        if (wantedNames.has(normalizeControlName(value))) {
          found = true;
          return;
        }
      }
    }
  });
  return found;
}

function guardedBranches(module, bindings, wantedNames) {
  const guards = [];
  walk(module.ast, (node) => {
    if (node.type === "LogicalExpression" && node.operator === "&&") {
      if (jsxContainsFlowStart(node.right, bindings, wantedNames)) guards.push(node.left);
      else if (jsxContainsFlowStart(node.left, bindings, wantedNames)) guards.push(node.right);
    } else if (node.type === "ConditionalExpression" && jsxContainsFlowStart(node.consequent, bindings, wantedNames)) {
      guards.push(node.test);
    }
  });
  return guards;
}

function wizardForStepExpression(expression, aliases, stateVariables) {
  if (expression?.type === "Identifier") return aliases.get(expression.name) || null;
  if (["MemberExpression", "OptionalMemberExpression"].includes(expression?.type)
    && expression.object?.type === "Identifier"
    && ["stepId", "step", "currentStep", "current"].includes(propertyName(expression.property))) {
    return stateVariables.get(expression.object.name) || null;
  }
  return null;
}

function impossibleStepEqualities(expression, declarations, aliases, stateVariables, seen = new Set()) {
  const matches = [];
  if (!expression || seen.has(expression)) return matches;
  seen.add(expression);
  if (expression.type === "Identifier" && declarations.has(expression.name)) {
    return impossibleStepEqualities(declarations.get(expression.name), declarations, aliases, stateVariables, seen);
  }
  if (expression.type === "BinaryExpression" && ["===", "=="].includes(expression.operator)) {
    const pairs = [[expression.left, expression.right], [expression.right, expression.left]];
    for (const [candidate, literal] of pairs) {
      const id = literalString(literal);
      if (id === null) continue;
      const wizard = wizardForStepExpression(candidate, aliases, stateVariables);
      if (wizard && !wizard.steps.includes(id)) matches.push({ literal, wizard, impossible: id });
    }
  }
  for (const [key, value] of Object.entries(expression)) {
    if (AST_KEYS_TO_SKIP.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) matches.push(...impossibleStepEqualities(child, declarations, aliases, stateVariables, seen));
    } else if (value && typeof value === "object") {
      matches.push(...impossibleStepEqualities(value, declarations, aliases, stateVariables, seen));
    }
  }
  return matches;
}

function replacementLiteral(source, node, value) {
  const current = source.slice(node.start, node.end);
  if (current.startsWith("'")) return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (current.startsWith("`")) return `\`${String(value).replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
  return JSON.stringify(value);
}

function flowEntryLatchEdits(module, specs) {
  const edits = [];
  const declarationNodes = new Map();
  walk(module.ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      declarationNodes.set(node.id.name, node);
    }
  });

  for (const spec of specs) {
    const startBindings = flowStartBindings(module, spec.startNames);
    const outcomeBindings = semanticBindings(module, spec.outcomeNames);
    if (!startBindings.size || !outcomeBindings.size) continue;

    const startElements = [];
    const outcomeElements = [];
    walk(module.ast, (node) => {
      if (node.type !== "JSXElement") return;
      if (jsxElementMatchesFlowStart(node, startBindings, spec.startNames)) startElements.push(node);
      if (jsxElementMatchesBinding(node, outcomeBindings,
        new Set(["groupProps", "inputProps", "selectProps", "fieldProps", "controlProps"]))) {
        outcomeElements.push(node);
      }
    });
    if (startElements.length !== 1 || outcomeElements.length !== 1) continue;

    const component = nearestFunction(startElements[0], module.parents);
    if (!component || nearestFunction(outcomeElements[0], module.parents) !== component) continue;
    if ([...startBindings, ...outcomeBindings].some((binding) => {
      const declaration = declarationNodes.get(binding);
      return !declaration || nearestFunction(declaration, module.parents) !== component;
    })) continue;

    const stateVariables = new Set();
    for (const [name, declaration] of declarationNodes) {
      if (nearestFunction(declaration, module.parents) !== component) continue;
      const call = declaration.init;
      if (["CallExpression", "OptionalCallExpression"].includes(call?.type)
        && call.callee?.type === "Identifier" && call.callee.name === "useCapabilityState") {
        stateVariables.add(name);
      }
    }
    if (stateVariables.size !== 1) continue;
    const stateName = [...stateVariables][0];

    const valueAliases = [];
    for (const [name, declaration] of declarationNodes) {
      if (nearestFunction(declaration, module.parents) === component
        && expressionMentionsMember(declaration.init, stateName, "values")) valueAliases.push(name);
    }
    if (valueAliases.length !== 1) continue;
    const valuesName = valueAliases[0];

    const stepAliases = new Set();
    let aliasesChanged = true;
    while (aliasesChanged) {
      aliasesChanged = false;
      for (const [name, declaration] of declarationNodes) {
        if (stepAliases.has(name) || nearestFunction(declaration, module.parents) !== component) continue;
        const direct = ["stepId", "step", "currentStep", "current"]
          .some((member) => expressionMentionsMember(declaration.init, stateName, member));
        if (direct || expressionReferencesAlias(declaration.init, stepAliases)) {
          stepAliases.add(name);
          aliasesChanged = true;
        }
      }
    }
    if (!stepAliases.size) continue;

    let startGuard = null;
    let cursor = startElements[0];
    while ((cursor = module.parents.get(cursor))) {
      if (cursor === component) break;
      if (cursor.type === "LogicalExpression" && cursor.operator === "&&"
        && cursor.right && cursor.right.start <= startElements[0].start
        && cursor.right.end >= startElements[0].end) {
        startGuard = cursor.left;
        break;
      }
      if (cursor.type === "ConditionalExpression" && cursor.consequent
        && cursor.consequent.start <= startElements[0].start
        && cursor.consequent.end >= startElements[0].end) {
        startGuard = cursor.test;
        break;
      }
    }

    let outcomeGuard = null;
    cursor = outcomeElements[0];
    while ((cursor = module.parents.get(cursor))) {
      if (cursor === component) break;
      if (cursor.type === "LogicalExpression" && cursor.operator === "&&"
        && cursor.right && cursor.right.start <= outcomeElements[0].start
        && cursor.right.end >= outcomeElements[0].end
        && expressionReferencesAlias(cursor.left, stepAliases)) {
        outcomeGuard = cursor.left;
        break;
      }
      if (cursor.type === "ConditionalExpression" && cursor.consequent
        && cursor.consequent.start <= outcomeElements[0].start
        && cursor.consequent.end >= outcomeElements[0].end
        && expressionReferencesAlias(cursor.test, stepAliases)) {
        outcomeGuard = cursor.test;
        break;
      }
    }
    if (!outcomeGuard) continue;

    const pending = [];
    if (!startGuard || !expressionMentionsProperty(startGuard, "flowStarted")) {
      if (startGuard) {
        const original = module.source.slice(startGuard.start, startGuard.end);
        pending.push({ start: startGuard.start, end: startGuard.end,
          replacement: `!${valuesName}.flowStarted && (${original})` });
      } else {
        const parent = module.parents.get(startElements[0]);
        if (!["JSXElement", "JSXFragment"].includes(parent?.type)) continue;
        const original = module.source.slice(startElements[0].start, startElements[0].end);
        pending.push({ start: startElements[0].start, end: startElements[0].end,
          replacement: `{!${valuesName}.flowStarted && (${original})}` });
      }
    }
    if (!expressionMentionsProperty(outcomeGuard, "flowStarted")) {
      const original = module.source.slice(outcomeGuard.start, outcomeGuard.end);
      pending.push({ start: outcomeGuard.start, end: outcomeGuard.end,
        replacement: `${valuesName}.flowStarted && (${original})` });
    }
    if (!pending.length) continue;
    if (pending.some((candidate, index) => pending.some((other, otherIndex) => index !== otherIndex
      && candidate.start < other.end && other.start < candidate.end))) continue;
    const startControl = [...spec.startNames].sort()[0];
    const change = {
      code: "wizard_flow_entry_latched",
      file: module.file,
      startControl,
      message: `${module.file}: causally latched ${JSON.stringify(startControl)} to its first semantic outcome`,
    };
    for (const pendingEdit of pending) {
      edits.push({ ...pendingEdit, change });
    }
  }

  const unique = [];
  for (const edit of edits) {
    if (!unique.some((row) => row.start === edit.start && row.end === edit.end
      && row.replacement === edit.replacement)) unique.push(edit);
  }
  return unique;
}

/**
 * Return a byte-stable corrected tree plus auditable changes. `changes=[]` means the proof was
 * incomplete or there was no defect; no source is changed in either case.
 */
export function transformWizardEntryState(tree, { contract = null } = {}) {
  const wantedNames = new Set((contract?.interactionContract?.flows || [])
    .filter((flow) => flow.kind === "flow_start")
    .flatMap((flow) => [flow.control?.accessibleName, ...(flow.control?.accessibleNames || [])])
    .map(normalizeControlName).filter(Boolean));
  if (!wantedNames.size) return { tree, changes: [] };
  const entrySpecs = contractEntrySpecs(contract);

  const files = new Set(Object.keys(tree || {}));
  const modules = new Map();
  for (const [file, raw] of Object.entries(tree || {})) {
    if (!GENERATED_FILE.test(file) || PLATFORM_PATH.test(file)) continue;
    try {
      const ast = parseModule(file, raw);
      const parents = new Map();
      const declarations = new Map();
      const exportedLocals = new Map();
      const imports = new Map();
      walk(ast, (node, parent) => {
        if (parent) parents.set(node, parent);
        if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
          declarations.set(node.id.name, node.init);
          if (parent?.type === "VariableDeclaration" && parent.__exported) exportedLocals.set(node.id.name, node.id.name);
        } else if (node.type === "ImportDeclaration") {
          const resolved = resolveGeneratedImport(file, node.source?.value, files);
          if (!resolved) return;
          for (const specifier of node.specifiers || []) {
            if (specifier.type === "ImportSpecifier") imports.set(specifier.local.name, {
              file: resolved, imported: propertyName(specifier.imported),
            });
          }
        } else if (node.type === "ExportNamedDeclaration") {
          if (node.declaration) node.declaration.__exported = true;
          for (const specifier of node.specifiers || []) {
            exportedLocals.set(propertyName(specifier.local), propertyName(specifier.exported));
          }
        }
      });
      // ExportNamedDeclaration is visited before its child declaration, so the marker above is
      // available when the declarator is reached. Direct exported functions are irrelevant here.
      modules.set(file, { file, source: String(raw), ast, parents, declarations, exportedLocals, imports,
        localWizards: new Map() });
    } catch {
      // Syntax failures are handled by the existing stage gate. Never transform an unparsed file.
    }
  }

  const definitions = new Map();
  for (const module of modules.values()) {
    for (const [local, initializer] of module.declarations) {
      if (!["CallExpression", "OptionalCallExpression"].includes(initializer?.type)
        || initializer.callee?.type !== "Identifier" || initializer.callee.name !== "makeWizardMachine") continue;
      const options = initializer.arguments?.[0];
      const steps = staticSteps(objectProperty(options, "steps"), module.declarations);
      if (!steps?.length) continue;
      const definition = { file: module.file, local, steps, firstStep: steps[0] };
      module.localWizards.set(local, definition);
      const exported = module.exportedLocals.get(local);
      if (exported) definitions.set(`${module.file}:${exported}`, definition);
    }
  }

  const editsByFile = new Map();
  for (const module of modules.values()) {
    const stateVariables = new Map();
    for (const [name, expression] of module.declarations) {
      const wizard = wizardFromExpression(expression, module, definitions);
      if (wizard) stateVariables.set(name, wizard);
    }
    // Only canonical step members (and aliases derived from them) are step aliases. Treating every
    // property read from the wizard snapshot as a step alias would make values.mode or values.view
    // look eligible for a rewrite, which is not a provable machine-state relationship.
    const aliases = new Map();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, expression] of module.declarations) {
        if (aliases.has(name)) continue;
        const direct = expressionMentionsWizardStep(expression, stateVariables);
        const referenced = wizardReferences(expression, aliases);
        if (direct) referenced.add(direct);
        if (referenced.size === 1) {
          aliases.set(name, [...referenced][0]);
          changed = true;
        }
      }
    }

    const bindings = flowStartBindings(module, wantedNames);
    for (const guard of guardedBranches(module, bindings, wantedNames)) {
      const matches = impossibleStepEqualities(guard, module.declarations, aliases, stateVariables);
      // One control guarded by multiple impossible states is not a safe one-token correction.
      if (matches.length !== 1) continue;
      const match = matches[0];
      const edits = editsByFile.get(module.file) || [];
      if (!edits.some((edit) => edit.start === match.literal.start && edit.end === match.literal.end)) {
        edits.push({ start: match.literal.start, end: match.literal.end,
          replacement: replacementLiteral(module.source, match.literal, match.wizard.firstStep),
          change: { code: "wizard_entry_state_aligned", file: module.file, wizardFile: match.wizard.file,
            from: match.impossible, to: match.wizard.firstStep,
            message: `${module.file}: aligned contracted flow-start guard ${JSON.stringify(match.impossible)} to `
              + `the wizard's declared entry step ${JSON.stringify(match.wizard.firstStep)}` } });
        editsByFile.set(module.file, edits);
      }
    }
    const latchEdits = flowEntryLatchEdits(module, entrySpecs);
    if (latchEdits.length) {
      const edits = editsByFile.get(module.file) || [];
      edits.push(...latchEdits);
      editsByFile.set(module.file, edits);
    }
  }

  if (!editsByFile.size) return { tree, changes: [] };
  const next = { ...tree };
  const changes = [];
  for (const [file, edits] of [...editsByFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let source = String(next[file]);
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
      if (!changes.some((change) => change.code === edit.change.code && change.file === edit.change.file
        && change.startControl === edit.change.startControl && change.from === edit.change.from
        && change.to === edit.change.to)) changes.push(edit.change);
    }
    try { parseModule(file, source); } catch { return { tree, changes: [] }; }
    next[file] = source;
  }
  return { tree: next, changes };
}

export function wizardEntryTransformSummary({ changes = [] } = {}) {
  return changes.map((change) => change.code === "wizard_entry_state_aligned"
    ? `${change.file} ${change.from} -> ${change.to}`
    : `${change.file} flow entry latched`).join("; ");
}
