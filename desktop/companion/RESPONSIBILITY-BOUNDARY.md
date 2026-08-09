# D14 portal and companion responsibility boundary

`app.thrallo.com` remains the authority for signup, login and recovery, subscriptions, billing recovery, invoices, account management, API keys and tokens, browser-based account integrations, desktop downloads, approved device/session management, and cloud-workspace launch or recovery entry points.

Thrallo Desktop remains the project workbench: conversation, local workspaces, editor/files, agents, preview/testing, deployment and integration presentation, local settings, and model/usage summaries. D14 does not duplicate a portal-owned purchase, recovery, credential, or account workflow.

The machine-readable source of truth is `PORTAL_RESPONSIBILITIES` in `editor/vscode/lib/companionFoundation.js`. Portal handoffs use the fixed `https://app.thrallo.com` origin and a closed destination map. Destinations without an approved stable route return `integration_pending`; no dynamic path, arbitrary URL, query string, fragment, bearer material, or authorization result is accepted.

Return-to-desktop context is metadata only. It cannot carry credentials, authorization codes, state/nonce values, mutable grants, arbitrary URLs, or an unapproved deep-link exchange.

## Companion boundary

`companion_touch` is a host-neutral, fixture-verified presentation profile. It adapts D3 and D9-D12 state and delegates typed fixture actions to their existing owners. It does not define new entitlement rules, usage calculations, approval semantics, agent states, preview states, deployment states, or integration states.

Source editing, terminal, secrets, raw environment editing, database mutation, unrestricted Git, arbitrary browsing, and cloud-infrastructure administration are explicitly unavailable. `reduced_workbench_keyboard_pointer` is definition-only and requires later real-device qualification.
