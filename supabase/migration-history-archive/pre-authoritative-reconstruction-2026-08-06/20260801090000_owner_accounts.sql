-- Owner accounts (internal development): staff identified by THRALLO_OWNER_EMAILS bypass
-- enforcement while usage keeps recording. preview_plan lets an owner see the product as a
-- Free/Starter/Pro customer without changing their real subscription.

alter table public.ca_subscriptions add column if not exists preview_plan text
  check (preview_plan is null or preview_plan in ('free', 'starter', 'pro'));
