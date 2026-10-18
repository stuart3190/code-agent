import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const IDENTITY_COLUMNS = Object.freeze({ca_run_events:'id',build_work_events:'seq',data_erasure_events:'seq'});
export function isolatedDatabaseEnvironment(databaseUrl) {
  const u=new URL(databaseUrl);
  if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','[::1]'].includes(u.hostname)||u.search||u.hash)
    throw new Error('native restore requires an explicit loopback PostgreSQL target without URL options');
  if(!u.username||!u.pathname.slice(1))throw new Error('native restore database identity missing');
  return {PATH:process.env.PATH,PGHOST:u.hostname.replace(/^\[|\]$/g,''),PGPORT:u.port||'5432',
    PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),
    PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGCONNECT_TIMEOUT:'10'};
}
export function identityRestoreSql(table, rows) {
  const key=IDENTITY_COLUMNS[table];if(!key)throw new Error('native restore table is not an identity allowlist member');
  const body=JSON.stringify(rows);let delimiter;
  do{delimiter=`$restore_${randomBytes(12).toString('hex')}$`;}while(body.includes(delimiter));
  // The table/type/sequence identifiers come only from the fixed allowlist. JSON is data in a
  // collision-checked dollar-quoted literal, never interpolated SQL syntax or a psql variable.
  return `BEGIN;\nINSERT INTO public."${table}" OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::public."${table}", ${delimiter}${body}${delimiter}::json);\nSELECT setval(pg_get_serial_sequence('public.${table}','${key}'), GREATEST(COALESCE((SELECT max("${key}") FROM public."${table}"),1),1), true);\nCOMMIT;\n`;
}
export async function restoreIdentityRows(table, rows, databaseUrl) {
  if(!rows.length)return;
  const env=isolatedDatabaseEnvironment(databaseUrl);
  const sql=identityRestoreSql(table,rows);
  await new Promise((resolve,reject)=>{
    const child=spawn('psql',['--no-psqlrc','--quiet','--set','ON_ERROR_STOP=1'],{env,stdio:['pipe','ignore','pipe']});
    let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000);});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`native identity restore ${table} failed: ${error.split('\n')[0].slice(0,300)}`)));
    child.stdin.on('error',reject);child.stdin.end(sql);
  });
}
