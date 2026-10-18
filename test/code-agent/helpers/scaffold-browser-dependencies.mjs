import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import path from 'node:path';

// Backend source lives above harness/.deps, so normal resolution would accidentally
// test the platform's SDK instead of the dependency installed in generated apps.
export function scaffoldBrowserDependencies(deps) {
  return {
    name: 'generated-app-supabase',
    setup(build) {
      build.onResolve({ filter: /^@supabase\/supabase-js$/ }, args => {
        if (args.pluginData?.scaffoldSupabase) return;
        return build.resolve(args.path, {
          resolveDir: deps, kind: args.kind, pluginData: { scaffoldSupabase: true },
        });
      });
    },
  };
}

export function assertScaffoldSdkBundled(bundle, deps) {
  const expected = realpathSync(path.join(deps, 'node_modules/@supabase/supabase-js')) + path.sep;
  const inputs = Object.keys(bundle.metafile.inputs).map(p => path.resolve(p))
    .filter(p => p.includes('/node_modules/@supabase/supabase-js/'));
  assert.ok(inputs.length > 0, 'browser fixture must include the actual Supabase SDK');
  assert.ok(inputs.every(p => p.startsWith(expected)), 'browser fixture must use generated-app dependencies');
}
