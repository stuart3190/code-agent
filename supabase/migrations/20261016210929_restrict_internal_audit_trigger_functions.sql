-- Internal trigger functions must not be exposed as browser RPC capabilities.
-- Existing triggers, SECURITY DEFINER ownership, RLS and all customer rows are unchanged.
-- Reversible: the former catalog grants were PUBLIC EXECUTE plus service_role EXECUTE.
-- Emergency rollback: GRANT EXECUTE ON FUNCTION <each signature below> TO PUBLIC;
revoke execute on function public.app_audit_events_append_only() from public, anon, authenticated;
revoke execute on function public.app_billing_events_append_only() from public, anon, authenticated;
revoke execute on function public.app_entities_audit() from public, anon, authenticated;

grant execute on function public.app_audit_events_append_only() to service_role;
grant execute on function public.app_billing_events_append_only() to service_role;
grant execute on function public.app_entities_audit() to service_role;
