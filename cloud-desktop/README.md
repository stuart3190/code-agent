# Thrallo Cloud Desktop — C3

This package is the isolated browser application for the new Thrallo Cloud Desktop. It is not the
native Thrallo desktop, Code OSS, VS Code in a browser, Builder V2, or a decorated copy of
`app.thrallo.com`.

C1/C2 provide the accepted deterministic shell. C3 adds a host-neutral virtual filesystem and a
credible fixture cloud-file manager without host filesystem, shell, upload, storage-service, or
network access. The prototype still includes seven fixture applications: Thrallo, Browser, Files,
Terminal, GitHub, Storage, and Settings.

Files supports deterministic navigation, search, sorting, fixture mutations, revision conflicts,
Trash recovery, transfer simulations, large folders, and shared fixture storage usage. It makes no
production request and invokes no local shell or filesystem API.

## Run locally

```powershell
cd C:\Users\Administrator\code-agent-cloud-desktop\cloud-desktop
npm install
npm run dev
```

Open `http://127.0.0.1:4174` in a normal browser.

## Review fixtures

Use the development-only shell scenario selector in the upper-right corner to review first launch,
normal activity, several running apps, storage warning, offline recovery, and dark-theme
compatibility. Use **Reset C1 fixture desktop** in Settings to clear browser-local layout state.

C3 file scenarios can be selected with `?filesScenario=normal-files`. Other deterministic values
include `large-folder`, `storage-warning`, `storage-exhausted`, `trash-populated`, `offline-files`,
and `unavailable-files`. Files fixture mutations use a separate versioned browser-local journal.

## Verification

```powershell
npm run test
npm run build
npm run test:playwright
npm run test:accessibility
npm run test:visual
npm run test:c3
```

The package has no production provider, authentication, external-network requirement, or live
fallback. `guardrails/protected-paths.json` restricts branch changes to `cloud-desktop/**`. The C8
replacement boundary is documented in `src/filesystem/PROVIDER-BOUNDARY.md`.
