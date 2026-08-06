-- xAI/Grok was added to the application in PR #90 but the credential table's CHECK
-- constraints still only allowed the original providers, so a valid xai- key was rejected
-- by the database. Widen both constraints to include xai as an api_key provider.
alter table public.ca_ai_credentials drop constraint ca_ai_credentials_provider_check;
alter table public.ca_ai_credentials add constraint ca_ai_credentials_provider_check
  check (provider = any (array['codex'::text, 'openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text]));

alter table public.ca_ai_credentials drop constraint ca_ai_credentials_provider_auth_check;
alter table public.ca_ai_credentials add constraint ca_ai_credentials_provider_auth_check
  check (
    ((provider = 'codex'::text) and (auth_mode = 'chatgpt'::text))
    or ((provider = any (array['openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text])) and (auth_mode = 'api_key'::text))
  );