-- Historical verifier evidence must retain the policy that interpreted it. Existing rows predate
-- the minimal contract-only verifier and therefore keep the legacy policy; every new Builder V2
-- entry point explicitly writes minimal_contract_v1.
alter table public.bv2_builds
  add column if not exists verifier_policy text not null default 'legacy_rich_v1';

alter table public.bv2_builds
  drop constraint if exists bv2_builds_verifier_policy_check;

alter table public.bv2_builds
  add constraint bv2_builds_verifier_policy_check
  check (verifier_policy in ('legacy_rich_v1', 'minimal_contract_v1'));

comment on column public.bv2_builds.verifier_policy is
  'Interpretation policy for this build browser evidence. Historical rows remain legacy_rich_v1; new Builder V2 builds explicitly select minimal_contract_v1.';
