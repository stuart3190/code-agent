# Thrallo Cloud Desktop — C1

This package is the isolated browser application for the new Thrallo Cloud Desktop. It is not the
native Thrallo desktop, Code OSS, VS Code in a browser, Builder V2, or a decorated copy of
`app.thrallo.com`.

C1 is a visually complete, deterministic prototype. It includes the cloud desktop shell, a compact
application shelf/taskbar, launcher, fixture workspace status, persistent window management, and
exactly seven fixture applications: Thrallo, Browser, Files, Terminal, GitHub, Storage, and
Settings. It makes no production request and invokes no local shell or filesystem API.

## Run locally

```powershell
cd C:\Users\Administrator\code-agent-cloud-desktop\cloud-desktop
npm install
npm run dev
```

Open `http://127.0.0.1:4174` in a normal browser.

## Review fixtures

Use the development-only scenario selector in the upper-right corner to review first launch,
normal activity, several running apps, storage warning, offline recovery, and dark-theme
compatibility. Use **Reset C1 fixture desktop** in Settings to clear browser-local layout state.

## Verification

```powershell
npm run test
npm run build
npm run test:playwright
npm run test:accessibility
npm run test:visual
```

The package has no production provider, authentication, external-network requirement, or live
fallback. `guardrails/protected-paths.json` restricts branch changes to `cloud-desktop/**`.
