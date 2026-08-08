# Executable model catalogue

Status: Package 13 authority. A model is selectable only when `modelCatalogue.mjs` proves the
provider, exact model id and billing lane have an executable adapter.

| Provider | Exact model | Tier | Executable lane | Product state |
|---|---|---|---|---|
| OpenAI | `gpt-5.6-sol` | quality | managed, BYOK | selectable |
| OpenAI | `gpt-5.6-terra` | balanced | managed, BYOK | selectable |
| OpenAI | `gpt-5.6-luna` | fast | managed, BYOK | selectable |
| Anthropic | `claude-opus-5` | quality | BYOK | selectable |
| Anthropic | `claude-sonnet-5` | balanced | BYOK | selectable |
| Anthropic | `claude-haiku-4-5-20251001` | fast | BYOK | selectable; pinned id |
| Google | `gemini-3.6-flash` | quality/balanced | BYOK | selectable |
| Google | `gemini-3.5-flash-lite` | fast | BYOK | selectable |
| xAI | `grok-4.5` | quality | BYOK | selectable when xAI policy permits |
| xAI | `grok-build-0.1` | balanced | BYOK | selectable when xAI policy permits |
| xAI | `grok-4.3` | fast | BYOK | selectable when xAI policy permits |
| Codex | `gpt-5.5` | routed by reasoning effort | connected allowance | selectable only with a Codex connection |

The capability runtime also has three non-selectable internal identities: `gpt-5.4-mini` for
text/structured actions, `gpt-5.4` for image actions, `text-embedding-3-small` for embeddings, and
Replicate `bytedance/seedance-1-pro` for the bounded video-prediction capability.
Their operation and lane are validated both when a capability is saved and immediately before
execution. They can never enter Builder V2 routing or the model selector. Arbitrary capability
model overrides are rejected.

`claude-opus-4-8`, `claude-sonnet-4-6`, and the ambiguous `claude-haiku-4-5` alias are retained
only as hidden compatibility identities for historical configuration/telemetry. They are not
advertised. Arbitrary environment-supplied ids are rejected as `model_configuration_invalid`.

The persisted selection syntax is `lane:provider:model`, optionally suffixed with `#mode`. Manual
selection never changes lane or provider. `Auto` may choose another model only from executable
candidates already permitted by the pinned billing policy. Unknown model, lane, provider or
reasoning combinations fail deterministically; no adapter default or managed credential is used as
a substitute.

Reasoning tokens remain a subset of output tokens for providers that expose both. They are retained
as diagnostic telemetry but are not added to output again for billing. Cached input uses the
provider's cache multiplier. Provider request ids and the canonical identity ride with each durable
reservation and settlement.
