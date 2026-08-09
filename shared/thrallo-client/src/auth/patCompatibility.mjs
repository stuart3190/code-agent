export const AUTH_CONNECTION_METHODS = Object.freeze({
  preferred: "native_browser_pkce",
  legacy: "legacy_manual_pat",
});

export function createLegacyPatConnection({ getPat } = {}) {
  if (typeof getPat !== "function") throw new TypeError("Legacy PAT connection requires a host-supplied secure token reader");
  return Object.freeze({
    mode: AUTH_CONNECTION_METHODS.legacy,
    preferred: false,
    async getAuthHeaders() {
      const pat = await getPat();
      if (!pat) return {};
      if (!String(pat).startsWith("thrallo_pat_")) throw new TypeError("Legacy manual token is invalid");
      return { authorization: `Bearer ${pat}` };
    },
  });
}
