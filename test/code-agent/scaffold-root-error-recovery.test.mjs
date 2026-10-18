import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {renderScaffoldFoundation} from '../../shell/server/lib/builderV2/scaffoldComposer.mjs';
const deps=fileURLToPath(new URL('../../harness/.deps/',import.meta.url));
const {build}=createRequire(path.join(deps,'package.json'))('esbuild');
for(const fault of ['route-hook','layout','screen'])test(`root render failure is recoverable: ${fault}`,{timeout:30000},async()=>{
 const graph={screens:[{screenId:'home',module:'src/screens/Home.jsx',routePath:'/'}]};
 const foundation=renderScaffoldFoundation(graph,{routePlan:{routes:[{id:'home',path:'/',screen:'src/screens/Home.jsx'}]}});
 const fail=`if(window.__fail)throw new Error('private backend detail');`;
 const tree={...foundation.protectedFiles,...foundation.screenFiles,
  'src/lib/app/routing.js':`export function useRoute(){${fault==='route-hook'?fail:''}return {state:'ready',route:{id:'home',path:'/'},params:{}}}`,
  'src/layout/AppLayout.jsx':`import React from 'react';export default function Layout({children}){${fault==='layout'?fail:''}return <div>{children}</div>}`,
  'src/screens/Home.jsx':`import React from 'react';export default function Screen(){${fault==='screen'?fail:''}return <h1>Your workspace</h1>}`,
  'entry.jsx':`import React from 'react';import{createRoot}from'react-dom/client';import App from './src/App.jsx';window.__fail=true;createRoot(document.getElementById('root')).render(<App/>);`,
 };
 const bundled=await build({entryPoints:['/entry.jsx'],bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture',setup(b){
  b.onResolve({filter:/^(?:\.|\/)/},args=>args.kind !== 'entry-point' && args.namespace !== 'fixture' ? undefined : ({path:path.posix.normalize(path.posix.join(path.posix.dirname(args.importer||'/entry.jsx'),args.path)).replace(/^\//,''),namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:tree[args.path],loader:args.path.endsWith('.jsx')?'jsx':'js',resolveDir:deps}));
 }}]});
 const server=http.createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundled.outputFiles[0].text:'<div id="root"></div><script src="/app.js"></script>')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('alert').waitFor({timeout:3000});assert.doesNotMatch(await page.locator('body').innerText(),/private backend detail/);
  if(fault==='route-hook'){await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('alert').waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/private backend detail/);}
  await page.evaluate(()=>{window.__fail=false});await page.getByRole('button',{name:'Try again',exact:true}).click({timeout:3000});await page.getByRole('heading',{name:'Your workspace'}).waitFor({timeout:3000});
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
