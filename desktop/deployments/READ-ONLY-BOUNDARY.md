# D11 read-only deployment boundary

An optional stable deployment adapter may be constructed only with:

- the versioned D1 `createStableReadOnlyProvider` factory;
- an explicitly injected transport;
- explicit origin-relative routes for `listDeployments`, `getDeployment` and `getDomainStatus`;
- `GET` or `HEAD` methods only.

The adapter has no default origin. D1 mutation operations remain `capability_unavailable`, and D11 deterministic tests never require network access. Deployment logs remain fixtures until an authoritative read contract is approved because the current D1 deployment family has no log-read operation.
