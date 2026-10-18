import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createRequire}from'node:module';import vm from'node:vm';
const localRequire=createRequire(new URL('../../editor/vscode/extension.js',import.meta.url));
const source=readFileSync(new URL('../../editor/vscode/extension.js',import.meta.url),'utf8');
function extension(configuration){const module={exports:{}};const vscode={workspace:{getConfiguration:()=>configuration}};vm.runInNewContext(source+'\nmodule.exports.probe={serverUrl,restoreConnection,getClient:()=>client,setTree:()=>{treeProvider={refresh(){}}}};', {module,require:name=>name==='vscode'?vscode:localRequire(name),console,URL});return module.exports.probe}
for(const explicit of [true,false])test(`workspace cannot redirect the configured API authority, global override=${explicit}`,()=>{
 const probe=extension({get:()=> 'https://untrusted.example',inspect:()=>({defaultValue:'https://app.thrallo.com',globalValue:explicit?'https://app.thrallo.com':undefined,workspaceValue:'https://untrusted.example'})});assert.equal(probe.serverUrl(),'https://app.thrallo.com');
});
test('a legacy unbound API token is never restored to a custom origin',async()=>{
 const probe=extension({get:()=> 'https://other.example',inspect:()=>({globalValue:'https://other.example'})});probe.setTree();await probe.restoreConnection({secrets:{get:async key=>key==='thrallo.apiToken'?'synthetic-token':undefined}});assert.equal(probe.getClient(),null);
});
const {ThralloClient}=localRequire('./lib/api.js');
for(const serverUrl of ['http://remote.example','https://user:password@remote.example','https://remote.example/?token=secret','https://remote.example/#fragment'])test(`client rejects unsafe server shape ${serverUrl}`,()=>assert.throws(()=>new ThralloClient({serverUrl,token:'synthetic-token'})));

const {normaliseServerOrigin,readTokenForOrigin,storeTokenForOrigin,deleteTokenForOrigin,connectionStateKey}=localRequire('./lib/connectionSecurity.js');
test('user-selected HTTPS origins and loopback development origins remain supported',()=>{
 for(const value of ['https://custom.example/','http://localhost:5173','http://127.0.0.1:8787','http://[::1]:8787'])assert.equal(normaliseServerOrigin(value),value.replace(/\/$/,''));
});
test('tokens are isolated by canonical origin and disconnect removes only the chosen connection',async()=>{
 const values=new Map([['thrallo.apiToken','legacy-default']]);const secrets={get:async k=>values.get(k),store:async(k,v)=>values.set(k,v),delete:async k=>values.delete(k)};
 assert.equal(await readTokenForOrigin(secrets,'https://app.thrallo.com'),'legacy-default');assert.equal(await readTokenForOrigin(secrets,'https://custom.example'),undefined);
 await storeTokenForOrigin(secrets,'https://app.thrallo.com/','new-default');await storeTokenForOrigin(secrets,'https://custom.example','custom-token');
 assert.equal(await readTokenForOrigin(secrets,'https://app.thrallo.com'),'new-default');assert.equal(await readTokenForOrigin(secrets,'https://custom.example'),'custom-token');
 await deleteTokenForOrigin(secrets,'https://app.thrallo.com');assert.equal(await readTokenForOrigin(secrets,'https://app.thrallo.com'),undefined);assert.equal(await readTokenForOrigin(secrets,'https://custom.example'),'custom-token');
});
test('conversation state changes on token rotation or origin changes without retaining plaintext token in its key',()=>{
 const a=connectionStateKey('https://app.thrallo.com','synthetic-secret');assert.doesNotMatch(a,/synthetic-secret/);assert.notEqual(a,connectionStateKey('https://app.thrallo.com','new-secret'));assert.notEqual(a,connectionStateKey('https://other.example','synthetic-secret'));
});
test('workspace configuration cannot declare the API origin setting',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../../editor/vscode/package.json',import.meta.url),'utf8'));assert.equal(manifest.contributes.configuration.properties['thrallo.serverUrl'].scope,'machine');
});
