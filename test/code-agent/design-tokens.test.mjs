// Phase 20 guard: the /design prototype inlines the canonical design tokens
// (shell/web/src/theme/tokens.css). If the two drift, the wireframes stop representing
// the design system Phase 21 will build from — fail the build instead.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tokensUrl = new URL("../../shell/web/src/theme/tokens.css", import.meta.url);
const prototypeUrl = new URL("../../shell/web/public/design/index.html", import.meta.url);

function extractTokens(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start !== -1, `${selector} block missing`);
  const open = css.indexOf("{", start);
  let depth = 1, i = open + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  const block = css.slice(open + 1, i - 1);
  const tokens = new Map();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(match[1], match[2].trim().replace(/\s+/g, " "));
  }
  return tokens;
}

test("the /design prototype inlines the canonical tokens exactly (light + dark)", async () => {
  const css = await readFile(tokensUrl, "utf8");
  const html = await readFile(prototypeUrl, "utf8");
  for (const selector of [":root", '[data-theme="dark"]']) {
    const canonical = extractTokens(css, selector);
    const inlined = extractTokens(html, selector);
    assert.ok(canonical.size > 20 || selector !== ":root", "canonical token set looks too small");
    for (const [name, value] of canonical) {
      assert.equal(inlined.get(name), value, `${selector} ${name} drifted between tokens.css and the prototype`);
    }
  }
});

test("the prototype is self-contained and shows only the four permanent elements", async () => {
  const html = await readFile(prototypeUrl, "utf8");
  for (const external of ['src="http', "src='http", 'href="http', "href='http", "url(http", "@import"]) {
    assert.ok(!html.includes(external), `prototype must not load external resources (${external})`);
  }
  assert.match(html, /fonts\/manrope-latin-wght-normal\.woff2/);
  assert.match(html, /name="robots" content="noindex"/);
  // The permanent four (docs/DESIGN.md): conversation, agent rail, preview, settings.
  for (const marker of ["thread", "rail", "preview-pane", "sheet"]) {
    assert.ok(html.includes(`id="${marker}"`) || html.includes(`class="${marker}`) || html.includes(`"${marker}"`),
      `permanent element marker missing: ${marker}`);
  }
});
