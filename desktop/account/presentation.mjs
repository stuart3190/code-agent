import { DESKTOP_LAUNCH_ACTIONS } from "../../shared/thrallo-client/src/access/launch.mjs";
import { PORTAL_ACTIONS, PORTAL_DESTINATIONS } from "../../shared/thrallo-client/src/access/portalHandoff.mjs";

const USAGE_LABELS = Object.freeze({
  aiModel: "AI and model usage",
  builds: "Build usage",
  agents: "Agent usage",
  storage: "Storage",
  workspaceCompute: "Workspace compute",
  browserTesting: "Browser and test usage",
});

const CAPABILITY_LABELS = Object.freeze({
  localWorkspace: "Local workspace",
  localTerminal: "Local terminal",
  localGit: "Local Git",
  nativeManagedServices: "Thrallo managed services",
  cloudWorkspace: "Cloud workspace",
  managedAi: "Managed AI",
  builds: "Managed builds",
  previewTesting: "Preview and testing",
  publishing: "Publishing",
  integrations: "Integrations",
});

const ACTION_LABELS = Object.freeze({
  open_local_workspace: "Open local workspace",
  open_installed_desktop_project: "Open desktop project",
  open_cloud_workspace: "Open cloud workspace",
  open_portal: "Open account portal",
  manage_subscription: "Manage subscription",
  recover_billing: "Recover billing",
  recover_suspended_workspace: "Recover workspace",
});

function row(id, label, value, state = null, detail = null) {
  return Object.freeze({ id, label, value, state, detail });
}

export function createDesktopAccessPresentation(accessState) {
  if (!accessState?.account || !accessState?.entitlement || !accessState?.usage) {
    throw new TypeError("Desktop access presentation requires composed D3 access state");
  }
  const identity = accessState.account.identity;
  const accountRows = [
    row("identity", "Account", identity?.displayName || identity?.emailLabel || "Not signed in"),
    identity?.displayName && identity?.emailLabel ? row("email", "Email", identity.emailLabel) : null,
    row("connection", "Connection", accessState.account.session.state, accessState.account.session.state),
    row("device", "Device", accessState.account.session.deviceLabel, null, accessState.account.session.platform),
    row("recovery", "Recovery", accessState.account.recovery.state, accessState.account.recovery.state),
  ].filter(Boolean);
  const usageRows = Object.entries(accessState.usage.resources).map(([key, meter]) => row(
    key,
    USAGE_LABELS[key],
    meter.percent == null ? "Unavailable" : `${Math.floor(meter.percent)}% used`,
    meter.state,
    meter.freshness === "stale" ? "Read-only cached data" : meter.period.resetsAt ? `Resets ${meter.period.resetsAt}` : null,
  ));
  const capabilityRows = Object.entries(accessState.capabilities).map(([key, capability]) => row(
    key,
    CAPABILITY_LABELS[key],
    capability.availability,
    capability.availability,
    capability.reason,
  ));
  const launchActions = DESKTOP_LAUNCH_ACTIONS.map((action) => Object.freeze({
    action,
    label: ACTION_LABELS[action],
    ...accessState.launchActions[action],
  }));
  const portalActions = PORTAL_DESTINATIONS.map((destination) => Object.freeze({
    destination,
    label: PORTAL_ACTIONS[destination].label,
  }));
  return Object.freeze({
    kind: "thrallo-desktop-access-foundation",
    schemaVersion: "1.0",
    title: "Thrallo account and access",
    sections: Object.freeze({
      account: Object.freeze(accountRows),
      entitlement: Object.freeze([
        row("status", "Entitlement", accessState.entitlement.state, accessState.entitlement.state),
        row("freshness", "Entitlement data", accessState.entitlement.freshness, accessState.entitlement.freshness),
      ]),
      usage: Object.freeze(usageRows),
      capabilities: Object.freeze(capabilityRows),
    }),
    launchActions: Object.freeze(launchActions),
    portalActions: Object.freeze(portalActions),
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRows(rows) {
  return rows.map((item) => `<li data-state="${escapeHtml(item.state || "")}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</li>`).join("");
}

export function renderDesktopAccessHtml(presentation) {
  if (presentation?.kind !== "thrallo-desktop-access-foundation") throw new TypeError("Unknown desktop access presentation");
  const sections = [
    ["Account", presentation.sections.account],
    ["Entitlement", presentation.sections.entitlement],
    ["Usage", presentation.sections.usage],
    ["Capabilities", presentation.sections.capabilities],
  ].map(([title, rows]) => `<section><h2>${escapeHtml(title)}</h2><ul>${renderRows(rows)}</ul></section>`).join("");
  const launch = presentation.launchActions.map((action) => `<button type="button" data-launch-action="${escapeHtml(action.action)}" data-state="${escapeHtml(action.state)}"${action.allowed ? "" : " disabled"}>${escapeHtml(action.label)}<span>${escapeHtml(action.reason)}</span></button>`).join("");
  const portal = presentation.portalActions.map((action) => `<button type="button" data-portal-destination="${escapeHtml(action.destination)}">${escapeHtml(action.label)}</button>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main aria-label="Thrallo account and access"><h1>${escapeHtml(presentation.title)}</h1>${sections}<section><h2>Launch</h2><div>${launch}</div></section><section><h2>Portal</h2><div>${portal}</div></section></main></body></html>`;
}
