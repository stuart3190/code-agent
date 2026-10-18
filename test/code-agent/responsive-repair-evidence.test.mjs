import test from 'node:test';import assert from 'node:assert/strict';
import {verificationDefects,defectProgress,defectWriteBoundary,defectEvidence} from '../../shell/server/lib/builderV2/verificationDefects.mjs';
import {SMOKE_VERIFIER_POLICY,VERIFICATION_RESULT_CLASS} from '../../shell/server/lib/appBuild/verifierPolicy.mjs';
const file='src/components/TaskBoard.jsx';
const tree={[file]:'<button data-thrallo-action="act_create">Create task</button><button data-thrallo-action="act_clear">Clear search</button>', 'src/extensions/custom/validate-title.js':'export const validate = () => true;', 'src/lib/app/index.js':'act_create'};
const finding=(controlId,control)=>({controlId,control,width:390,kind:'clipped_control',blocker:'non-scrollable horizontal clipping'});
const create=finding('act_create','Create task'),clear=finding('act_clear','Clear search');
const defects=findings=>verificationDefects({tree,contract:{journeys:[]},journeyResults:{verifierPolicy:SMOKE_VERIFIER_POLICY,journeys:['create','edit','search'].map(id=>({id,status:'fail',classification:VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,responsiveFindings:findings,owners:['src/extensions/custom/validate-title.js']}))}});
test('mobile findings remain layout defects, deduplicated across journeys and addressed to the rendered component',()=>{
 const result=defects([create,clear]);assert.equal(result.length,2);assert.ok(result.every(d=>d.code==='responsive_control_clipped'));
 assert.deepEqual(defectWriteBoundary(result).allowedFiles,[file]);assert.ok(result.every(d=>d.journeyId===null));
 const brief=defectEvidence(result).join('\n');assert.match(brief,/390px.*Create task/);assert.doesNotMatch(brief,/application crash/);
});
test('repairing one of two clipped controls is real progress, while an unchanged control stays unresolved',()=>{
 const progress=defectProgress(defects([create,clear]),defects([create]));
 assert.equal(progress.moved,true);assert.equal(progress.resolved.length,1);assert.equal(progress.persisted.length,1);assert.equal(progress.introduced.length,0);
 assert.equal(defectProgress(defects([create]),defects([create])).moved,false);
});
test('unmatched control falls back to declared owners without inventing a source address',()=>{
 const result=defects([finding('act_unknown','Unknown control')]);assert.deepEqual(result[0].modules,['src/extensions/custom/validate-title.js']);
});
test('trading one clipped control for a new clipped control is not progress',()=>{
 const progress=defectProgress(defects([create]),defects([clear]));assert.equal(progress.moved,false);assert.equal(progress.reason,'regressed');
});
