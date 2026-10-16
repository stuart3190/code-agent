import test from 'node:test';
import assert from 'node:assert/strict';
import {lintPlatformAbi} from '../../shell/server/lib/builderV2/platformModules/abiLint.mjs';
const findings=(source,routed=true)=>lintPlatformAbi({'src/screens/Screen.jsx':source,...(routed?{'src/lib/app/routing.js':'// composed'}:{})}).findings.filter(f=>f.code==='platform_link_path');
test('platform Link paths retain actionable source diagnosis including aliases',()=>{
 const result=findings('import { Link as Go } from "../lib/app/index.js"; export default () => <Go to="/about">About</Go>;');
 assert.equal(result.length,1);assert.equal(result[0].target,'/about');assert.match(result[0].message,/declared route ID/);
});
test('route IDs, dynamic props and external routers are not condemned',()=>{
 for(const src of ['import {Link} from "../lib/app/index.js"; const A=()=> <Link to="about"/>;', 'import {Link} from "../lib/app/index.js"; const A=({route})=> <Link to={route}/>;', 'import {Link} from "react-router-dom"; const A=()=> <Link to="/about"/>;']) assert.equal(findings(src).length,0);
});
test('shadowed bindings and legacy routing are not condemned',()=>{
 assert.equal(findings('import {Link} from "../lib/app/index.js"; const A=({Link})=> <Link to="/about"/>;').length,0);
 assert.equal(findings('import {Link} from "../lib/app/index.js"; const A=()=> <Link to="/about"/>;',false).length,0);
});
