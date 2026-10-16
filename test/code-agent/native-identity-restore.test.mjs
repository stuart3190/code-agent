import test from 'node:test';import assert from 'node:assert/strict';
import {isolatedDatabaseEnvironment,identityRestoreSql} from '../../ops/lib/nativeIdentityRestore.mjs';
import {prepareRowsForRestore} from '../../ops/restore-thrallo.mjs';
test('native identity restore preserves non-contiguous original event IDs',()=>{
 const rows=[{seq:137},{seq:55724}];assert.deepEqual(prepareRowsForRestore('build_work_events',rows,[],{preserveIdentity:true}),rows);
 const sql=identityRestoreSql('build_work_events',rows);assert.match(sql,/OVERRIDING SYSTEM VALUE/);assert.match(sql,/setval/);assert.match(sql,/"seq":55724/);
 assert.throws(()=>identityRestoreSql('projects; DROP TABLE x',rows),/allowlist/);
});
test('native restore refuses remote targets and inherited connection options',()=>{
 for(const url of ['postgres://u:p@db.example/postgres','https://127.0.0.1/db','postgres://u:p@127.0.0.1/db?options=x'])assert.throws(()=>isolatedDatabaseEnvironment(url),/loopback/);
 const env=isolatedDatabaseEnvironment('postgres://u:p@127.0.0.1:55322/postgres');assert.equal(env.PGHOST,'127.0.0.1');assert.equal(env.PGPORT,'55322');assert.equal(env.PGSERVICE,undefined);
});
test('row SQL-shaped text stays inside a collision-checked JSON literal',()=>{
 const value="'); COMMIT; DROP TABLE projects; -- $restore_$";const sql=identityRestoreSql('ca_run_events',[{id:1,message:value}]);
 const delimiter=sql.match(/\$restore_[a-f0-9]+\$/)[0];assert.equal(sql.split(delimiter).length,3);assert.equal(JSON.parse(sql.split(delimiter)[1])[0].message,value);
});
