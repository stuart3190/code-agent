import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Inventory one canonical filesystem root without crossing a symlink boundary.
 *
 * The root itself and every child directory are recorded so an isolated restore can reproduce
 * modes exactly. Files are opened with O_NOFOLLOW when available and their identity is checked
 * again before bytes are read; a concurrent file-to-symlink replacement therefore fails closed.
 */
export async function inventoryFilesystemRoot(root, { allowPublishPointers = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const rootMetadata = await lstat(resolvedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`filesystem root missing, symlinked, or not a directory: ${resolvedRoot}`);
  }

  const directories = [{
    absolute: resolvedRoot,
    relative: ".",
    mode: rootMetadata.mode & 0o777,
  }];
  const files = [];
  const symlinks = [];

  async function visit(relative = "") {
    const current = path.join(resolvedRoot, relative);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const absolute = path.join(resolvedRoot, child);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        if (!allowPublishPointers) throw new Error(`filesystem backup refuses symlink: ${absolute}`);
        const target = await readlink(absolute);
        validatePublishPointer(child.split(path.sep).join("/"), target);
        const actual = await realpath(absolute);
        if (!actual.startsWith(`${resolvedRoot}${path.sep}`) || !(await lstat(actual)).isDirectory()) {
          throw new Error(`publish pointer escapes root or is not a directory: ${child}`);
        }
        const after = await lstat(absolute);
        if (!after.isSymbolicLink() || after.ino !== metadata.ino || after.dev !== metadata.dev
            || await readlink(absolute) !== target) throw new Error(`publish pointer changed during backup: ${child}`);
        symlinks.push({ relative: child.split(path.sep).join("/"), target });
        continue;
      }
      if (metadata.isDirectory()) {
        directories.push({
          absolute,
          relative: child.split(path.sep).join("/"),
          mode: metadata.mode & 0o777,
        });
        await visit(child);
      } else if (metadata.isFile()) {
        files.push({
          absolute,
          relative: child.split(path.sep).join("/"),
          mode: metadata.mode & 0o777,
          device: metadata.dev,
          inode: metadata.ino,
        });
      } else {
        throw new Error(`filesystem backup refuses non-regular entry: ${absolute}`);
      }
    }
  }

  await visit();
  return {
    directories: directories.sort((a, b) => a.relative.localeCompare(b.relative)),
    files: files.sort((a, b) => a.relative.localeCompare(b.relative)),
    symlinks: symlinks.sort((a, b) => a.relative.localeCompare(b.relative)),
  };
}

export async function readInventoriedFile(item) {
  const noFollow = Number(constants.O_NOFOLLOW || 0);
  const handle = await open(item.absolute, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== item.device || metadata.ino !== item.inode) {
      throw new Error(`filesystem entry changed during backup: ${item.absolute}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function restoreFilesystemLayout({ filesystemRoot, directories = [], files = [], symlinks = [], readObject }) {
  if (!filesystemRoot) throw new Error("filesystem restore requires an isolated target root");
  if (typeof readObject !== "function") throw new Error("filesystem restore requires an object reader");

  for (const directory of [...directories].sort((a, b) => a.relativePath.length - b.relativePath.length)) {
    const target = safeRestorePath(filesystemRoot, directory.root, directory.relativePath);
    await mkdir(target, { recursive: true });
  }
  for (const object of files) {
    const target = safeRestorePath(filesystemRoot, object.root, object.relativePath);
    const bytes = await readObject(object);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== object.bytes || digest !== object.sha256) {
      throw new Error(`filesystem object corrupt: ${object.root}/${object.relativePath}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    if (Number.isInteger(object.mode)) await chmod(target, object.mode);
  }
  // Restore immutable-site pointers before domain aliases. Never follow a pointer while writing
  // artifact bytes, and never allow a manifest to create an arbitrary filesystem link.
  for (const link of [...symlinks].sort((a, b) => Number(a.relativePath.startsWith("_domains/"))
    - Number(b.relativePath.startsWith("_domains/")) || a.relativePath.localeCompare(b.relativePath))) {
    if (link.root !== "publish") throw new Error("symlinks are only supported for publish pointers");
    validatePublishPointer(link.relativePath, link.target);
    const target = safeRestorePath(filesystemRoot, link.root, link.relativePath);
    const resolved = await realpath(path.resolve(path.dirname(target), link.target));
    const publishRoot = path.resolve(filesystemRoot, "publish");
    if (!resolved.startsWith(`${publishRoot}${path.sep}`) || !(await lstat(resolved)).isDirectory()) {
      throw new Error("restored publish pointer escapes its root or is not a directory");
    }
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(link.target, target, "dir");
  }
  for (const directory of [...directories].sort((a, b) => b.relativePath.length - a.relativePath.length)) {
    const target = safeRestorePath(filesystemRoot, directory.root, directory.relativePath);
    if (Number.isInteger(directory.mode)) await chmod(target, directory.mode);
  }
}

function safeRestorePath(filesystemRoot, logicalRoot, relativePath) {
  if (!/^[a-z][a-z0-9-]*$/.test(logicalRoot || "")) throw new Error("invalid logical filesystem root");
  const targetRoot = path.resolve(filesystemRoot, logicalRoot);
  const target = relativePath === "." ? targetRoot : path.resolve(targetRoot, relativePath);
  if (target !== targetRoot && !target.startsWith(`${targetRoot}${path.sep}`)) {
    throw new Error(`filesystem restore path escapes target root: ${relativePath}`);
  }
  return target;
}

export function validatePublishPointer(relative, target) {
  const segment = "[a-zA-Z0-9_-]+";
  const site = new RegExp(`^\\.thrallo/sites/${segment}/current$`);
  const release = new RegExp(`^\\.\\./\\.\\./releases/${segment}/${segment}/${segment}$`);
  const domain = /^_domains\/[a-z0-9.-]+$/;
  const domainTarget = new RegExp(`^\\.\\./(?:\\.thrallo/sites/${segment}/current|${segment})$`);
  if (!((site.test(relative) && release.test(target)) || (domain.test(relative) && domainTarget.test(target)))) {
    throw new Error(`filesystem backup refuses unrecognized publish symlink: ${relative}`);
  }
}
