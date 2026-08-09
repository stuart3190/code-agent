# D4 spike architecture

## Proven experiment boundary

The host-side D4 harness used the repository-pinned `@daytona/sdk` 0.201.0 against target `eu`. The host created two private, labeled synthetic container sandboxes and one S3-backed Daytona volume. No Daytona credential was mounted into either sandbox. All workspace content was generated from `syntheticProject.mjs`.

Each workspace had its own filesystem, process API, PTY namespace, port namespace, and Daytona identity. Workspace A hosted the synthetic app, two dev-server ports, Playwright/Chromium, and two bounded worker processes. Workspace B existed only for boundary checks. A snapshot-based replacement verified recovery. Signed Daytona preview URLs were used only during the run and were never recorded.

```text
host-only D4 harness
  -> Daytona control API (host credential only)
      -> private workspace A (synthetic source + PTY + dev servers + browser)
      -> private workspace B (synthetic isolation peer)
      -> synthetic volume subpath
      -> synthetic snapshot and replacement workspace
```

## Production shape this does not implement

A production Thrallo cloud desktop would still require a Thrallo authorization/lifecycle gateway in front of Daytona, a PTY WebSocket gateway, an authenticated preview gateway, auditable workspace ownership, quotas and abuse controls, encrypted project synchronization, backup policy, and a reproducible pinned Code OSS web artifact. None exists in D4.

## Pinned Code OSS result

The spike fetched the exact Code OSS commit `3a03d6f72d628a7741c29f456b4ddbb5ae68502c` (1.131.0). A clean `scripts/code-web.sh` attempt did not listen because the checkout had no installed build dependencies; `rimraf` was the first missing package. The desktop branch currently packages Electron and does not produce a browser/server artifact or a web-compatible Thrallo extension bundle. The smallest later packaging prototype is a CI-built, content-addressed web/server artifact from the same pin, with product overrides and an explicit extension web-compatibility test. This must not change the native Electron architecture.
