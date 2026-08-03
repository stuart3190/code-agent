// Custom domain routes.
//
//   GET  /api/v1/projects/:projectId/domains          list + plan allowance
//   POST /api/v1/projects/:projectId/domains          { domain }  add
//   POST /api/v1/projects/:projectId/domains/verify   { domain }  re-check now
//   POST /api/v1/projects/:projectId/domains/retry    { domain }  restart after a failure
//   POST /api/v1/projects/:projectId/domains/remove   { domain }  disconnect
//
// This is NOT the retired routes/domains.mjs. That one gates on Buildr101 feature flags and a
// "Studio" tier Thrallo does not sell, and it attached domains without proving ownership. Only its
// shape was worth keeping; everything here goes through Thrallo's plans, published_sites and the
// verification gate. Every response is owner-scoped inside the library.

import {
  addDomain, listDomains, removeDomain, retryDomain, verifyDomain, domainAllowance,
} from "../lib/customDomains.mjs";
import { attachDomain, detachDomain } from "../lib/appBuild/appPublishService.mjs";

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

// Every response carries the full list and allowance, so the panel settles in one round trip and
// cannot drift from the server after an add or a removal.
async function state(owner, projectId, extra = {}) {
  return {
    ...extra,
    domains: await listDomains(owner, projectId),
    allowance: await domainAllowance(owner),
  };
}

async function wrap(res, run) {
  try {
    sendJson(res, 200, await run());
  } catch (error) {
    const status = error.status || 500;
    console.error(`[domains] ${error?.message || error}`);
    sendJson(res, status, {
      error: status === 500 ? "Something went wrong with that domain. Please try again." : error.message,
      code: error.code || "domain_failed",
    });
  }
}

export async function handleDomainsList(_req, res, owner, projectId) {
  return wrap(res, () => state(owner.id, projectId));
}

export async function handleDomainAdd(_req, res, owner, projectId, body = {}) {
  return wrap(res, async () => {
    // attachDomain travels with the add, so a domain whose DNS was already in place is attached
    // the moment it verifies instead of sitting active and unreachable.
    const added = await addDomain(owner.id, projectId, body.domain, { attach: attachDomain });
    return state(owner.id, projectId, { added });
  });
}

export async function handleDomainVerify(_req, res, owner, projectId, body = {}) {
  return wrap(res, async () => {
    await verifyDomain(owner.id, body.domain, { attach: attachDomain });
    return state(owner.id, projectId);
  });
}

export async function handleDomainRetry(_req, res, owner, projectId, body = {}) {
  return wrap(res, async () => {
    await retryDomain(owner.id, body.domain, { attach: attachDomain });
    return state(owner.id, projectId);
  });
}

export async function handleCustomDomainRemove(_req, res, owner, projectId, body = {}) {
  return wrap(res, async () => {
    await removeDomain(owner.id, body.domain, { detach: detachDomain });
    return state(owner.id, projectId);
  });
}
