#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <evidence-directory>" >&2
  exit 2
fi

evidence_dir=$(realpath -m "$1")
mkdir -p "$evidence_dir/container-logs"
chmod 0700 "$evidence_dir"
date -u +'%Y-%m-%dT%H:%M:%S.%3NZ' > "$evidence_dir/log-archive-time-utc.txt"
sudo /usr/local/sbin/thrallo-disposable-supabase-isolation status > "$evidence_dir/isolation-rule-status.txt"
sudo iptables -S DOCKER-USER > "$evidence_dir/iptables-docker-user-v4.txt"
sudo ip6tables -S DOCKER-USER > "$evidence_dir/iptables-docker-user-v6.txt"
ss -ltnp > "$evidence_dir/listening-sockets.txt"
docker ps --no-trunc --format '{{json .}}' > "$evidence_dir/docker-containers.jsonl"

mapfile -t containers < <(docker ps --filter name=supabase_ --format '{{.ID}}')
for id in "${containers[@]}"; do
  name=$(docker inspect --format '{{.Name}}' "$id" | sed 's#^/##')
  docker inspect "$id" > "$evidence_dir/container-logs/${name}.inspect.json"
  docker logs --timestamps "$id" > "$evidence_dir/container-logs/${name}.stdout.log" \
    2> "$evidence_dir/container-logs/${name}.stderr.log" || true
done

find "$evidence_dir" -type f ! -name SHA256SUMS.partial -print0 | sort -z | xargs -0 sha256sum > "$evidence_dir/SHA256SUMS.partial"
