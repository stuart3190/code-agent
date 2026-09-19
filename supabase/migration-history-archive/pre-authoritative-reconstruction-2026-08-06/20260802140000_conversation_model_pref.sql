-- Per-project model preference: which provider/model this conversation's future AI
-- requests should use ("auto" = smart routing). Changing it never rebuilds or resets.
alter table public.ca_conversations add column if not exists model_pref text;
