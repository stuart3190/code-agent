# D14 production integration boundary

D14 Foundation has no production companion transport, mobile application, push-notification service, cloud-workspace launch path, durable alert store, production portal return exchange, or Builder V2 mutation provider.

Track B must separately approve:

- production-safe read and event contracts for project, build, agent, plan, preview, deployment, usage, account and alert state;
- authenticated instruction, plan-decision and bounded-control mutations with fresh entitlement and capability checks;
- replay-safe high-impact confirmation and any reauthentication policy;
- portal return-context signing and single-use validation without credentials in URLs;
- notification consent, delivery, persistence, retention and privacy behavior;
- real tablet and mobile qualification, including the reduced-workbench keyboard/pointer profile;
- cloud-workspace launch and recovery authority.

Foundation fixtures are presentation evidence, not production wire-format promises. Stale or offline state fails closed for actions that need fresh authority. No foundation action may gain a default production origin or hidden mutation fallback.
