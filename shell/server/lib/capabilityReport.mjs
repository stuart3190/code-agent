// What this deployment can and cannot do, stated at boot.
//
// Optional features degrade silently by design, which is right for a customer and wrong for an
// operator. `PEXELS_API_KEY` was unset in production for an unknown length of time; the only trace
// was one line buried inside each individual build —
//
//   design: photography unavailable (PEXELS_API_KEY is not configured)
//
// — so every generated app shipped without photography and nobody knew. The information existed and
// was never anywhere an operator would look.
//
// This prints the full picture once, at startup, in the service log: what is on, what is off, and
// the exact variable that would turn each one on. Degrading gracefully and degrading invisibly are
// not the same thing.

import { imagesConfigured } from "./images.mjs";
import { geoipStatus } from "./analytics/geoip.mjs";
import { encryptedStorageConfigured } from "./secretCrypto.mjs";

// Only the variable NAME is ever read or printed. No value from any of these is logged.
function capabilities() {
  let geoip = { available: false, detail: "THRALLO_MAXMIND_LICENSE_KEY is not set" };
  try {
    const status = geoipStatus();
    geoip = status?.available
      ? { available: true, detail: status.builtAt ? `database built ${status.builtAt}` : "database loaded" }
      : { available: false, detail: status?.reason || "THRALLO_MAXMIND_LICENSE_KEY is not set" };
  } catch {
    geoip = { available: false, detail: "geoip status unavailable" };
  }

  return [
    {
      name: "photography",
      available: imagesConfigured(),
      // The consequence, not just the fact — "no key" does not tell an operator what breaks.
      consequence: "generated apps are built without photographs",
      detail: "PEXELS_API_KEY is not set",
    },
    {
      name: "country analytics",
      available: geoip.available,
      consequence: "visits are recorded without a country",
      detail: geoip.detail,
    },
    {
      name: "encrypted connector storage",
      available: encryptedStorageConfigured(),
      consequence: "connector credentials cannot be stored",
      detail: "BYOK_ENC_KEY is not set",
    },
  ];
}

/**
 * Print the report. Returns the capability list so a health endpoint or a proof can assert on it
 * rather than parse the log.
 */
export function reportCapabilities({ log = console } = {}) {
  const list = capabilities();
  const off = list.filter((c) => !c.available);
  const on = list.filter((c) => c.available).map((c) => c.name);

  if (on.length) log.log(`[capability] enabled: ${on.join(", ")}`);
  for (const capability of off) {
    // warn, not log: an operator filtering for warnings should see this.
    log.warn(`[capability] DISABLED: ${capability.name} — ${capability.consequence} (${capability.detail})`);
  }
  if (!off.length) log.log("[capability] all optional capabilities are configured");
  return list;
}

export { capabilities };
