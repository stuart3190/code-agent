-- Trigger functions do not need Data API roles to hold EXECUTE directly. Keep the privileged
-- project-cap check available to its BEFORE INSERT trigger while removing the public RPC surface.
revoke execute on function public.enforce_project_cap() from public, anon, authenticated;
