// Read-only mobile hit testing: no clicks, form submissions, or business-text expectations.
// A modal may intentionally cover background controls, so only persistent non-modal obstruction
// or non-scrollable clipping is an app defect. Two identical samples avoid treating transient
// animation as a failure.
export async function probeResponsiveControls({ browser, page: existingPage = null, previewUrl, timeoutMs = 15_000 }) {
  const context = existingPage ? null : await browser.newContext();
  const page = existingPage || await context.newPage();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    if (!existingPage) await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(500);
    const sample = () => page.evaluate(() => {
      const modal = document.querySelector('dialog[open], [aria-modal="true"], [role="dialog"]');
      const scope = modal || document;
      const findings = [];
      const controls = [...scope.querySelectorAll('button, input:not([type=hidden]):not([type=file]), select, textarea, a[href]')].slice(0, 40);
      for (const el of controls) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none' || Number(style.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.top < 0 || r.bottom > innerHeight) continue;
        // Root overflow clipping can hide broken layouts from scrollWidth. Prove a partially
        // visible control is cut off by a non-scrollable ancestor, without rejecting carousels,
        // scrollable boards, hidden drawers, or controls wholly outside the initial viewport.
        let left = 0, right = innerWidth, scrollable = false, clips = false;
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          const s = getComputedStyle(parent), box = parent.getBoundingClientRect();
          if (['auto', 'scroll'].includes(s.overflowX) && parent.scrollWidth > parent.clientWidth + 2) scrollable = true;
          if (['hidden', 'clip'].includes(s.overflowX)) {
            clips = true;
            left = Math.max(left, box.left + parent.clientLeft);
            right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
          }
        }
        const visibleLeft = Math.max(left, r.left), visibleRight = Math.min(right, r.right);
        if (!scrollable && clips && visibleRight - visibleLeft >= 4
          && (r.left < left - 2 || r.right > right + 2)) {
          const hit = document.elementFromPoint((visibleLeft + visibleRight) / 2, r.top + r.height / 2);
          if (hit && (hit === el || el.contains(hit))) {
            findings.push({ control: (el.getAttribute('aria-label') || el.textContent || el.name || el.tagName).trim().slice(0,80),
              controlId: el.getAttribute('data-thrallo-control') || el.getAttribute('data-thrallo-action') || null,
              kind: 'clipped_control', blocker: 'non-scrollable horizontal clipping', width:390 });
          }
          continue;
        }
        if (r.left < 0 || r.right > innerWidth) continue;
        const points = [[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]];
        const hits = points.map(([x,y]) => document.elementFromPoint(r.left+r.width*x,r.top+r.height*y));
        if (hits.some(hit => hit && (hit===el || el.contains(hit)))) continue;
        const blocker = hits[0];
        if (!blocker || blocker.closest('dialog, [role="dialog"], [aria-modal="true"]')) continue;
        // Keep the rule specific: ordinary links/buttons that overlap need a richer interaction
        // probe. Here a non-interactive content/status panel physically covers a usable control.
        if (blocker.closest('button,a,input,select,textarea,[role="button"]')) continue;
        const panel = blocker.closest('aside,[role="status"],article,section');
        if (!panel || panel.contains(el)) continue;
        findings.push({ control: (el.getAttribute('aria-label') || el.textContent || el.name || el.tagName).trim().slice(0,80),
          controlId: el.getAttribute('data-thrallo-control') || el.getAttribute('data-thrallo-action') || null,
          blocker: panel.getAttribute('aria-label') || panel.getAttribute('role') || panel.tagName.toLowerCase(), width:390 });
      }
      return findings;
    });
    const first = await sample();
    await page.waitForTimeout(300);
    const second = await sample();
    return { checked:true, width:390, findings:second.filter(f=>first.some(a=>JSON.stringify(a)===JSON.stringify(f))) };
  } catch (error) {
    return { checked:false, width:390, findings:[], unavailable:true, error:String(error.message || error).split('\n')[0].slice(0,200) };
  } finally { if (context) await context.close().catch(()=>{}); }
}
