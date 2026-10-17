import { parse } from '@babel/parser';

// Diagnose the observed form-submit trap, not arbitrary empty callbacks. A semantic action
// supplies type=button even inside a form. An empty callback does not submit that form.
export function lintSemanticFormActions(source, file) {
  let ast;
  try { ast = parse(source, { sourceType: 'module', plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] }); }
  catch { return []; }
  const nodes = [], ancestors = new Map();
  function visit(node, parents = []) {
    if (!node || typeof node.type !== 'string') return;
    nodes.push(node); ancestors.set(node, parents);
    for (const [key, value] of Object.entries(node)) {
      if (['loc','comments','tokens','extra'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, [...parents,node]));
      else if (value && typeof value === 'object') visit(value, [...parents,node]);
    }
  }
  visit(ast);
  const hooks = new Set(ast.program.body.filter(n => n.type === 'ImportDeclaration'
    && /\/lib\/capabilities(?:\/composed\/interaction-primitives(?:\.js)?)?$/.test(n.source.value))
    .flatMap(n => n.specifiers.filter(s => s.imported?.name === 'useSemanticAction').map(s => s.local.name)));
  // Abstain if an imported hook or action binding is shadowed anywhere in the source.
  const names = new Map();
  function bind(n) { if (!n) return; if (n.type === 'Identifier') names.set(n.name,(names.get(n.name)||0)+1);
    else if (n.type === 'AssignmentPattern') bind(n.left); else if (n.type === 'RestElement') bind(n.argument);
    else if (n.type === 'ObjectPattern') n.properties.forEach(p=>bind(p.value||p.argument));
    else if (n.type === 'ArrayPattern') n.elements.forEach(bind); }
  for (const n of nodes) {
    if (/Function|Method/.test(n.type)) (n.params||[]).forEach(bind);
    if (['VariableDeclarator','FunctionDeclaration','ClassDeclaration'].includes(n.type)) bind(n.id);
    if (n.type === 'CatchClause') bind(n.param);
  }
  const actions = new Set();
  for (const n of nodes) {
    if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier' || names.get(n.id.name)!==1
      || !hooks.has(n.init?.callee?.name) || names.has(n.init.callee.name)) continue;
    const config = n.init.arguments?.[0];
    if (config?.type !== 'ObjectExpression' || config.properties.some(p=>p.type==='SpreadElement'||p.computed)) continue;
    const handlers = config.properties.filter(p=>(p.key?.name||p.key?.value)==='onActivate');
    if (handlers.length!==1) continue;
    const handler = handlers[0].value || handlers[0];
    if (!['ArrowFunctionExpression','FunctionExpression','ObjectMethod'].includes(handler.type)
      || handler.body?.type !== 'BlockStatement' || handler.body.body.length) continue;
    actions.add(n.id.name);
  }
  const findings=[];
  // Direct DOM listeners or reassignment can supply behavior outside JSX. Abstain.
  if (nodes.some(n => n.type === "MemberExpression" && !n.computed && n.property?.name === "addEventListener")) return findings;
  if (nodes.some(n => n.type === "AssignmentExpression" && n.left?.type === "MemberExpression"
    && (actions.has(n.left.object?.name) || actions.has(n.left.object?.object?.name)))) return findings;
  for (const n of nodes) {
    if(n.type!=='JSXOpeningElement'||n.name?.name!=='button')continue;
    const parents=ancestors.get(n)||[];
    const form=[...parents].reverse().find(p=>p.type==='JSXElement'&&p.openingElement.name?.name==='form');
    if(!form?.openingElement.attributes.some(a=>a.name?.name==='onSubmit'))continue;
    if(parents.some(p=>p.type==='JSXElement'&&/^[A-Z]/.test(p.openingElement.name?.name || '')))continue;
    if(parents.some(p=>p.type==='JSXElement'&&p.openingElement.attributes.some(a=>['onClick','onClickCapture'].includes(a.name?.name))))continue;
    const attrs=n.attributes;
    const spreads=attrs.filter(a=>a.type==='JSXSpreadAttribute');
    if(spreads.length!==1)continue;
    const arg=spreads[0].argument;
    if(arg?.type!=='MemberExpression'||arg.computed||arg.property?.name!=='buttonProps'||!actions.has(arg.object?.name))continue;
    // Explicit type/handler/form overrides and disabled controls may intentionally delegate.
    if(attrs.some(a=>['type','onClick','onClickCapture','form'].includes(a.name?.name)))continue;
    if(attrs.some(a=>a.name?.name==='disabled' && (!a.value || a.value.expression?.value===true)))continue;
    findings.push({code:'semantic_form_action_noop',module:file,line:n.loc.start.line,
      message:`${file}:${n.loc.start.line}: ${arg.object.name}.buttonProps supplies type="button" with an empty onActivate handler inside a form. Bind a real onActivate, or put type="submit" AFTER the spread to invoke the form's onSubmit. Preserve the semantic action identity.`});
  }
  return findings;
}
