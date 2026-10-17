// Integrate an existing declared controller into an untouched generated screen slot.
// No layout or business logic is invented; custom screens and ambiguous ownership abstain.
import path from 'node:path';
import { parse } from '@babel/parser';
import { renderScaffoldFoundation } from './scaffoldComposer.mjs';

export function mountDeclaredControllers(tree, { modulePlan = [], scaffoldGraph = null } = {}) {
  if (!scaffoldGraph || !tree) return { tree, changes: [] };
  const baseline = renderScaffoldFoundation(scaffoldGraph).screenFiles;
  const next = { ...tree }, changes = [];
  for (const screen of modulePlan) {
    const controller = screen.journeyController;
    if (screen.providedBy !== 'scaffold_screen_slot' || !controller || controller === screen.path) continue;
    if (modulePlan.filter(row => row.path === screen.path).length !== 1) continue;
    if (modulePlan.filter(row => row.path === controller && row.sharedControllerFor === screen.scaffoldScreenId).length !== 1) continue;
    if (!Object.hasOwn(baseline, screen.path) || tree[screen.path] !== baseline[screen.path]) continue;
    const source = tree[controller];
    if (typeof source !== 'string') continue;
    try {
      const ast = parse(source, { sourceType:'module', plugins:['jsx','typescript'] });
      const declaration = ast.program.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration;
      if (!declaration || !['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(declaration.type)
        || declaration.async) continue;
    } catch { continue; }
    let relative = path.posix.relative(path.posix.dirname(screen.path), controller);
    if (!relative.startsWith('.')) relative = './' + relative;
    next[screen.path] = `// Deterministic mount of the contract's existing journey controller.\n`
      + `import JourneyController from ${JSON.stringify(relative)};\n`
      + `export default function MountedScreen() { return <JourneyController />; }\n`;
    changes.push({file:screen.path,controller,rewrite:'mount_declared_controller'});
  }
  return {tree:changes.length ? next : tree,changes};
}
