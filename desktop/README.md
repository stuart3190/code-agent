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

Prerequisites: Node 24.x, Python 3.12, Visual Studio 2022 Build Tools (C++ workload
**including Spectre-mitigated libs**, or native modules fail with MSB8040) — all free. For
`package`, the Windows SDK's `signtool.exe` must be on PATH (e.g.
`C:\Program Files (x86)\Windows Kits\10\bin\<sdk>\x64`): the pipeline uses it only to STRIP
Microsoft's signatures from bundled binaries before stamping Thrallo version resources —
nothing gets signed and no certificate is involved. Then:

```powershell
node desktop/build.mjs bootstrap
node desktop/build.mjs install     # npm ci in the checkout (native modules compile here)
node desktop/build.mjs compile
node desktop/build.mjs dev         # launch the editor from sources
node desktop/build.mjs package --platform win32-x64   # unsigned min build + archive
node desktop/build.mjs installer                       # private unsigned Inno Setup artifact
```

Dependency restore intentionally runs before the upstream Copilot built-in is excluded.
Code OSS postinstall enumerates every upstream extension workspace; deleting Copilot first
causes a misleading Windows `cmd.exe ENOENT`. Compile and package apply the exclusion after
restore and sync the current Thrallo built-in immediately before building.

## Release packaging (Windows)

After `package`, two distributables are produced:

- **Installer** — `desktop/out/Thrallo-Setup-x64.exe` via Inno Setup 6:
  `ISCC.exe desktop\installer\Thrallo.iss`. User-level (no admin prompt, installs to
  `%LOCALAPPDATA%\Programs\Thrallo`), Start menu shortcut, optional desktop shortcut,
  standard uninstall. Signed-ready: enable the `SignTool` directive in `Thrallo.iss`
  once a code-signing certificate exists.
- **Portable ZIP** — rename `desktop/out/thrallo-win32-x64.zip` to
  `Thrallo-Portable-x64.zip`; extract and run `Thrallo.exe`, no install needed.

Customer publication is not part of the private desktop foundation pipeline. D15 artifacts
must not be copied to a release host or added to the public download manifest. Track C
approval, signing, complete platform qualification, rollback evidence, and all machine-
readable release gates are required before any customer-facing publication stage exists.

Binaries are unsigned until protected CI signing is configured; unsigned output is private
and machine-classified as not release eligible.

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
| Windows x64 source compile | D15: built from the exact pin with zero compile errors |
| Windows unsigned package/archive | D15: privately built and hashed; not release eligible |
| Windows packaged workbench smoke | D15: raw 5/13, visually substantiated 3/13; automation failures remain explicit blockers |
| macOS (darwin) targets | **Configured, never built or run — "Coming soon to macOS" in all public copy** |
| Linux targets | Configured, never built or run |

macOS builds stay private and unpublished until Stuart approves; no public download may
imply a tested macOS binary exists.
