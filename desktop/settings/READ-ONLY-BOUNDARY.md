# D12 stable read-only adapter boundary

D12 deterministic tests use no network. An optional future stable adapter requires an injected transport and explicit origin-relative routes for settings, environment metadata, secret metadata, database summaries, integrations, and audit events. It exposes GET reads only; secret, environment, database, OAuth, Stripe, GitHub, and provider mutations return `capability_unavailable`.

No default origin, production credential, service-role material, mutation fallback, or mixed read/write legacy endpoint is accepted.
