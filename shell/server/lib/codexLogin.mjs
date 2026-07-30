import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { connectCodexAuth, aiCredentialStorageConfigured } from "./aiCredentialStore.mjs";
import { optionalEnv, REPO_ROOT } from "./env.mjs";

const LOGIN_TTL_MS = 10 * 60_000;
const sessions = new Map();

export class CodexAppServerClient {
  constructor({ codexHome, spawnImpl = spawn } = {}) {
    this.codexHome = codexHome;
    this.spawnImpl = spawnImpl;
    this.pending = new Map();
    this.notifications = [];
    this.nextId = 1;
    this.closed = false;
    this.stderr = "";
  }

  async start() {
    const executable = optionalEnv("CODEX_BIN") || path.join(
      REPO_ROOT,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    this.process = this.spawnImpl(executable, ["app-server", "--listen", "stdio://"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
    this.process.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4_000);
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code) => {
      if (!this.closed) this.failAll(new Error(`Codex app-server stopped unexpectedly (${code ?? "unknown"}).`));
    });
    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.onLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "thrallo",
        title: "Thrallo",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
    return this;
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed."));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ method, id, params });
    return promise;
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      this.notifications.push(message);
      if (this.notifications.length > 100) this.notifications.shift();
    }
  }

  latestNotification(method, predicate = () => true) {
    return [...this.notifications].reverse()
      .find((message) => message.method === method && predicate(message.params || {})) || null;
  }

  failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("Codex app-server closed."));
    this.process?.kill();
  }
}

export async function startCodexLogin(owner, {
  clientFactory = (options) => new CodexAppServerClient(options),
} = {}) {
  if (!aiCredentialStorageConfigured()) {
    throw serviceError(
      "Encrypted credential storage is not configured on the server.",
      "credential_storage_unavailable",
      503,
    );
  }
  await cancelOwnerSession(owner);
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "thrallo-codex-login-"));
  await chmod(codexHome, 0o700);
  const client = clientFactory({ codexHome });
  try {
    await client.start();
    const login = await client.request("account/login/start", { type: "chatgptDeviceCode" });
    if (!login?.loginId || !login?.verificationUrl || !login?.userCode) {
      throw new Error("Codex did not return a device login.");
    }
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      owner,
      codexHome,
      client,
      loginId: login.loginId,
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      timer: null,
    };
    session.timer = setTimeout(() => cleanupSession(session), LOGIN_TTL_MS);
    session.timer.unref?.();
    sessions.set(sessionId, session);
    return publicLogin(session, "pending");
  } catch (error) {
    client.close?.();
    await rm(codexHome, { recursive: true, force: true });
    throw withStatus(error, 502, "codex_login_start_failed");
  }
}

export async function codexLoginStatus(owner, sessionId, {
  credentialStore,
} = {}) {
  const session = ownedSession(owner, sessionId);
  if (Date.now() >= session.expiresAt) {
    await cleanupSession(session);
    throw serviceError("Codex login expired. Start again.", "codex_login_expired", 410);
  }
  const completed = session.client.latestNotification?.(
    "account/login/completed",
    (params) => params.loginId === session.loginId,
  );
  if (completed && completed.params?.success === false) {
    const message = safeLoginError(completed.params?.error);
    await cleanupSession(session);
    throw serviceError(message, "codex_login_failed", 400);
  }

  const result = await session.client.request("account/read", { refreshToken: false });
  if (result?.account?.type !== "chatgpt") return publicLogin(session, "pending");

  const authJson = await readFile(path.join(session.codexHome, "auth.json"), "utf8");
  const credential = await connectCodexAuth(owner, authJson, {
    email: result.account.email,
    planType: result.account.planType,
  }, credentialStore ? { store: credentialStore } : undefined);
  await cleanupSession(session);
  return {
    status: "connected",
    connection: credential,
  };
}

export async function cancelCodexLogin(owner, sessionId) {
  const session = ownedSession(owner, sessionId);
  await session.client.request("account/login/cancel", { loginId: session.loginId }).catch(() => {});
  await cleanupSession(session);
  return { status: "cancelled" };
}

export async function stopCodexLoginSessions() {
  await Promise.all([...sessions.values()].map(cleanupSession));
}

async function cancelOwnerSession(owner) {
  const current = [...sessions.values()].find((session) => session.owner === owner);
  if (current) await cleanupSession(current);
}

async function cleanupSession(session) {
  if (!session) return;
  sessions.delete(session.id);
  if (session.timer) clearTimeout(session.timer);
  session.client.close?.();
  await rm(session.codexHome, { recursive: true, force: true }).catch(() => {});
}

function ownedSession(owner, sessionId) {
  const session = sessions.get(String(sessionId || ""));
  if (!session || session.owner !== owner) {
    throw serviceError("Codex login session not found.", "codex_login_not_found", 404);
  }
  return session;
}

function publicLogin(session, status) {
  return {
    status,
    sessionId: session.id,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function safeLoginError(value) {
  const text = String(value || "").trim();
  return text && text.length <= 500 ? text : "Codex sign-in did not complete.";
}

function serviceError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function withStatus(error, status, code) {
  error.status ||= status;
  error.code ||= code;
  return error;
}

export const _internal = { sessions };
