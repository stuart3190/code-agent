// Deployment status vocabulary, shared by the server and the web app.
//
// The same reason publishResolution.mjs and operationalState.mjs exist. DeploymentsView kept its
// own STATUS_LABEL map and its own idea of which statuses are still moving; the publish panel
// needed both; and deploymentService.mjs defined the statuses themselves. Three copies of one
// vocabulary is how a tab and a panel come to disagree about what "superseded" means.

export const DEPLOY_STATUS = Object.freeze({
  building: "building",
  deploying: "deploying",
  live: "live",
  failed: "failed",
  rolledBack: "rolled_back",
  superseded: "superseded",
});

export const DEPLOY_LABEL = Object.freeze({
  building: "Building",
  deploying: "Deploying",
  live: "Live",
  failed: "Failed",
  rolled_back: "Rolled back",
  superseded: "Superseded",
});

export const DEPLOY_TONE = Object.freeze({
  building: "building", deploying: "building", live: "live",
  failed: "failed", rolled_back: "update", superseded: "muted",
});

/**
 * The statuses a deployment stops moving from.
 *
 * Anything polling for progress must stop here rather than waiting for a change that will never
 * come — a surface that keeps asking after a deployment has failed is a surface that will ask
 * forever.
 */
export const TERMINAL_STATUSES = Object.freeze([
  DEPLOY_STATUS.live, DEPLOY_STATUS.failed, DEPLOY_STATUS.rolledBack, DEPLOY_STATUS.superseded,
]);

export const isDeploymentSettled = (status) => TERMINAL_STATUSES.includes(status);

// Still going out. The complement of settled for a status that exists; an unknown status is
// treated as settled, because polling on a value we do not understand would never stop.
export const isDeploymentMoving = (status) =>
  status === DEPLOY_STATUS.building || status === DEPLOY_STATUS.deploying;
