import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");

test("disposable restore guard blocks only Docker-published TCP 55320-55327", async () => {
  const guard = await read("ops/disposable-supabase-isolation.sh");
  assert.match(guard, /PORT_RANGE="55320:55327"/);
  assert.match(guard, /--ctorigdstport "\$PORT_RANGE"/);
  assert.match(guard, /! -i lo/);
  assert.match(guard, /ensure_rule iptables/);
  assert.match(guard, /ensure_rule ip6tables/);
  assert.match(guard, /-I DOCKER-USER 1/);
});

test("restore cannot begin until the host isolation guard is present", async () => {
  const restore = await read("ops/run-isolated-restore.sh");
  const guard = restore.indexOf("disposable-supabase-isolation.sh\" status");
  const restoreCall = restore.indexOf("restore-thrallo.mjs");
  assert.ok(guard >= 0, "restore wrapper must verify the host firewall guard");
  assert.ok(restoreCall > guard, "guard verification must happen before production bytes are restored");
});

test("isolation persists at boot and external proof covers every disposable port", async () => {
  const unit = await read("ops/systemd/thrallo-disposable-supabase-isolation.service");
  assert.match(unit, /After=docker\.service/);
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.match(unit, /ExecStart=.* ensure/);

  const probe = await read("ops/Test-DisposableSupabaseExternalIsolation.ps1");
  assert.match(probe, /\$ports = 55320\.\.55327/);
  assert.match(probe, /if \(\$successes -ne 0\)/);
  assert.match(probe, /exit 1/);
});

test("restore access logs are archived outside normal stack cleanup", async () => {
  const archive = await read("ops/archive-disposable-supabase-logs.sh");
  assert.match(archive, /docker logs --timestamps/);
  assert.match(archive, /docker inspect/);
  assert.match(archive, /iptables -S DOCKER-USER/);
  assert.match(archive, /sha256sum/);
});
