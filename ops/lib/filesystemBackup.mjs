import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Inventory one canonical filesystem root without crossing a symlink boundary.
 *
 * The root itself and every child directory are recorded so an isolated restore can reproduce
 * modes exactly. Files are opened with O_NOFOLLOW when available and their identity is checked
 * again before bytes are read; a concurrent file-to-symlink replacement therefore fails closed.
 */
export async function inventoryFilesystemRoot(root) {
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

  async function visit(relative = "") {
    const current = path.join(resolvedRoot, relative);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const absolute = path.join(resolvedRoot, child);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`filesystem backup refuses symlink: ${absolute}`);
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

export async function restoreFilesystemLayout({ filesystemRoot, directories = [], files = [], readObject }) {
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
  for (const directory of [...directories].sort((a, b) => b.relativePath.length - a.relativePath.length)) {
    const target = safeRestorePath(filesystemRoot, directory.root, directory.relativePath);
    if (Number.isInteger(directory.mode)) await chmod(target, directory.mode);
  }
}

function safeRestorePath(filesystemRoot, logicalRoot, relativePath) {
  const targetRoot = path.resolve(filesystemRoot, logicalRoot);
  const target = relativePath === "." ? targetRoot : path.resolve(targetRoot, relativePath);
  if (target !== targetRoot && !target.startsWith(`${targetRoot}${path.sep}`)) {
    throw new Error(`filesystem restore path escapes target root: ${relativePath}`);
  }
  return target;
}
