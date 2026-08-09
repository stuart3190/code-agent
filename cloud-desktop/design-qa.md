# C1 design QA

- Source visual truth: `public/thrallo-cloud-workspace-background.png`
- Existing C1 structural reference: `evidence/c1/selected-visual-option-2.png`
- Browser-rendered implementation: `evidence/c1/screenshots/01-first-launch.png`
- Side-by-side comparison: `evidence/c1/design-qa-comparison.png`
- Source pixels: 1672 x 941
- Implementation pixels: 1440 x 1024
- Comparison normalization: source aspect ratio preserved with a centered cover crop to 1440 x 1024; implementation captured at 1440 x 1024 with device scale factor 1
- State: first launch, light shell appearance, Thrallo placeholder open

## Full-view comparison evidence

The exact supplied light Thrallo cloud image is rendered on the desktop canvas with `cover` sizing
and centered positioning. Its blue geometric mark remains visible at the left, pale cloud and circuit
details frame the application windows, and the Thrallo signature remains at the lower right. The
image restores the requested light product identity while keeping enough separation between the
desktop, white windows, application shelf, and status rail.

## Focused comparison evidence

The first-launch, normal-desktop, multiple-window, launcher, and dark-compatibility captures were
opened at native resolution. All seven canvas shortcuts remain readable over the lighter image using
dark labels, subtle white text shadow, small white icon plates, and pale-blue focus/running states.
The image remains behind the C1 window layer and does not alter window dimensions, taskbar layout,
launcher placement, or responsive behavior.

## Required fidelity surfaces

- Fonts and typography: the existing Inter-compatible system stack and compact C1 hierarchy are
  unchanged. Shortcut labels retain their compact size and use dark ink over the light image.
- Spacing and layout rhythm: the 112 px shelf, 54 px status rail, 42 px title bars, 68 px shortcut
  footprints, window positions, and restrained elevation remain unchanged.
- Colors and visual tokens: the supplied white, ice-blue, and electric-blue image is used verbatim.
  Its palette supports the approved light-by-default direction; dark-mode chrome remains compatible
  without replacing the desktop image.
- Image quality and asset fidelity: the supplied 1672 x 941 PNG is copied byte-for-byte into the
  package and rendered with aspect-preserving `cover`; no CSS recreation, generated substitute, or
  stretched raster is used.
- Copy and content: fixture content and Thrallo placeholder copy are unchanged. The redundant
  code-rendered canvas watermark remains hidden because the supplied image already contains Thrallo
  branding.

## Interaction and responsive verification

Playwright verified the exact local background request, all shortcut launch/focus paths, launcher and
taskbar synchronization, accessibility, tablet and mobile layouts, and loopback-only network
behavior. Tablet and mobile continue using their focused-window/app-switcher layouts, so the desktop
image creates no new overflow or touch regression.

## Findings

No actionable P0, P1, or P2 visual issue remains.

P3 follow-up: the user may prefer a different focal crop after reviewing the live prototype. The
current centered `cover` crop is the most stable default across common desktop aspect ratios.

## Comparison history

The rejected first background pass used the earlier dark-blue version of the artwork and required
white shortcut labels. The user supplied a lighter replacement, which was applied byte-for-byte.
Shortcut labels, selection surfaces, and fallback canvas color were then returned to a light-product
contrast treatment. Post-fix evidence is the refreshed fifteen-screenshot set and current
side-by-side comparison.

## Implementation checklist

- [x] Exact replacement background asset used
- [x] Desktop canvas only; surrounding C1 shell preserved
- [x] Seven shortcuts remain readable and interactive
- [x] Light and dark compatibility checked
- [x] Desktop, tablet, and mobile layouts checked
- [x] No-production-network boundary preserved

final result: passed
