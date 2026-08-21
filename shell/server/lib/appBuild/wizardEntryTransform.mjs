// Deterministic alignment for a generated flow-entry control whose visibility predicate names a
// wizard state that the same generated state machine can never produce.
//
// This is intentionally proof-driven. It does not guess from words such as "home" or "intro": it
// resolves the concrete makeWizardMachine used by useCapabilityState(), reads its static steps,
// finds the contracted flow-start control in JSX, and changes only the impossible equality that
// guards that control. Dynamic, cross-wizard or otherwise ambiguous shapes are left untouched for
// ordinary browser verification and targeted repair.

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

  const files = new Set(Object.keys(tree || {}));
  const modules = new Map();
  for (const [file, raw] of Object.entries(tree || {})) {
    if (!GENERATED_FILE.test(file) || PLATFORM_PATH.test(file)) continue;
    try {
      const ast = parseModule(file, raw);
      const declarations = new Map();
      const exportedLocals = new Map();
      const imports = new Map();
      walk(ast, (node, parent) => {
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
      modules.set(file, { file, source: String(raw), ast, declarations, exportedLocals, imports,
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
          from: match.impossible, to: match.wizard.firstStep, wizardFile: match.wizard.file });
        editsByFile.set(module.file, edits);
      }
    }
  }

  if (!editsByFile.size) return { tree, changes: [] };
  const next = { ...tree };
  const changes = [];
  for (const [file, edits] of [...editsByFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let source = String(next[file]);
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
      changes.push({ code: "wizard_entry_state_aligned", file, wizardFile: edit.wizardFile,
        from: edit.from, to: edit.to,
        message: `${file}: aligned contracted flow-start guard ${JSON.stringify(edit.from)} to `
          + `the wizard's declared entry step ${JSON.stringify(edit.to)}` });
    }
    try { parseModule(file, source); } catch { return { tree, changes: [] }; }
    next[file] = source;
  }
  return { tree: next, changes };
}

export function wizardEntryTransformSummary({ changes = [] } = {}) {
  return changes.map((change) => `${change.file} ${change.from} -> ${change.to}`).join("; ");
}
