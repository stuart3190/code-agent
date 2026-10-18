// Independent browser replay of immutable September 22 snapshots. This proves rendered outcomes,
// not the platform verifier. The initial snapshot must fail; repaired snapshots must calculate.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { initial, repaired, retainedScreen } from './retained-downlight-harness.mjs';
let browser;
before(async () => { browser = await chromium.launch({args:['--no-sandbox']}); });
after(async () => { await browser?.close(); });
test('original downlight snapshot reproduces missing composed calculation store', async () => {
  const server = await retainedScreen(initial); const page = await browser.newPage(); const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.url); await page.waitForTimeout(300);
    assert.ok(errors.includes('No composed entity store for calculation'));
  } finally { await page.close(); await server.close(); }
});
for (const hash of repaired) test(`retained repaired downlight renders correct units and outcomes ${hash.slice(0,8)}`, async () => {
  const server = await retainedScreen(hash); const page = await browser.newPage();
  try {
    for (const [unit,length,width,spacing,count] of [
      ['feet','12','10','4',9], ['metres','6','4','1.5',12], ['metres','5','3','',6], ['metres','0','4','',null],
    ]) {
      await page.goto(server.url);
      await page.locator(`button[value=${unit}]`).click();
      for (const [name,value] of [['roomLength',length],['roomWidth',width],['preferredSpacing',spacing]]) {
        await page.locator(`input[name=${name}]`).fill(value);
      }
      await page.locator('[data-thrallo-action="act_865859d3"]').click();
      const panel = page.locator('[aria-label="Downlight estimate result"]');
      if (count === null) {
        await page.locator('[role=alert]').waitFor({state:'visible'});
        assert.equal(await panel.count(),0);
      } else {
        await panel.waitFor({state:'visible'});
        assert.equal(await panel.locator('strong').innerText(),String(count));
        assert.match(await panel.innerText(),unit==='feet' ? /\b(?:ft|feet)\b/ : /\b(?:m|metres)\b/);
      }
    }
  } finally { await page.close(); await server.close(); }
});
