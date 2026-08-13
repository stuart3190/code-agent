// Builder V2 is the exclusive application builder. This emergency stop is intentionally the
// only remaining Builder-version switch and is evaluated on every admission without caching.

export function killSwitchActive(env = process.env) {
  return env.THRALLO_BV2_KILL === "1";
}
