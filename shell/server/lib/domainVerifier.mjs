// Background verification for custom domains.
//
// DNS propagates on its own schedule, so a domain added at 9am may only become correct at 11am.
// Without this the user would have to sit on the settings panel pressing Retry. It also re-checks
// active domains occasionally, so a domain whose DNS is later removed stops claiming to be Active.

import { unsettledDomains, verifyDomain } from "./customDomains.mjs";
import { attachDomain } from "./appBuild/appPublishService.mjs";

const TICK_MS = 60_000;
let timer = null;

export async function sweepDomains({ verify = verifyDomain, list = unsettledDomains } = {}) {
  const rows = await list();
  let checked = 0;
  for (const row of rows) {
    try {
      await verify(row.owner, row.domain, { attach: attachDomain });
      checked += 1;
    } catch (error) {
      // One bad domain must not stop the sweep for everyone else.
      console.error(`[domain-verifier] ${row.domain}: ${error?.message || error}`);
    }
  }
  return { checked };
}

export function startDomainVerifier() {
  if (timer) return;
  timer = setInterval(() => {
    sweepDomains().catch((error) => console.error(`[domain-verifier] ${error?.message || error}`));
  }, TICK_MS);
  timer.unref?.();
}

export function stopDomainVerifier() {
  if (timer) clearInterval(timer);
  timer = null;
}
