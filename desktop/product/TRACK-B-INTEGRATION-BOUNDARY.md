# D9 Track B integration boundary

D9 foundation is an independently testable desktop presentation. D1 and D3 deterministic providers supply account, project, conversation, plan, agent, model, usage, build and deployment-shaped fixture reads. Explicit D9 fixture action providers record typed UI decisions without a transport or production side effect.

The following remain blocked until Packages 14R and 15 are accepted and the Builder V2 snapshot, build, repair and publishing contracts are frozen:

- authoritative project and conversation identity;
- durable plan approval, rejection, expiry and change-request semantics;
- production agent cancellation, retry, resume, concurrency and merge ownership;
- production model routing, availability, BYOK classification and usage attribution;
- build, verification, repair and recovery event normalization;
- D7 canonical association, working sets, snapshots, synchronization and conflicts;
- publish-source and deployment integration.

Track B must implement the existing provider interfaces. It must not teach the D9 view about Builder V2 routes or wire events. Until then, `integration.builderV2Mutation` is `capability_unavailable`; future cloud, publishing and canonical synchronization states remain `integration_pending`. There is no live origin, fallback transport, hidden retry or ordinary-chat approval path.
