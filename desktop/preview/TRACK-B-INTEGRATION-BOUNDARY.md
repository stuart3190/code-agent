# D10 Foundation integration boundary

D10 Foundation owns only local and deterministic-fixture application testing. The D9 workbench consumes the existing D1 preview read contract and routes explicit local side effects through a host-injected adapter. No Builder V2 route, cloud workspace port, publishing source or production browser session is known to the view.

The following remain blocked:

- D6: authenticated cloud-workspace port routing, ownership, revocation, audit and preview gateway policy;
- D7: canonical project, working-set and verified snapshot identity;
- D10 Track B: production diagnostic event normalization, browser-session authorization and artifact persistence;
- D11: deployment/publishing preview source and release diagnostics.

Future cloud and verified-snapshot preview sources return `integration_pending` or `capability_unavailable`. Production artifacts are not uploaded, local preview URLs are restricted to loopback origins, and no fallback origin exists.
