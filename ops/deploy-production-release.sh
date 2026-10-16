#!/usr/bin/env bash
# Activate a Thrallo source release from the worktree (procedure reconstructed 2026-09-24/25).
#   deploy.sh <new-sha> <previous-sha7> [image]     "image" rebuilds + re-pins the sandbox image
set -euo pipefail
[[ "${1:-}" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo "release requires an explicit immutable commit SHA"; exit 2; }
SHA=$(git -C /root/thrallo-codex-hotfix rev-parse "$1"); PREV7=$2; MODE=${3:-noimage}
WT=/root/thrallo-codex-hotfix; LIVE=/home/ubuntu/code-agent; S7=${SHA:0:7}
REL=/home/ubuntu/thrallo-release-$S7; PREL=/home/ubuntu/thrallo-release-$PREV7
[ ! -e "$REL/DEPLOYMENT.json" ] || { echo "refusing to overwrite finalized release $S7"; exit 2; }
PREVFULL=$(cat $LIVE/DEPLOYED_COMMIT)
[ "${PREVFULL:0:7}" = "$PREV7" ] || { echo "live is $PREVFULL, not $PREV7"; exit 1; }
[ -z "$(git -C $WT status --porcelain --untracked-files=no)" ] || { echo "worktree dirty"; exit 1; }
# Fail before creating artifacts or changing live files; policy comes from target SHA.
node "$(dirname "$0")/check-release-sandbox.mjs" "$WT" "$PREVFULL" "$SHA" "$MODE"
mkdir -p $REL
git -C $WT archive --format=tar.gz $SHA > $REL/source.tar.gz.tmp
mv $REL/source.tar.gz.tmp $REL/source.tar.gz
git -C $WT archive --format=tar.gz $SHA shell/package.json shell/server > $REL/shell.tar.gz.tmp
mv $REL/shell.tar.gz.tmp $REL/shell.tar.gz
[ -e $REL/web.tar.gz ] || ln $PREL/web.tar.gz $REL/web.tar.gz
IMGCOMMIT=$(node -e 'console.log(require("'$LIVE'/.deployment-provenance.json").sandboxImageSourceCommit)')
if [ "$MODE" = image ]; then
  IMGCOMMIT=$SHA
  rm -rf /tmp/thrallo-ctx-$S7 && mkdir /tmp/thrallo-ctx-$S7 && tar xzf $REL/source.tar.gz -C /tmp/thrallo-ctx-$S7
  docker build -q --build-arg SOURCE_COMMIT=$SHA -t thrallo-build-sandbox:${SHA:0:12} -f /tmp/thrallo-ctx-$S7/build-worker/Dockerfile /tmp/thrallo-ctx-$S7
  rm -rf /tmp/thrallo-ctx-$S7
  docker save thrallo-build-sandbox:${SHA:0:12} | gzip -1 > $REL/worker-image.tar.gz.tmp
  mv $REL/worker-image.tar.gz.tmp $REL/worker-image.tar.gz
else
  [ -e $REL/worker-image.tar.gz ] || ln $PREL/worker-image.tar.gz $REL/worker-image.tar.gz
fi
LEDGER_ARGS=(--previous-manifest "$LIVE/shell/DEPLOYMENT.json")
if [[ -n "${THRALLO_RELEASE_LEDGER:-}" ]]; then
  [[ -f "$THRALLO_RELEASE_LEDGER" ]] || { echo "migration ledger missing"; exit 1; }
  LEDGER_ARGS=(--ledger "$THRALLO_RELEASE_LEDGER")
fi
(cd $WT && node ops/create-deployment-manifest.mjs "${LEDGER_ARGS[@]}" --commit $SHA \
  --source-archive $REL/source.tar.gz --web-artifact $REL/web.tar.gz --shell-artifact $REL/shell.tar.gz \
  --worker-artifact $REL/worker-image.tar.gz --output $REL/DEPLOYMENT.json)
# Drain the exact service worker after artifacts are ready, before any live source changes.
node "$(dirname "$0")/drain-worker-for-release.mjs"
# changed files into the live tree
git -C $WT diff --name-status $PREVFULL $SHA | while read -r st f g; do
  case "$st" in
    D) rm -f "$LIVE/$f";;
    R*) rm -f "$LIVE/$f"; install -D -o ubuntu -g ubuntu -m 664 /dev/null "$LIVE/$g"; git -C $WT show "$SHA:$g" > "$LIVE/$g";;
    *) install -D -o ubuntu -g ubuntu -m 664 /dev/null "$LIVE/$f"; git -C $WT show "$SHA:$f" > "$LIVE/$f";;
  esac
done
cp -p $LIVE/shell/DEPLOYMENT.json $LIVE/shell/DEPLOYMENT.json.pre-$S7
install -o ubuntu -g ubuntu -m 444 $REL/DEPLOYMENT.json $LIVE/shell/DEPLOYMENT.json
cp -p /etc/thrallo/build-worker.env /etc/thrallo/build-worker.env.pre-$S7
(cd $LIVE && node ops/pin-build-sandbox-image.mjs --commit $SHA --image-commit $IMGCOMMIT --tag thrallo-build-sandbox:${IMGCOMMIT:0:12} --pin | tail -5)
chown ubuntu:ubuntu $LIVE/DEPLOYED_COMMIT $LIVE/.deployment-provenance.json
RESTARTED_AT=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart thrallo-build-worker thrallo-shell
echo "activated $SHA (image $IMGCOMMIT); waiting for worker preflight"
# Only a preflight of the NEW worker counts: match its startup proof, logged after the restart.
for i in $(seq 1 60); do
  if journalctl -u thrallo-build-worker --since "$RESTARTED_AT" --no-pager | grep -q '"worker_preview_isolation_preflight","reason":"startup","status":"passed"'; then break; fi; sleep 5
done
(cd $LIVE && sudo -u ubuntu node ops/verify-build-worker-release.mjs | tail -15)
