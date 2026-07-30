import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryApiTokenStore, createApiToken, listApiTokens, ownerFromApiToken, revokeApiToken,
  isApiTokenBearer, TOKEN_PREFIX,
} from "../../shell/server/lib/apiTokens.mjs";

const OWNER = "44444444-4444-4444-8444-444444444444";

test("tokens are created once, hashed at rest, and authenticate their owner", async () => {
  const store = new MemoryApiTokenStore();
  const { token, record } = await createApiToken(OWNER, "vscode-laptop", { store });
  assert.ok(token.startsWith(TOKEN_PREFIX));
  assert.equal(record.name, "vscode-laptop");
  assert.ok(record.prefix.length >= 8);
  const stored = [...store.tokens.values()][0];
  assert.ok(!JSON.stringify(stored).includes(token.slice(TOKEN_PREFIX.length)));
  assert.equal(stored.token_hash.length, 64);

  const owner = await ownerFromApiToken(token, { store });
  assert.equal(owner.id, OWNER);
  assert.equal(owner.email, null);
  assert.ok(owner.viaToken);
});

test("revoked and unknown tokens are rejected; listing shows metadata only", async () => {
  const store = new MemoryApiTokenStore();
  const { token, record } = await createApiToken(OWNER, "old", { store });
  await revokeApiToken(OWNER, record.id, { store });
  assert.equal(await ownerFromApiToken(token, { store }), null);
  assert.equal(await ownerFromApiToken(`${TOKEN_PREFIX}${"0".repeat(40)}`, { store }), null);
  const listed = await listApiTokens(OWNER, { store });
  assert.equal(listed.length, 1);
  assert.ok(listed[0].revokedAt);
  assert.ok(!Object.values(listed[0]).some((value) => String(value).includes(token)));
  await assert.rejects(revokeApiToken(OWNER, record.id, { store }), /not found/);
  await assert.rejects(revokeApiToken("someone-else", record.id, { store }), /not found/);
});

test("active-token limit and name validation are enforced", async () => {
  const store = new MemoryApiTokenStore();
  for (let index = 0; index < 10; index += 1) {
    await createApiToken(OWNER, `token-${index}`, { store });
  }
  await assert.rejects(createApiToken(OWNER, "one-too-many", { store }),
    (error) => error.code === "token_limit" && error.status === 409);
  await assert.rejects(createApiToken(OWNER, "", { store }), /1-120/);
});

test("bearer detection only matches the PAT prefix", () => {
  assert.equal(isApiTokenBearer(`${TOKEN_PREFIX}abc`), true);
  assert.equal(isApiTokenBearer("eyJhbGciOi..."), false);
  assert.equal(isApiTokenBearer(null), false);
});
