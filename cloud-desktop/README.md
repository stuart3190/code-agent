# Thrallo Cloud Desktop — C0

This is the isolated browser application for the new Thrallo Cloud Desktop. It is not the native
Thrallo desktop, Code OSS, VS Code in a browser, the current Builder V2 application, or a decorated
copy of `app.thrallo.com`.

C0 deliberately renders one neutral page and registers no applications. Desktop chrome, windows,
launcher, taskbar, and fixture applications begin only after explicit C1 approval.

## Run locally

```powershell
cd C:\Users\Administrator\code-agent-cloud-desktop\cloud-desktop
npm install
npm run dev
```

Open <http://127.0.0.1:4174>.

## Verification

```powershell
npm run test
npm run build
npm run test:playwright
```

The package has no production provider, authentication, external-network requirement, or live
fallback. `guardrails/protected-paths.json` restricts this branch to `cloud-desktop/**` changes.
