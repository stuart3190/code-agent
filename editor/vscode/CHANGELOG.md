# Changelog

## 0.4.1 — candidate, pending distribution

- Repository settings cannot redirect the API connection or a stored token. Configure the server in user settings.
- Tokens are stored separately for each server origin. Legacy tokens remain usable only with the default Thrallo origin; custom servers require reconnection.
- Require HTTPS except for loopback development; reject credential-bearing URLs and redirects.
- Refresh the conversation when credentials change or the user disconnects.

## 0.2.0 — 2026-07-30

- Marketplace-ready packaging: icon, license, categories, gallery banner.
- Status-bar run indicator: live state while an agent is working, click to open the timeline.
- Agents view shows each agent's latest run state with matching icons.

## 0.1.0 — 2026-07-30

- Initial release: connect with an API token, agents view, run launching, live SSE
  timeline, diff review, approve/decline pull-request publication, resume preserved
  workspaces.
