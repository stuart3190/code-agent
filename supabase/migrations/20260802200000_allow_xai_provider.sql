-- xAI/Grok was added to the application (PR #90) but the credential and preference tables'
-- CHECK constraints still only allowed the original providers, so a valid xai- key was
-- rejected by the database with a constraint violation ("something went wrong" to the user).
alter table public.ca_ai_credentials drop constraint ca_ai_credentials_provider_check;
alter table public.ca_ai_credentials add constraint ca_ai_credentials_provider_check
  check (provider = any (array['codex'::text, 'openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text]));

alter table public.ca_ai_credentials drop constraint ca_ai_credentials_provider_auth_check;
alter table public.ca_ai_credentials add constraint ca_ai_credentials_provider_auth_check
  check (
    ((provider = 'codex'::text) and (auth_mode = 'chatgpt'::text))
    or ((provider = any (array['openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text])) and (auth_mode = 'api_key'::text))
  );

alter table public.ca_ai_preferences drop constraint ca_ai_preferences_active_provider_check;
alter table public.ca_ai_preferences add constraint ca_ai_preferences_active_provider_check
  check (active_provider = any (array['managed'::text, 'codex'::text, 'openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text]));
