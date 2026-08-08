# Legacy Supabase service-role key migration plan

Status: plan only. Package 13 does not rotate or deactivate the legacy JWT service-role key.

All five deployed functions currently construct an admin client from
`SUPABASE_SERVICE_ROLE_KEY`: `app-auth`, `app-actions`, `app-runtime`, `app-payments`, and
`app-analytics`. Hosted Edge Functions now provide `SUPABASE_SECRET_KEYS` as a JSON map. The
replacement key is non-JWT and must be used as an API key; caller authentication must not assume it
can be verified as a user JWT.

## Function-by-function dependency

| Function | Privileged use | Inbound auth that must remain | Canary |
|---|---|---|---|
| `app-auth` | admin user/session operations and `app_users` mapping | public/auth flows keep their existing signed runtime/origin checks | signup/login/reset test app; cross-app denial |
| `app-actions` | trusted capability mutations | existing application/user authorization | one synthetic action and cross-owner denial |
| `app-runtime` | runtime configuration/data administration | signed runtime/app identity | registered app lookup plus invented-app rejection |
| `app-payments` | payment-state administration | signed webhook/user policy; no Stripe transaction in migration canary | signature rejection and read-only synthetic fixture |
| `app-analytics` | validated public beacon persistence | public collector's app/origin validation and shared limiter | registered custom/subdomain beacon; invalid app rejection |

## Zero-downtime sequence

1. Read `SUPABASE_SECRET_KEYS`, select an explicitly named key, and fail startup when the JSON or
   name is absent. During the compatibility deployment only, fall back to the legacy environment
   variable and emit a non-secret metric identifying which source was used.
2. Pin the Edge Function dependencies, run local function tests, and verify admin client operations
   with a synthetic secret key. Never put either key in fixtures, command lines, URLs, output or Git.
3. Deploy one function at a time in the order `app-analytics`, `app-actions`, `app-runtime`,
   `app-auth`, `app-payments`. Each deployment is independently reversible to its preceding function
   version.
4. Canary the matrix above and confirm the function reports the named secret-key source. A new
   secret key used to invoke a service-to-service function belongs in the `apikey` header; user JWTs
   remain in `Authorization` for user-authenticated functions.
5. After all five functions have run cleanly on the new key, remove the code fallback, redeploy one
   at a time, repeat the canaries, then separately approve revocation of the exposed legacy key.
6. Prove the legacy key fails, the named secret key succeeds, logs contain neither value, and all
   function versions/hashes are recorded in release provenance.

Rollback: before legacy revocation, redeploy the immediately previous function version. After
revocation, rollback means restoring the new-key-compatible prior artifact; never reactivate the
exposed legacy key. Key revocation is a separate production approval because all five function
canaries and their rollback artifacts must exist first.

