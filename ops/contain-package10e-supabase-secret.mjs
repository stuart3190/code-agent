#!/usr/bin/env node

// Removes only CAS-verified plaintext copies of the revoked Package 10E key.
// The evidence contains paths and hashes, never credential bytes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const expectedRevokedHash = "364c32a12f17737e1f9786789deafed72a2824c0238dabd69f906f21349e7b9a";
const expectedReplacementHash = "c60119ab20555f675331c5d2297e802071e5d160eee81a0f5cf5714400236af3";
const evidencePath = process.argv[2];
if (!path.isAbsolute(evidencePath || "")) throw new Error("absolute evidence path is required");

const activeStores = [
  "/home/ubuntu/code-agent/shell/.env",
  "/etc/thrallo/build-worker.env",
];
const unsafeCopies = [
  "/home/ubuntu/code-agent/shell/.env.bak-prestripe-20260802125244",
  "/home/ubuntu/code-agent/shell/.env.bak-prices-20260802143750",
  "/home/ubuntu/code-agent/shell/.env.bak-webhook-1785681463043",
  "/tmp/thrallo-shell.env.upload",
];
const largeLogs = ["/var/log/syslog", "/var/log/xrdp.log"];
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function extractKey(content, target) {
  const matches = [...content.matchAll(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/gm)];
  if (matches.length !== 1) throw new Error(`${target}: expected one service key assignment`);
  return matches[0][1].replace(/\r$/, "");
}

for (const target of activeStores) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${target}: unsafe active store`);
  if (sha256(extractKey(fs.readFileSync(target, "utf8"), target)) !== expectedReplacementHash) {
    throw new Error(`${target}: replacement credential CAS failed`);
  }
}

const revokedCredential = extractKey(fs.readFileSync(unsafeCopies[0], "utf8"), unsafeCopies[0]);
if (sha256(revokedCredential) !== expectedRevokedHash) throw new Error("revoked credential CAS failed");
const needle = Buffer.from(revokedCredential, "utf8");

async function countMatchesInFile(target) {
  if (!fs.existsSync(target)) return { target, exists: false, size: 0, matches: 0 };
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${target}: unsafe log target`);
  let overlap = Buffer.alloc(0);
  let matches = 0;
  for await (const chunk of fs.createReadStream(target, { highWaterMark: 1024 * 1024 })) {
    const buffer = Buffer.concat([overlap, chunk]);
    let offset = 0;
    while ((offset = buffer.indexOf(needle, offset)) !== -1) {
      matches += 1;
      offset += needle.length;
    }
    overlap = buffer.subarray(Math.max(0, buffer.length - needle.length + 1));
  }
  return { target, exists: true, size: stat.size, matches };
}

const logResults = [];
for (const target of largeLogs) logResults.push(await countMatchesInFile(target));
if (logResults.some((entry) => entry.matches !== 0)) {
  throw new Error("revoked credential remains in a large production log");
}

const removed = [];
for (const target of unsafeCopies) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${target}: unsafe plaintext copy`);
  const content = fs.readFileSync(target);
  const key = extractKey(content.toString("utf8"), target);
  if (sha256(key) !== expectedRevokedHash) throw new Error(`${target}: row CAS failed`);
  removed.push({
    target,
    fileSha256: sha256(content),
    size: stat.size,
    mode: (stat.mode & 0o777).toString(8),
    uid: stat.uid,
    gid: stat.gid,
    mtime: stat.mtime.toISOString(),
  });
}

fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
const evidence = {
  incident: "package10e-supabase-runtime-key-exposure",
  containedAt: new Date().toISOString(),
  revokedCredentialSha256: expectedRevokedHash,
  replacementCredentialSha256: expectedReplacementHash,
  activeStores: activeStores.map((target) => ({ target, credentialSha256: expectedReplacementHash })),
  removed,
  streamedLargeLogScan: logResults,
};
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o400, flag: "wx" });
fs.chmodSync(evidencePath, 0o400);

for (const entry of removed) fs.unlinkSync(entry.target);
for (const target of unsafeCopies) {
  if (fs.existsSync(target)) throw new Error(`${target}: plaintext cleanup failed`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  evidencePath,
  evidenceSha256: sha256(fs.readFileSync(evidencePath)),
  removedCount: removed.length,
  largeLogMatches: logResults.reduce((sum, entry) => sum + entry.matches, 0),
})}\n`);
