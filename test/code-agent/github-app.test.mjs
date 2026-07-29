import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createPullRequest, githubAppConfigured, listInstallationRepositories, signInstallationState,
  verifyGithubWebhook, verifyInstallationState,
} from "../../shell/server/lib/githubApp.mjs";

test("GitHub installation state is signed, expiring, and tamper evident", (t) => {
  configureGithub(t);
  const state = signInstallationState({ ownerId: "owner-1", exp: Date.now() + 60_000, nonce: "nonce" });
  assert.equal(verifyInstallationState(state).ownerId, "owner-1");
  assert.throws(() => verifyInstallationState(`${state}tampered`), /invalid or expired/i);
  const expired = signInstallationState({ ownerId: "owner-1", exp: Date.now() - 1, nonce: "nonce" });
  assert.throws(() => verifyInstallationState(expired), /invalid or expired/i);
});

test("GitHub repository discovery mints an installation token without exposing it", async (t) => {
  configureGithub(t);
  const requests = [];
  const repositories = await listInstallationRepositories(42, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/app/installations/42/access_tokens")) {
      return jsonResponse({ token: "short-lived-secret", expires_at: "2026-07-29T15:00:00Z" });
    }
    return jsonResponse({ repositories: [{
      id: 9, full_name: "example/repo", private: true, default_branch: "main",
      clone_url: "https://github.com/example/repo.git", permissions: { pull: true },
    }] });
  });
  assert.equal(githubAppConfigured(), true);
  assert.deepEqual(repositories, [{
    id: 9, fullName: "example/repo", private: true, defaultBranch: "main",
    cloneUrl: "https://github.com/example/repo.git", permissions: { pull: true },
  }]);
  assert.match(requests[1].options.headers.Authorization, /^Bearer short-lived-secret$/);
  assert.doesNotMatch(JSON.stringify(repositories), /short-lived-secret/);
});

test("GitHub webhook signatures are verified with constant-shape HMAC input", (t) => {
  configureGithub(t);
  const body = Buffer.from(JSON.stringify({ action: "created", installation: { id: 42 } }));
  const signature = `sha256=${createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  assert.equal(verifyGithubWebhook(body, signature), true);
  assert.throws(() => verifyGithubWebhook(body, `${signature.slice(0, -1)}0`), /signature is invalid/i);
});

test("approved publication creates a pull request with an installation token", async (t) => {
  configureGithub(t);
  const requests = [];
  const pullRequest = await createPullRequest({
    installationId: 42,
    repository: "example/repo",
    head: "code-agent/abc123",
    base: "main",
    title: "Apply verified changes",
    body: "Tests passed.",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/app/installations/42/access_tokens")) {
        return jsonResponse({ token: "short-lived-secret" });
      }
      return jsonResponse({ number: 7, html_url: "https://github.com/example/repo/pull/7", state: "open", title: "Apply verified changes" }, 201);
    },
  });
  assert.equal(pullRequest.number, 7);
  assert.equal(requests[1].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    title: "Apply verified changes",
    head: "code-agent/abc123",
    base: "main",
    body: "Tests passed.",
  });
  assert.match(requests[1].options.headers.Authorization, /^Bearer short-lived-secret$/);
});

function configureGithub(t) {
  const previous = {};
  for (const key of [
    "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_STATE_SECRET", "GITHUB_WEBHOOK_SECRET",
  ]) {
    previous[key] = process.env[key];
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_SLUG = "code-agent-test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.GITHUB_APP_STATE_SECRET = "test-state-secret-with-enough-entropy";
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret-with-enough-entropy";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
