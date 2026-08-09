# D12 Track B integration boundary

D12 Foundation does not define or invoke production mutation contracts. Track B remains responsible for separately approved authority, entitlement, authorization, audit durability, and wire contracts for project environments, secret create/replace/delete, database migration preview/apply/rollback, Supabase configuration, Stripe, GitHub, OAuth, model-provider credentials, and external integrations.

Production adapters must preserve the D12 metadata-only secret result, use an approved secure host/server boundary, and may not expose Supabase secret/service-role keys, database passwords, privileged connection strings, provider keys, OAuth tokens, or webhook secrets to the desktop renderer.

Builder V2 integration and future cloud-workspace environment authority remain blocked. Fixture actions are not compatibility promises for their final wire formats.
