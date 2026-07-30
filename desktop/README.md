# Thrallo Desktop (Code - OSS)

Thrallo Desktop is a genuine Code - OSS build carrying the Thrallo product identity — a real
Cursor-style editor, not a web wrapper. The upstream tree is never committed here: it is
cloned at an exact pinned commit and overlaid.

## Layout

- `upstream.json` — the pinned `microsoft/vscode` tag + commit (MIT licensed).
- `product.overrides.json` — Thrallo identity merged onto stock `product.json`: names, data
  folder, `thrallo://` protocol, platform identifiers, telemetry off, updates off, and the
  **Open VSX** extension gallery. Microsoft's Visual Studio Marketplace is licensed only for
  Microsoft's own builds and is deliberately absent.
- `generate-assets.mjs` → `assets/` — procedural icon set (PNG/ICO/ICNS), committed for
  reproducibility.
- `bootstrap.mjs` — shallow-clones the pin into `desktop/vscode` (gitignored), verifies the
  commit, and applies the overlay: product config, icons, and the repository's
  `editor/vscode` extension copied in as the built-in `extensions/thrallo`. Idempotent via a
  content-hash marker; `--verify` mode for tests.
- `build.mjs` — `bootstrap | install | compile | dev | package [--platform …]`. Windows x64
  is the release priority; darwin/linux targets are configured from the same pipeline.

## Building (Windows)

Prerequisites: Node 24.x, Python 3.12, Visual Studio 2022 Build Tools (C++ workload) — all
free. Then:

```powershell
node desktop/build.mjs bootstrap
node desktop/build.mjs install     # npm ci in the checkout (native modules compile here)
node desktop/build.mjs compile
node desktop/build.mjs dev         # launch the editor from sources
node desktop/build.mjs package --platform win32-x64   # unsigned min build + archive
```

Nothing is signed, notarised, or store-published; no paid accounts are involved.

## What the editor includes

Everything Code - OSS ships — real local folders and workspaces, tabs, explorer, search,
source control, integrated terminal — plus the built-in Thrallo extension: agent sidebar,
run creation with streamed timelines, diff review, pull-request approval, resume, review
agents, and opt-in inline completions. Authentication uses Thrallo API tokens stored in the
editor's secret storage. Completions build a bounded local workspace index inside the editor
and send only the top three relevant excerpts with a request; the server's encrypted
repository index backfills.

## Verification status (keep this honest)

| Piece | Status |
| --- | --- |
| Bootstrap pin + overlay | Verified by unit tests and a real clone/prepare on Windows |
| Windows x64 dev build + editor smoke test | See CONTEXT.md for the current proof state |
| Windows unsigned package/archive | See CONTEXT.md for the current proof state |
| macOS (darwin) targets | **Configured, never built or run — "Coming soon to macOS" in all public copy** |
| Linux targets | Configured, never built or run |

macOS builds stay private and unpublished until Stuart approves; no public download may
imply a tested macOS binary exists.
