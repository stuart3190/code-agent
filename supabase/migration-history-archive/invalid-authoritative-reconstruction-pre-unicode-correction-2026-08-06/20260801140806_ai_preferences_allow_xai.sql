-- Same gap on the preferences table: selecting xAI as the active provider would have
-- failed immediately after connecting it.
alter table public.ca_ai_preferences drop constraint ca_ai_preferences_active_provider_check;
alter table public.ca_ai_preferences add constraint ca_ai_preferences_active_provider_check
  check (active_provider = any (array['managed'::text, 'codex'::text, 'openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text]));