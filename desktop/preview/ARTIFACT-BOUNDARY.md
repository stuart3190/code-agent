# D10 local artifact boundary

D10 artifacts are deliberately local:

- fixture screenshots are deterministic SVG data held in fixture memory;
- local screenshots and Playwright traces are written only below the extension's desktop storage directory;
- test summaries and redacted diagnostics remain in workbench state;
- project files are never used as the implicit artifact store;
- cookies, authorization headers, request/response bodies and environment values are not retained;
- every artifact records `localOnly: true` and `uploaded: false`.

Production Thrallo storage, retention, signed downloads, canonical snapshot attribution and cross-device artifact synchronization remain D10 Track B work.
