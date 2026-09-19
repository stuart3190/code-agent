-- Phase 8: whether this owner has been through the first-run experience.
--
-- A column on ca_owner_profile rather than a key inside `profile_encrypted`, deliberately.
-- That blob is decrypted and injected into the Lead Agent's system prompt as
-- "MEMORY — owner profile" (leadAgentService.leadInstructions), so anything stored there is
-- something the agent reads on every single turn. "The user dismissed a tour on 6 August" is not a
-- fact about the user worth spending context on, and it is not memory — it is interface state.
--
-- Server-side rather than localStorage because the requirement is that onboarding does not
-- reappear on a second device, which is exactly what a browser-local flag cannot promise.
--
-- Shape: { "completedAt": iso, "skipped": bool, "step": int, "startedFrom": "starter-id"|null }.
-- Held as jsonb rather than columns because it is UI state that will change shape as the flow
-- does, and no query ever filters on its interior.

alter table public.ca_owner_profile
  add column if not exists onboarding jsonb not null default '{}'::jsonb;

-- ca_owner_profile has a row only once something has written a profile. Onboarding needs to be
-- readable for an owner who has never had one, and upsert handles that — but the read path must
-- not treat "no row" as "already onboarded", which is the failure that would hide the tour from
-- every genuinely new account. That rule lives in the store; this comment records why it matters.
