#!/bin/sh
set -eu

evidence_dir=/home/ubuntu/thrallo-deploy-evidence/package10e-infrastructure-recovery-20260808
index_path="$evidence_dir/evidence-index.sha256"
temporary_index=$(mktemp /tmp/package10e-evidence-index.XXXXXX)
trap 'rm -f "$temporary_index"' EXIT

if find "$evidence_dir" -type l -print -quit | grep -q .; then
  echo "refusing to index symlinked evidence" >&2
  exit 1
fi

find "$evidence_dir" -type f ! -name evidence-index.sha256 \
  -exec sha256sum '{}' ';' | sort > "$temporary_index"
install -o root -g root -m 0400 "$temporary_index" "$index_path"
sha256sum "$index_path"
