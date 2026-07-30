import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDING_DIMENSIONS,
  createEmbeddings,
} from "../../shell/server/lib/embeddingProvider.mjs";

test("embedding provider batches code inputs with a pinned vector size", async () => {
  const vectorA = Array(EMBEDDING_DIMENSIONS).fill(0);
  const vectorB = Array(EMBEDDING_DIMENSIONS).fill(0);
  vectorA[0] = 1;
  vectorB[1] = 1;
  const result = await createEmbeddings(["function authenticate() {}", "class Session {}"], {
    apiKey: "sk-test",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/embeddings");
      assert.equal(options.headers.Authorization, "Bearer sk-test");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "text-embedding-3-small");
      assert.equal(body.dimensions, 1536);
      assert.equal(body.encoding_format, "float");
      assert.deepEqual(body.input, ["function authenticate() {}", "class Session {}"]);
      return {
        ok: true,
        json: async () => ({
          data: [{ index: 1, embedding: vectorB }, { index: 0, embedding: vectorA }],
          usage: { prompt_tokens: 8, total_tokens: 8 },
        }),
      };
    },
  });
  assert.equal(result.embeddings[0][0], 1);
  assert.equal(result.embeddings[1][1], 1);
  assert.deepEqual(result.usage, { promptTokens: 8, totalTokens: 8 });
});

test("embedding provider rejects malformed vector responses", async () => {
  await assert.rejects(
    createEmbeddings(["code"], {
      apiKey: "sk-test",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
      }),
    }),
    /did not match/,
  );
});

test("embedding provider bounds each source excerpt before sending it", async () => {
  const vector = Array(EMBEDDING_DIMENSIONS).fill(0);
  await createEmbeddings(["x".repeat(20_000)], {
    apiKey: "sk-test",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.input[0].length, 7_500);
      return {
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: vector }] }),
      };
    },
  });
});
