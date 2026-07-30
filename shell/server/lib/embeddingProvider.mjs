import { optionalEnv } from "./env.mjs";

const endpoint = "https://api.openai.com/v1/embeddings";
const DIMENSIONS = 1536;
const MAX_INPUT_CHARACTERS = 7_500;

export function embeddingsConfigured() {
  return !!optionalEnv("OPENAI_API_KEY");
}

export function embeddingModel() {
  return optionalEnv("CODE_AGENT_EMBEDDING_MODEL", "text-embedding-3-small");
}

export async function createEmbeddings(inputs, {
  apiKey = optionalEnv("OPENAI_API_KEY"),
  model = embeddingModel(),
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) {
    const error = new Error("Repository semantic indexing requires the managed OpenAI key.");
    error.code = "embedding_setup_required";
    throw error;
  }
  const values = (inputs || []).map((value) => String(value || "").trim()).filter(Boolean);
  if (!values.length) return { embeddings: [], usage: { promptTokens: 0, totalTokens: 0 }, model };
  if (values.length > 128) throw new Error("Embedding batches are limited to 128 inputs.");
  const response = await fetchImpl(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: values.map((value) => value.slice(0, MAX_INPUT_CHARACTERS)),
      dimensions: DIMENSIONS,
      encoding_format: "float",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Embedding request failed (${response.status})`);
    error.code = payload?.error?.code || "embedding_request_failed";
    error.status = response.status;
    throw error;
  }
  const embeddings = (payload.data || [])
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((item) => item.embedding);
  if (embeddings.length !== values.length || embeddings.some((value) => value?.length !== DIMENSIONS)) {
    throw new Error("Embedding response did not match the requested inputs.");
  }
  return {
    embeddings,
    model,
    usage: {
      promptTokens: Number(payload.usage?.prompt_tokens || 0),
      totalTokens: Number(payload.usage?.total_tokens || 0),
    },
  };
}

export const EMBEDDING_DIMENSIONS = DIMENSIONS;
