# Platform coverage

What Thrallo is actually tested on, and what it is not. Written because "the full matrix passes"
was true and misleading at the same time: every project in that matrix was Chromium.

## Automated, every run

| Project | Engine | Geometry | Scope |
|---|---|---|---|
| `desktop-chromium` | Chromium | 1280×720 | Whole suite |
| `tablet-portrait` | Chromium | iPad Pro 11, touch | Whole suite |
| `tablet-landscape` | Chromium | iPad Pro 11 landscape, touch | Whole suite |
| `mobile-chromium` | Chromium | Pixel 7, touch | Whole suite |
| `firefox` | **Gecko** | Desktop Firefox | `cross-browser`, `chat-shell`, `settings`, `projects-experience` |
| `webkit` | **WebKit** | Desktop Safari descriptor | same subset |

Firefox and WebKit run a subset by design. The risks that differ between engines are layout and
overflow, focus behaviour, CSS feature support and the streaming APIs — not application logic,
which is engine-independent and covered once at the four Chromium viewports. Running 600 specs
three more times would spend half an hour re-proving the same reducer.

Two real defects were found the first time these two engines ran, both fixed:

- **WebKit**: closing an overlay did not return focus. Safari deliberately does not focus a button
  when it is clicked, so `document.activeElement` was `<body>` by the time the overlay mounted and
  there was nothing to hand focus back to. Overlays now take the element that opened them.
- **Firefox**: Back after a reload restored the document from the back/forward cache without firing
  `popstate`, leaving the URL and the rendered tab disagreeing. The shell now also re-reads the
  address on `pageshow`.

## Covered by equivalence, not directly

- **Microsoft Edge** — Chromium, same engine version Playwright ships. `desktop-chromium` covers it.
  Edge-specific surface (its own UI, IE mode, enterprise policy) is not exercised.
- **Safari** — the `webkit` project is the engine Safari is built on, not Safari itself. It does not
  cover Safari's own UI, its extension model, ITP behaviour, or version skew between the WebKit
  build Playwright ships and the one in any shipped Safari.

## NOT covered

Stated rather than implied, because a claim of coverage here would be false.

- **Real iOS / iPadOS Safari.** No Apple device and no macOS host is available to this project. The
  tablet projects emulate iPad *geometry and touch* on Chromium; they say nothing about iOS.
- **Real Android Chrome.** `mobile-chromium` is Pixel 7 geometry and touch emulation on desktop
  Chromium — a good proxy for layout, not for Android's browser.
- **Real device hardware** of any kind: no touch latency, no on-screen keyboard behaviour, no
  memory limits, no network conditions.
- **Screen readers.** ARIA roles, names, focus order and focus return are asserted structurally.
  No test drives NVDA, JAWS or VoiceOver, so "announced correctly" is not claimed anywhere.
- **Safari < current, Firefox ESR, or any browser more than one major version old.**

## How to extend

`playwright.config.mjs` holds the projects. Adding a real device means a hosted device farm; adding
Safari proper means a macOS runner. Neither exists today, and until one does this file is the
honest statement of what the green tick means.
