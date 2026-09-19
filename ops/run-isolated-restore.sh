#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 || ( ${4:-} != "" && ${4:-} != "--verify-only" ) ]]; then
  echo "usage: ops/run-isolated-restore.sh <local-supabase-dir> <backup-dir> <filesystem-root> [--verify-only]" >&2
  exit 2
fi

proof_dir=$(realpath "$1")
backup_dir=$(realpath "$2")
filesystem_root=$(realpath -m "$3")
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# A loopback API URL is not sufficient: the Supabase CLI publishes the same
# container ports on every host interface. Require the Docker forwarding guard
# before any production bytes enter the disposable environment.
sudo "$repo_root/ops/disposable-supabase-isolation.sh" status >/dev/null

if [[ ${4:-} != "--verify-only" && -e "$filesystem_root" ]]; then
  echo "restore filesystem namespace already exists: $filesystem_root" >&2
  exit 1
fi

status=$(cd "$proof_dir" && npm exec -- supabase status -o env 2>/dev/null)
api_url=$(printf '%s\n' "$status" | sed -n 's/^API_URL=//p' | tr -d '"')
service_key=$(printf '%s\n' "$status" | sed -n 's/^SERVICE_ROLE_KEY=//p' | tr -d '"')
anon_key=$(printf '%s\n' "$status" | sed -n 's/^ANON_KEY=//p' | tr -d '"')
jwt_secret=$(printf '%s\n' "$status" | sed -n 's/^JWT_SECRET=//p' | tr -d '"')

if [[ ! "$api_url" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || [[ -z "$service_key" ]] || [[ -z "$anon_key" ]] || [[ -z "$jwt_secret" ]]; then
  echo "refusing restore: disposable Supabase URL/key could not be resolved safely" >&2
  exit 1
fi

if [[ ${4:-} != "--verify-only" ]]; then
  RESTORE_TARGET_URL="$api_url" \
  RESTORE_TARGET_SERVICE_KEY="$service_key" \
  RESTORE_TARGET_FILESYSTEM_ROOT="$filesystem_root" \
  node "$repo_root/ops/restore-thrallo.mjs" "$backup_dir" --confirm
fi

RESTORE_TARGET_URL="$api_url" \
RESTORE_TARGET_SERVICE_KEY="$service_key" \
RESTORE_TARGET_ANON_KEY="$anon_key" \
RESTORE_TARGET_JWT_SECRET="$jwt_secret" \
RESTORE_TARGET_FILESYSTEM_ROOT="$filesystem_root" \
node "$repo_root/ops/verify-isolated-restore.mjs" "$backup_dir"
