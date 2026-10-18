// Provenance-based diagnostics for typed repository reads. Unknown data flow stays unknown;
// this is advisory, not a substitute for exercising persistence and visible results in a browser.
import { parse } from '@babel/parser';
const META = new Set(['id', 'version', 'createdAt', 'updatedAt', 'values']);
const member = n => n && ['MemberExpression', 'OptionalMemberExpression'].includes(n.type);
const property = n => n.computed ? (n.property?.type === 'StringLiteral' ? n.property.value : null) : n.property?.name;
const childNodes = node => Object.entries(node).filter(([k]) => !['loc','comments','tokens','extra','errors'].includes(k))
  .flatMap(([,v]) => Array.isArray(v) ? v : [v]).filter(v => v && typeof v.type === 'string');

export function lintTypedRecordAccess(source, file) {
  let ast;
  try { ast = parse(source, {sourceType:'module', plugins:['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])]}); }
  catch { return []; } // The compiler owns syntax errors.
  const scopes = new WeakMap(), nodes = [], parents = new WeakMap();
  const root = {parent:null, bindings:new Map()};
  function visit(node, scope, parent) {
    if (node.type==='FunctionDeclaration' && node.id) scope.bindings.set(node.id.name,{});
    if (/Function/.test(node.type) || node.type === 'BlockStatement') scope = {parent:scope, bindings:new Map()};
    scopes.set(node,scope); parents.set(node,parent); nodes.push(node);
    if (/Function/.test(node.type)) for (const p of node.params || []) if(p.type==='Identifier') scope.bindings.set(p.name,{param:p,fn:node});
    if(node.type==='VariableDeclarator' && node.id.type==='Identifier') scope.bindings.set(node.id.name,{init:node.init});
    if(node.type==='ImportDeclaration') for(const s of node.specifiers) scope.bindings.set(s.local.name,{imported:s.imported?.name,from:node.source.value});
    for(const child of childNodes(node)) visit(child,scope,node);
  }
  visit(ast,root,null);
  function binding(node) { for(let s=scopes.get(node);s;s=s.parent) if(s.bindings.has(node.name)) return s.bindings.get(node.name); return null; }
  // Mutation invalidates inference instead of accidentally attributing a later unrelated value.
  for(const n of nodes) if((n.type==='AssignmentExpression' && n.left.type==='Identifier') || (n.type==='UpdateExpression' && n.argument.type==='Identifier')) {
    const b=binding(n.left || n.argument); if(b)b.mutated=true;
  }
  function kind(node, seen = new Set()) {
    if(!node || seen.has(node)) return null;
    seen=new Set(seen);seen.add(node);
    if(node.type==='AwaitExpression' || node.type==='TSAsExpression' || node.type==='TSNonNullExpression') return kind(node.argument || node.expression,seen);
    if(node.type==='Identifier') {
      const b=binding(node);if(!b || b.mutated)return null;
      if(b.imported==='repository' && /(?:^|\/)lib\/(?:app(?:\/index(?:\.js)?)?|app\/entities(?:\.js)?|capabilities\/composed\/entities(?:\.js)?)$/.test(b.from))return 'factory';
      if(b.imported==='useMemo' && b.from==='react')return 'memo';
      if(b.param) {
        const call=parents.get(b.fn);if(call?.type==='CallExpression' && member(call.callee)
          && ['map','filter','find','some','every'].includes(property(call.callee)) && call.arguments[0]===b.fn
          && b.fn.params[0]===b.param && kind(call.callee.object,seen)==='list')return 'record';
        return null;
      }
      return kind(b.init,seen);
    }
    if(member(node)) {
      const obj=kind(node.object,seen), key=property(node);
      if(obj==='record') return key==='values' ? 'values' : key && !META.has(key) ? 'absent' : null;
      if(obj==='list' && node.computed && node.property.type==='NumericLiteral')return 'record';
    }
    if(node.type==='LogicalExpression' && ['||','??'].includes(node.operator) && kind(node.left,seen)==='absent')return kind(node.right,seen);
    if(node.type==='CallExpression') {
      const callee=kind(node.callee,seen);
      if(callee==='factory')return 'repository';
      if(callee==='memo' && node.arguments[0]?.type==='ArrowFunctionExpression')return kind(node.arguments[0].body,seen);
      if(member(node.callee)) {
        const obj=kind(node.callee.object,seen), method=property(node.callee);
        if(obj==='repository')return method==='list' ? 'list' : ['get','create','update'].includes(method) ? 'record' : null;
        if(obj==='list')return method==='filter' ? 'list' : method==='find' ? 'record' : null;
      }
    }
    return null;
  }
  return nodes.filter(n=>member(n) && kind(n.object)==='record' && property(n) && !META.has(property(n)))
    .map(n=>({code:'typed_record_field_access',file,module:file,line:n.loc.start.line,
      span:{start:n.start,end:n.end},message:`${file}:${n.loc.start.line} reads ${source.slice(n.start,n.end)} from a typed repository record. get/create/update return { id, version, createdAt, updatedAt, values }; list returns an array of these records. Domain fields belong under record.values.${property(n)}. Preserve metadata and use record.values for display, filtering and edit drafts; there is no data response envelope.`}));
}
