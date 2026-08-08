#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
backup_root="${THRALLO_BACKUP_DIR:-/home/ubuntu/thrallo-backups}"
evidence_root="${THRALLO_RESTORE_EVIDENCE_DIR:-/home/ubuntu/thrallo-restore-evidence}"
public_host="${THRALLO_RESTORE_PUBLIC_HOST:?set the VPS public hostname/IP for the independent probe}"
probe_command="${THRALLO_EXTERNAL_PROBE_COMMAND:?set an absolute executable that probes from outside the VPS namespace}"

[[ "$probe_command" = /* && -x "$probe_command" ]] || { echo "external probe command must be an absolute executable" >&2; exit 1; }
sudo "$repo_root/ops/disposable-supabase-isolation.sh" status >/dev/null
latest=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'thrallo-*' ! -name '.incomplete-*' -printf '%f\n' | sort | tail -n1)
test -n "$latest"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence="$evidence_root/scheduled-$stamp"
filesystem_root="$evidence/restored-filesystem"
stop_file="$evidence/stop-external-probe"
mkdir -p "$evidence"

probe_pid=""
cleanup() {
  touch "$stop_file" 2>/dev/null || true
  if [[ -n "$probe_pid" ]]; then wait "$probe_pid" || true; fi
  "$repo_root/ops/archive-disposable-supabase-logs.sh" "$evidence/logs" >/dev/null 2>&1 || true
  (cd "$repo_root" && npm exec -- supabase stop --no-backup) >/dev/null 2>&1 || true
  rm -rf -- "$filesystem_root"
}
trap cleanup EXIT

printf '{"startedAt":"%s","backup":"%s"}\n' "$(date -u +%FT%TZ)" "$backup_root/$latest" > "$evidence/drill.json"
"$probe_command" --host "$public_host" --ports 55320-55327 --until-file "$stop_file" \
  --output "$evidence/external-probes.jsonl" &
probe_pid=$!

cd "$repo_root"
npm exec -- supabase start
npm run supabase:reset
"$repo_root/ops/run-isolated-restore.sh" "$repo_root" "$backup_root/$latest" "$filesystem_root"
touch "$stop_file"
wait "$probe_pid"
probe_pid=""
if grep -Eq '"(?:ok|connected|success)"[[:space:]]*:[[:space:]]*true' "$evidence/external-probes.jsonl"; then
  echo "external probe reached a disposable restore port" >&2
  exit 1
fi
printf '{"completedAt":"%s","result":"pass"}\n' "$(date -u +%FT%TZ)" >> "$evidence/drill.json"
