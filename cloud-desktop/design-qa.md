# C1 design QA

- Source visual truth: `evidence/c1/selected-visual-option-2.png`
- Browser-rendered implementation: `evidence/c1/screenshots/02-normal-desktop.png`
- Side-by-side comparison: `evidence/c1/design-qa-comparison.png`
- Source pixels: 1487 × 1058
- Implementation pixels: 1440 × 1024
- Comparison normalization: source scaled to 1440 × 1024; implementation captured at 1440 × 1024; device scale factor 1
- State: normal active workspace, light appearance, Browser focused with Thrallo behind

## Full-view comparison evidence

The corrected implementation preserves the selected direction's distinguishing structure: a narrow
vertical application shelf, a separate bottom workspace/status rail, a pale full-surface desktop,
compact window chrome, a dominant fixture Browser window, a secondary Thrallo placeholder window,
subtle active-window elevation, teal/blue application accents, and restrained density. A compact
two-column application-shortcut grid now occupies the free upper-left canvas without competing with
the application windows. The implementation uses a flat pale stone canvas instead of copying the
concept's decorative paper texture; this keeps C1 within the product requirement to avoid
wallpaper-like novelty and avoids inventing a raster brand asset.

## Focused comparison evidence

The first-launch and normal-desktop captures verify all seven canvas shortcuts with coherent
Phosphor icons, readable labels, focused/running state, and adequate separation from the shelf.
App-specific captures `05-thrallo-placeholder.png`, `06-browser-app.png`, `07-files-app.png`,
`08-terminal-app.png`, `09-github-app.png`, `10-storage-warning.png`, and `11-settings-app.png` were
opened and inspected at native screenshot resolution. Typography remains readable, title-bar and
toolbar spacing stays compact, icons come from one coherent Phosphor family, controls are not
clipped, and fixture labels clearly distinguish offline/demo behavior. Separate crops were not
needed because the native 1440 × 1024 captures keep every important control readable.

## Required fidelity surfaces

- Fonts and typography: Inter-compatible system stack, compact 10–14 px chrome, strong 20–42 px
  content hierarchy, and stable wrapping match the selected direction's editorial density.
- Spacing and layout rhythm: 112 px shelf, 54 px status rail, 42 px title bars, lean separators,
  modest 6–10 px radii, and restrained window elevation preserve the reference proportions.
- Colors and visual tokens: pale stone canvas, white surfaces, deep ink text, blue focused state,
  and teal connection/application accents align with the selected direction. Dark mode is a
  compatibility state rather than the product identity.
- Image quality and asset fidelity: the concept contains no required photo or illustration asset.
  Application and control icons use the Phosphor library; no emoji, handcrafted SVG, or placeholder
  icon art is used.
- Copy and content: Thrallo remains explicitly a future-integration placeholder. Browser, Files,
  Terminal, GitHub, Storage, and Settings use realistic but clearly fixture-only content.

## Interaction and responsive verification

Playwright exercised mouse double-click, touch single-tap, keyboard shortcut opening, shortcut
drag/persistence, launcher and taskbar synchronization, launcher search/keyboard dismissal, app
open/focus, taskbar restore, minimize/maximize/restore, snapping, window drag/resize, close,
persistence, corrupt-state recovery, all seven fixture apps, reduced motion, tablet
portrait/landscape, mobile app switching, and fixed-origin network enforcement. Chromium console
output contained no application error during the passing run.

## Findings

No actionable P0, P1, or P2 visual mismatch remains.

P3 follow-up: a future brand pass may supply an approved subtle canvas texture or bespoke Thrallo
mark. C1 intentionally uses the selected structure and a library icon until those assets exist.

## Comparison history

The original C1 browser pass found functional test issues in drag bounds, ambiguous test selectors,
and a tablist accessibility role; those were corrected before the original handoff. The C1 visual
correction then found that the full-size window layer intercepted pointer input intended for the new
canvas shortcuts. Empty window-layer space was made pointer-transparent while real windows retain
normal input. Post-fix evidence is the refreshed fifteen-screenshot set, the regenerated side-by-side
comparison, and the passing shortcut-focused Chromium checks.

## Implementation checklist

- [x] Selected visual structure implemented
- [x] All seven fixture applications represented
- [x] All seven applications available as accessible desktop shortcuts
- [x] Window and launcher interactions verified
- [x] Responsive and accessibility states verified
- [x] No-production-network boundary verified

final result: passed
