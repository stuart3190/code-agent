import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import { createApiToken, listApiTokens, revokeApiToken } from "../lib/apiTokens.mjs";

export async function handleTokenList(_req, res, owner) {
  return sendJson(res, 200, { tokens: await listApiTokens(owner.id) });
}

export async function handleTokenCreate(_req, res, owner, body = {}) {
  return wrap(async () => {
    const created = await createApiToken(owner.id, body.name);
    sendJson(res, 201, { ...created, tokens: await listApiTokens(owner.id) });
  });
}

export async function handleTokenRevoke(_req, res, owner, tokenId) {
  return wrap(async () => {
    await revokeApiToken(owner.id, tokenId);
    sendJson(res, 200, { tokens: await listApiTokens(owner.id) });
  });
}

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "token_request_failed");
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
