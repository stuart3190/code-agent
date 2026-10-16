import test from 'node:test';
import assert from 'node:assert/strict';
import {createBudgetLedger} from '../../shell/server/lib/appBuild/budgetLedger.mjs';
import {TOKENS_PER_CREDIT} from '../../src/cost.mjs';
const overviewResolver=async()=>({budgets:{managedTokens:{remaining:10*TOKENS_PER_CREDIT}}});
test('balance uses one owner-bound aggregate, preserving decimal credit protection',async()=>{
 const calls=[];const ledger=createBudgetLedger({store:{},overviewResolver,client:{rpc:async(name,args)=>{calls.push({name,args});return {data:[{topup:'167.5000',protected_credits:'2.3734'}]};}}});
 assert.deepEqual(await ledger.getBalance('owner-a'),{bundle:12.3734,included:12.3734,topup:167.5,purchased:167.5,total:179.8734,periodStart:new Date(0).toISOString(),usageRowCount:0,unlimited:false});
 assert.deepEqual(calls,[{name:'credit_balance_totals',args:{p_owner:'owner-a'}}]);
});
test('configured production fails closed for aggregate error or malformed totals',async()=>{
 const old=process.env.CODE_AGENT_STORE;process.env.CODE_AGENT_STORE='supabase';
 try{for(const response of [{error:new Error('database unavailable')},{data:[]},{data:[{topup:null,protected_credits:0}]},{data:[{topup:2,protected_credits:'NaN'}]}]){
 const ledger=createBudgetLedger({store:{},overviewResolver,client:{rpc:async()=>response}});
 await assert.rejects(ledger.getBalance('owner-a'),/database unavailable|Credit balance totals unavailable/);
 }}finally{if(old===undefined)delete process.env.CODE_AGENT_STORE;else process.env.CODE_AGENT_STORE=old;}
});
