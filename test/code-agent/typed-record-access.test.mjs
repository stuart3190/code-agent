import test from 'node:test';
import assert from 'node:assert/strict';
import {lintTypedRecordAccess} from '../../shell/server/lib/builderV2/platformModules/recordAccessLint.mjs';
const lint=s=>lintTypedRecordAccess(s,'src/screens/Library.jsx');
const prefix='import {repository} from "../../lib/app"; const books=repository("book");';
test('canonical metadata and nested domain fields are valid',()=>assert.deepEqual(lint(prefix+'async function run(){const book=await books.get("id"); return [book.id,book.version,book.values.title];}'),[]));
test('get/list/create/update provenance catches flat fields',()=>{
 for(const operation of ['get("id")','create({title:"A"})','update("id",{title:"B"})']) assert.equal(lint(prefix+`async function run(){const book=await books.${operation}; return book.title;}`).length,1);
 assert.equal(lint(prefix+'async function run(){const rows=await books.list();return rows.map(book=>book.title);}').length,1);
});
test('actual generated memo repository and data fallback are diagnosed',()=>{
 const findings=lint('import {useMemo} from "react";'+prefix.replace('const books=repository("book");','')+'function Screen(){const books=useMemo(()=>repository("book"),[]); const openEdit=async(id)=>{const result=await books.get(id);const book=result?.data||result;return {title:book.title,author:book.author,status:book.status};};}');
 assert.equal(findings.length,4);assert.ok(findings.some(f=>f.message.includes('record.values.title')));
});
test('shadowed bindings, unrelated APIs, flat adapters and mutated values stay unknown',()=>{
 for(const body of [
  'async function run(){const book=await books.get("id");function unrelated(book){return book.title;}return book.values.title;}',
  'async function run(){const book=books.toLegacyRecord(await books.get("id"));return book.title;}',
  'async function run(){let book=await books.get("id");book={title:"flat"};return book.title;}',
  'function run(books){const book=books.get("id");return book.title;}',
 ])assert.deepEqual(lint(prefix+body),[]);
 assert.deepEqual(lint('import {repository} from "other-sdk";const book=await repository("book").get("id");book.title;'),[]);
});
test('computed and optional fields are diagnosed, unknown computed keys are not guessed',()=>{
 assert.equal(lint(prefix+'const book=await books.get("id");book?.title;book["author"];book[key];').length,2);
});
test('syntax errors are left to compiler',()=>assert.deepEqual(lint(prefix+'const ='),[]));
