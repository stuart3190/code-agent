import { optionalEnv } from "../lib/env.mjs";
import {
  beginConnectorOAuth, connectorOverview, disconnectConnector, finishConnectorOAuth,
  finishMetaConnectorOAuth, saveConnector, testConnector,
} from "../lib/connectors.mjs";
import {
  deleteConnectorWorkflow, listConnectorWorkflows, saveConnectorWorkflow,
} from "../lib/connectorWorkflows.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function known(error) {
  return ["bad_connector", "bad_workflow", "feature_unavailable", "feature_not_allowed"].includes(error?.code);
}

export async function handleConnectorOverview(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const result = await connectorOverview(owner, projectId);
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}

export async function handleConnectorSave(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const result = await saveConnector(owner, body.projectId, body);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (known(error)) return json(res, 400, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleConnectorTest(req, res, body, owner) {
  if (!body?.projectId || !body?.provider) return json(res, 400, { error: "projectId and provider are required" });
  try {
    const result = await testConnector(owner, body.projectId, body.provider);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (known(error)) return json(res, 400, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleConnectorDisconnect(req, res, body, owner) {
  if (!body?.projectId || !body?.provider) return json(res, 400, { error: "projectId and provider are required" });
  try {
    const result = await disconnectConnector(owner, body.projectId, body.provider);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (known(error)) return json(res, 400, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleConnectorOAuthStart(req, res, body, owner) {
  if (!body?.projectId || !body?.provider) return json(res, 400, { error: "projectId and provider are required" });
  try {
    const result = await beginConnectorOAuth(owner, body.projectId, body.provider);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (known(error)) return json(res, 400, { error: error.message, code: error.code });
    throw error;
  }
}

function callbackPage(payload) {
  const appOrigin = new URL(optionalEnv("APP_URL", "https://buildr101.com")).origin;
  const data = JSON.stringify({ __buildrConnector: true, ...payload }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connector</title></head>
<body style="margin:0;background:#0b1020;color:#e2e8f0;font:15px system-ui;display:grid;min-height:100vh;place-items:center">
<main style="max-width:420px;padding:32px;text-align:center"><h1 style="font-size:20px">${payload.ok ? "Connected" : "Connection failed"}</h1>
<p style="color:#94a3b8">${payload.ok ? "You can close this window and return to Buildr101." : "Return to Buildr101 and try again."}</p></main>
<script>try{if(window.opener){window.opener.postMessage(${data},${JSON.stringify(appOrigin)});setTimeout(()=>window.close(),250)}}catch(e){}</script></body></html>`;
}

export async function handleConnectorOAuthCallback(req, res, url) {
  try {
    const result = await finishConnectorOAuth(url);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(callbackPage({ ok: true, ...result }));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(callbackPage({ ok: false, error: String(error.message || error).slice(0, 300) }));
  }
}

export async function handleMetaConnectorOAuthCallback(req, res, url) {
  try {
    const result = await finishMetaConnectorOAuth(url);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(callbackPage({ ok: true, ...result }));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(callbackPage({ ok: false, error: String(error.message || error).slice(0, 300) }));
  }
}

export async function handleConnectorWorkflows(req, res, { method, url, body, owner }) {
  const projectId = method === "GET" ? url.searchParams.get("projectId") : body?.projectId;
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  try {
    if (method === "GET") {
      const workflows = await listConnectorWorkflows(owner, projectId);
      return workflows ? json(res, 200, { workflows }) : json(res, 404, { error: "project not found" });
    }
    if (method === "POST") {
      const workflow = await saveConnectorWorkflow(owner, projectId, body);
      return workflow ? json(res, 200, { workflow }) : json(res, 404, { error: "project not found" });
    }
    const result = await deleteConnectorWorkflow(owner, projectId, body?.workflowId);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (known(error)) return json(res, 400, { error: error.message, code: error.code });
    throw error;
  }
}
