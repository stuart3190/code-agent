import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { depsNodeModules } from '../../harness/workspace.mjs';
export const fixtureDir = fileURLToPath(new URL('./fixtures/retained/downlight-20260922/', import.meta.url));
export const fixture = async (file) => JSON.parse(await fs.readFile(path.join(fixtureDir, file), 'utf8'));
export const initial = '16269e9f76c45533d9963e241b19360e2d0660113d3940b2217c7ea4ded6cb39';
export const repaired = ['02307b6dfe0e7afbead3430c5102a39e0fec361273ced8ed8e9e33a134c78bae', 'c0a8b5d319be9023b20f94f1f228d5e80fad5b64c7285c704a4da1569659775b', '4814b9b11786f78fae91f41d82d19fa9701652b9edd1e048082519ffbff5d999'];
export const treeFor = (hash) => fixture(`tree-${hash}.json`);

// Execute byte-identical retained source in an isolated screen harness. No generation pipeline,
// provider, database, project mutation or publication. CSS reproduces the text-transform involved
// in the failure; full visual layout is outside this functional regression.
export async function retainedScreen(hash) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const dir = await fs.mkdtemp(path.join(root, '.retained-screen-'));
  const tree = await treeFor(hash);
  for (const [name, text] of Object.entries(tree)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  await fs.writeFile(path.join(dir, 'probe.jsx'), 'import React from "react";import {createRoot} from "react-dom/client";import Screen from "./src/screens/scaffold/CalculatorScreen.jsx";createRoot(document.getElementById("root")).render(<Screen/>);');
  const requireDeps = createRequire(path.join(depsNodeModules(), 'package.json'));
  const { build } = requireDeps('esbuild');
  const bundled = await build({ nodePaths: [depsNodeModules()], entryPoints: [path.join(dir, 'probe.jsx')], bundle: true, write: false,
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/app.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/app.js' ? bundled.outputFiles[0].text
      : `<style>.uppercase{text-transform:uppercase}strong,dd{display:block}</style><div id="root"></div><script src="/app.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, async close() {
    await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true });
  } };
}
