-- PR4: the implementation contract, stored against the build that was judged by it.
--
-- `plan` is prose and stays as it is — it is what a human reads. `contract` is the machine-readable
-- form the generator, the repair agent and the journey verifier all work from, so that "did this
-- build do what was agreed" has a single answer rather than three opinions.
alter table public.diag_runs add column if not exists contract jsonb;

comment on column public.diag_runs.contract is
  'Implementation contract (PR4): journeys, entities, operations, states, acceptance tests and deferred items. Null for builds that predate it or whose contract could not be produced.';

-- Finding the builds that have no contract is an operational question ("is the contract step
-- actually running?"), so make it cheap to ask.
create index if not exists diag_runs_contract_missing_idx
  on public.diag_runs (created_at desc)
  where contract is null;
