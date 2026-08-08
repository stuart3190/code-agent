#!/usr/bin/env node

// Installs a replacement Supabase secret into the two approved runtime stores.
// The replacement is accepted only on stdin and is never printed or persisted
// outside the destination files.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const targets = [
  "/home/ubuntu/code-agent/shell/.env",
  "/etc/thrallo/build-worker.env",
];
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

if (process.argv[2] === "--hashes") {
  const hashes = targets.map((target) => {
    const content = fs.readFileSync(target, "utf8");
    const matches = [...content.matchAll(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/gm)];
    if (matches.length !== 1) throw new Error(`${target}: expected one service key assignment`);
    return { target, hash: sha256(matches[0][1].replace(/\r$/, "")) };
  });
  process.stdout.write(`${JSON.stringify({ hashes })}\n`);
  process.exit(0);
}

const expectedOldHash = process.argv[2];
if (!/^[a-f0-9]{64}$/i.test(expectedOldHash || "")) {
  throw new Error("expected old SHA-256 is required");
}

const replacement = fs.readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
if (!replacement.startsWith("sb_secret_") || replacement.length < 30) {
  throw new Error("replacement is not a Supabase secret key");
}
const replacementHash = sha256(replacement);

function parseCurrent(content, target) {
  const matches = [...content.matchAll(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/gm)];
  if (matches.length !== 1) throw new Error(`${target}: expected one service key assignment`);
  return matches[0][1].replace(/\r$/, "");
}

const inspected = targets.map((target) => {
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${target}: unsafe target`);
  const content = fs.readFileSync(target, "utf8");
  const current = parseCurrent(content, target);
  if (sha256(current) !== expectedOldHash.toLowerCase()) {
    throw new Error(`${target}: current credential hash does not match approved incident key`);
  }
  return { target, stat, content };
});

for (const { target, stat, content } of inspected) {
  const updated = content.replace(
    /^SUPABASE_SERVICE_ROLE_KEY=.*$/m,
    `SUPABASE_SERVICE_ROLE_KEY=${replacement}`,
  );
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.package10e-${process.pid}`);
  const fd = fs.openSync(temp, "wx", stat.mode & 0o777);
  try {
    fs.writeFileSync(fd, updated, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.fchownSync(fd, stat.uid, stat.gid);
    fs.fchmodSync(fd, stat.mode & 0o777);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);
  const directoryFd = fs.openSync(path.dirname(target), "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  oldHash: expectedOldHash.toLowerCase(),
  replacementHash,
  targets: inspected.map(({ target, stat }) => ({
    target,
    mode: (stat.mode & 0o777).toString(8),
    uid: stat.uid,
    gid: stat.gid,
  })),
})}\n`);
