-- Phase 11 review agents: a run can target a pull request for repository-aware review.
-- The column is presentation-safe metadata on the owner-readable runs table.

alter table public.ca_runs
  add column pull_request bigint
    check (pull_request is null or pull_request > 0);
