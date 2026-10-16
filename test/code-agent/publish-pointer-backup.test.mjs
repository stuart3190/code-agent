import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { inventoryFilesystemRoot, readInventoriedFile, restoreFilesystemLayout, validatePublishPointer } from "../../ops/lib/filesystemBackup.mjs";

test("backup and restore immutable publication pointers and custom aliases without following them", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "publish-backup-proof-"));
  try {
    const root = path.join(temp, "source");
    for (const dir of [".thrallo/releases/owner/project/release", ".thrallo/sites/site", "_domains"]) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, ".thrallo/releases/owner/project/release/index.html"), "<h1>retained</h1>");
    await symlink("../../releases/owner/project/release", path.join(root, ".thrallo/sites/site/current"));
    await symlink("../.thrallo/sites/site/current", path.join(root, "_domains/site.example"));
    await assert.rejects(inventoryFilesystemRoot(root), /refuses symlink/);
    const inventory = await inventoryFilesystemRoot(root, { allowPublishPointers: true });
    assert.equal(inventory.files.length, 1, "artifact bytes are inventoried once, never through pointers");
    assert.equal(inventory.symlinks.length, 2);
    const bodies = new Map();
    const files = [];
    for (const file of inventory.files) {
      const bytes = await readInventoriedFile(file); bodies.set(file.relative, bytes);
      files.push({ root: "publish", relativePath: file.relative, mode: file.mode, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const target = path.join(temp, "restore");
    await restoreFilesystemLayout({ filesystemRoot: target, files,
      directories: inventory.directories.map(d => ({ root: "publish", relativePath: d.relative, mode: d.mode })),
      symlinks: inventory.symlinks.map(l => ({ root: "publish", relativePath: l.relative, target: l.target })).reverse(),
      readObject: async object => bodies.get(object.relativePath),
    });
    assert.equal(await readlink(path.join(target, "publish/.thrallo/sites/site/current")), "../../releases/owner/project/release");
    assert.equal(await readFile(path.join(target, "publish/_domains/site.example/index.html"), "utf8"), "<h1>retained</h1>");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("publish backup refuses arbitrary links, absolute targets and traversal", () => {
  for (const [relative, target] of [["link", "safe"], [".thrallo/sites/site/current", "/etc"],
    [".thrallo/sites/site/current", "../../releases/owner/../private"], ["_domains/site.example", "../../private"]]) {
    assert.throws(() => validatePublishPointer(relative, target), /unrecognized publish symlink/);
  }
});

test("publish pointer cannot hide an external directory behind a valid target shape", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "publish-escape-proof-"));
  try {
    const root = path.join(temp, "source");
    await mkdir(path.join(root, ".thrallo/sites/site"), { recursive: true });
    await mkdir(path.join(root, ".thrallo/releases/owner/project"), { recursive: true });
    await mkdir(path.join(temp, "external"));
    await symlink(path.join(temp, "external"), path.join(root, ".thrallo/releases/owner/project/release"));
    await symlink("../../releases/owner/project/release", path.join(root, ".thrallo/sites/site/current"));
    await assert.rejects(inventoryFilesystemRoot(root, { allowPublishPointers: true }), /unrecognized|escapes root/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});


test("worker backup records only image-owned dependency links as rebuildable exclusions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-backup-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "project/package.json"), "{}");
    await symlink("/opt/scaffold/node_modules", path.join(root, "project/node_modules"));
    await assert.rejects(inventoryFilesystemRoot(root), /refuses symlink/);
    const inventory = await inventoryFilesystemRoot(root, { omitSandboxDependencies: true });
    assert.equal(inventory.files.length, 1);
    assert.deepEqual(inventory.exclusions, [{ relative: "project/node_modules", reason: "sandbox_image_dependencies", target: "/opt/scaffold/node_modules" }]);
    await symlink("/etc", path.join(root, "project/secrets"));
    await assert.rejects(inventoryFilesystemRoot(root, { omitSandboxDependencies: true }), /refuses symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
