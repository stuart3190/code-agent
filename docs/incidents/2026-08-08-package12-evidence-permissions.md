# Package 12 evidence-directory permission incident

- Classification: operational evidence-integrity incident; no customer-data or production-service impact
- Date: 2026-08-08 UTC
- Scope: `/home/ubuntu/thrallo-deploy-evidence`
- Trigger: a PowerShell interpolation error expanded the intended remote target variable before SSH execution, so a recursive read-only permission command began at the evidence root instead of the new Package 12 evidence directory.

The command stopped on an existing root-owned file. It did not target Supabase, customer storage, application artifacts, Caddy, provisiond, or service configuration. The evidence root was restored to mode `0755`. Older evidence entries that became more restrictive remain readable and intentionally have not been loosened without an authoritative prior-mode baseline. No evidence bytes were modified or removed.

Corrective actions:

- Remote destructive or recursive permission commands use literal, fully resolved paths rather than client-expanded variables.
- New immutable evidence is created in an exact package directory and checked before applying read-only modes.
- Evidence-root permissions are never changed as part of package archival.
- The Package 12 backup/restore gate was restarted from a clean disposable environment after the incident.

The event does not require customer notification: it affected local operational evidence permissions only, caused no service interruption, and exposed or changed no customer data.
