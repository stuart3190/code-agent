import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import {
  aiConnectionSummary,
  connectApiKey,
  disconnectAiProvider,
  selectAiProvider,
} from "../lib/aiCredentialStore.mjs";
import {
  cancelCodexLogin,
  codexLoginStatus,
  startCodexLogin,
} from "../lib/codexLogin.mjs";

export async function handleAiConnections(_req, res, owner) {
  return sendJson(res, 200, await aiConnectionSummary(owner.id));
}

export async function handleAiByokConnect(_req, res, owner, body = {}) {
  return wrap(async () => {
    const connection = await connectApiKey(owner.id, body.provider, body.key);
    sendJson(res, 200, {
      connection,
      ...(await aiConnectionSummary(owner.id)),
    });
  });
}

export async function handleAiProviderSelect(_req, res, owner, body = {}) {
  return wrap(async () => {
    sendJson(res, 200, await selectAiProvider(owner.id, body.provider));
  });
}

export async function handleAiProviderDisconnect(_req, res, owner, body = {}) {
  return wrap(async () => {
    sendJson(res, 200, await disconnectAiProvider(owner.id, body.provider));
  });
}

export async function handleCodexLoginStart(_req, res, owner) {
  return wrap(async () => {
    sendJson(res, 201, await startCodexLogin(owner.id));
  });
}

export async function handleCodexLoginStatus(_req, res, owner, sessionId) {
  return wrap(async () => {
    sendJson(res, 200, await codexLoginStatus(owner.id, sessionId));
  });
}

export async function handleCodexLoginCancel(_req, res, owner, sessionId) {
  return wrap(async () => {
    sendJson(res, 200, await cancelCodexLogin(owner.id, sessionId));
  });
}

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.status || error.code) {
      throw new CodeAgentInputError(
        error.message,
        error.status || 400,
        error.code || "ai_connection_failed",
      );
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
