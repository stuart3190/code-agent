# SEC-20260807-DISPOSABLE-SUPABASE

Classification: **potential exposure, not confirmed breach**.

- Exposure began: `2026-08-07T09:08:10Z`.
- Shutdown began: `2026-08-07T09:09:57Z` (107-second exposure window); container removal
  completed at `2026-08-07T09:10:07Z`.
- Address and ports: `51.195.136.189`, Docker-published disposable range `55320-55327`.
  TCP `55321` was independently confirmed reachable. Not every other port had a listening
  service, so reachability of each port during the prior window is not asserted.
- Data present: the disposable restore contained the application, Auth ownership, Storage object
  metadata/content and filesystem artifact data from backup
  `thrallo-2026-08-07T090615` while verification was running.
- Credentials: disposable local-stack JWT/API/database credentials only. No production Supabase
  service-role key, database password or production JWT secret was copied into the stack.
- Evidence limitation: the containers and their access logs were destroyed during emergency
  cleanup. Third-party access cannot be conclusively ruled out, and this record does not claim
  that no access occurred.
- Corrective action: require an IPv4/IPv6 `DOCKER-USER` guard for original destination ports
  `55320-55327`, make it boot-persistent, require an independent external empty-stack proof, retain
  access logs for the restore lifetime, recreate from zero, and repeat the restore/parity proof.
- Notification assessment: the repository contains no approved incident-notification policy that
  permits an engineering-only conclusion. Security/privacy ownership must assess applicable legal
  and contractual notification thresholds. Until that review, this is internally reportable and
  customer notification is **undetermined**, not silently waived.

## Corrective-action proof

The incident is also recorded in production `diag_incidents` under reference
`SEC-20260807-DISPOSABLE-SUPABASE` (row id `eb1c21ec-6cd7-4690-8a1b-8b038e9edf6c`). The clean
retest used a boot-enabled IPv4/IPv6 `DOCKER-USER` guard. The empty stack received 72 external
connection attempts (nine per port) with zero successes. During the repeat restore, 472 attempts
(59 per port) produced zero successes. The complete restore verifier passed 72 tables/36,862 rows,
31 Auth users, 2 Storage objects, 163 filesystem objects, 38 blobs, 2 snapshots, 12 verification
cache rows and two-owner isolation.

The source backup remains at `/home/ubuntu/thrallo-backups/thrallo-2026-08-07T090615`. Plaintext
restore data and evidence were removed after verification. The retained AES-256/PBKDF2 archive is
`/home/ubuntu/thrallo-restore-evidence/2026-08-07T092100Z-isolation-repair.tar.gz.enc`, mode `0600`,
SHA-256 `2d425b57761a933cfd6ca421a8f6011ba876526dd7021db2c29efe5b811bb3f3`; its recovery key is held
separately with restricted host ACLs.
