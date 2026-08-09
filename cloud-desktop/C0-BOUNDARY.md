# C0 boundary

C0 provides only a self-contained Vite/React scaffold, an empty application registry, a
deterministic fixture-provider boundary, and machine-enforced isolation guards.

It must not implement desktop chrome, a launcher, a taskbar, windows, applications, a cloud
runtime, authentication, storage, a PTY, an unrestricted browser, GitHub, Builder V2, or production
integration. Unsupported provider operations return `capability_unavailable`; there is no live
fallback.
