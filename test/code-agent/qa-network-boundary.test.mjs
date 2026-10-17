import test from 'node:test';
import assert from 'node:assert/strict';
import {isPrivateAddress,safeBrowserUrl} from '../../shell/server/lib/qaRunner.mjs';
for(const address of ['::ffff:127.0.0.1','::','fe90::1','100.64.0.1','224.0.0.1','ff02::1','not-an-address'])test(`QA rejects non-public address ${address}`,()=>assert.equal(isPrivateAddress(address),true));
test('QA retains public IPv4 and IPv6 access',()=>{assert.equal(isPrivateAddress('8.8.8.8'),false);assert.equal(isPrivateAddress('2606:4700:4700::1111'),false);});
test('embedded credentials are rejected even for a trusted preview origin',async()=>assert.equal(await safeBrowserUrl('https://user:pass@preview.example.test/','https://preview.example.test'),false));
test('explicit trusted preview can remain private',async()=>assert.equal(await safeBrowserUrl('http://127.0.0.1:1234/','http://127.0.0.1:1234'),true));
