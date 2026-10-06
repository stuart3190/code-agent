-- Widen bv2_builds.verifier_policy to match live Builder V2 verificationMode.mjs
-- which writes smoke_v1 (useVerifier:true) and bypassed_v1 (useVerifier:false).
-- Previous check from 20260825105631 only allowed legacy_rich_v1, minimal_contract_v1.

alter table public.bv2_builds drop constraint if exists bv2_builds_verifier_policy_check;
alter table public.bv2_builds add constraint bv2_builds_verifier_policy_check
  check (verifier_policy in ('legacy_rich_v1','minimal_contract_v1','smoke_v1','bypassed_v1'));
