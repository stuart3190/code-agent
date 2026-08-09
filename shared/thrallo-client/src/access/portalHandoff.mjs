import { ThralloClientError } from "../errors.mjs";

export const PORTAL_DESTINATIONS = Object.freeze([
  "account",
  "billing",
  "usage",
  "integrations",
  "api_keys",
  "downloads",
  "recovery",
]);

export const PORTAL_ACTIONS = Object.freeze({
  account: Object.freeze({ path: "/settings/preferences", label: "Account settings" }),
  billing: Object.freeze({ path: "/settings/billing", label: "Billing" }),
  usage: Object.freeze({ path: "/settings/usage", label: "Usage" }),
  integrations: Object.freeze({ path: "/settings/preferences", label: "Integrations" }),
  api_keys: Object.freeze({ path: "/settings/keys", label: "API keys" }),
  downloads: Object.freeze({ path: "/", label: "Downloads" }),
  recovery: Object.freeze({ path: "/settings/billing", label: "Recovery" }),
});

const PORTAL_ORIGIN = "https://app.thrallo.com";

function portalUrl(destination) {
  if (typeof destination !== "string" || !PORTAL_DESTINATIONS.includes(destination)) {
    throw new ThralloClientError("Portal destination is not allowlisted.", { code: "portal_destination_rejected" });
  }
  const url = new URL(PORTAL_ACTIONS[destination].path, PORTAL_ORIGIN);
  if (url.origin !== PORTAL_ORIGIN || url.username || url.password || url.search || url.hash) {
    throw new ThralloClientError("Portal destination is unsafe.", { code: "portal_destination_rejected" });
  }
  return url;
}

export function createPortalHandoff({ openExternal } = {}) {
  if (typeof openExternal !== "function") throw new TypeError("Portal handoff requires a system-browser host action");
  let sequence = 0;
  const calls = [];

  async function open(destination) {
    const url = portalUrl(destination);
    sequence += 1;
    const descriptor = Object.freeze({ sequence, destination, label: PORTAL_ACTIONS[destination].label, pathname: url.pathname });
    calls.push(descriptor);
    await openExternal(url.toString());
    return descriptor;
  }

  return Object.freeze({
    open,
    descriptor(destination) {
      const url = portalUrl(destination);
      return Object.freeze({ destination, label: PORTAL_ACTIONS[destination].label, pathname: url.pathname });
    },
    getCalls: () => Object.freeze(calls.map((call) => Object.freeze({ ...call }))),
  });
}
