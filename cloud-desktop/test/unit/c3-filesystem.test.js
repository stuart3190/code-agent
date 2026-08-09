import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createFixtureFilesystemProvider, FILESYSTEM_CAPABILITIES } from "../../src/filesystem/fixtureProvider.js";
import { parseFilesystemSession, FILESYSTEM_PERSISTENCE_VERSION } from "../../src/filesystem/persistence.js";
import { isSameOrDescendantPath, joinVirtualPath, normalizeVirtualPath, validateVirtualName } from "../../src/filesystem/virtualPath.js";

describe("C3 virtual paths", () => {
  it("normalizes workspace-relative paths and rejects host/traversal input", () => {
    expect(normalizeVirtualPath("/Projects//Website/")).toBe("/Projects/Website");
    expect(normalizeVirtualPath("\\Projects\\Website")).toBe("/Projects/Website");
    for (const unsafe of ["../secret", "/Projects/../secret", "C:\\Users\\Admin", "/Projects/a\0b"])
      expect(() => normalizeVirtualPath(unsafe)).toThrow();
    expect(joinVirtualPath("/Projects", "Website")).toBe("/Projects/Website");
    expect(isSameOrDescendantPath("/Assets/Images", "/")).toBe(true);
  });

  it("applies deterministic, case-insensitive safe-name policy", () => {
    expect(validateVirtualName("Feature notes")).toEqual({ ok: true, name: "Feature notes" });
    for (const name of ["..", "a/b", "CON", "bad.", "token\0txt"])
      expect(validateVirtualName(name).ok).toBe(false);
  });

  it("rejects traversal fuzz cases", () => {
    for (const segment of ["..", "%00", "a/b", "a\\b", "NUL", "ab", "x".repeat(121)]) {
      const result = validateVirtualName(segment);
      if (segment === "%00") expect(result.ok).toBe(true);
      else expect(result.ok).toBe(false);
    }
  });
});

describe("C3 deterministic fixture provider", () => {
  it("lists, searches, sorts and paginates without host access", () => {
    const provider = createFixtureFilesystemProvider();
    expect(provider.list("/Projects").items.map((item) => item.name)).toEqual(["Analytics", "Website"]);
    expect(provider.search("logo", { root: "/" }).items[0].path).toBe("/Assets/Images/logo-mark.svg");
    const large = createFixtureFilesystemProvider({ scenario: "large-folder", seed: "fixed" });
    const first = large.list("/Downloads/Large Archive", { pageSize: 100 });
    expect(first.total).toBe(5000);
    expect(first.items).toHaveLength(100);
    expect(large.list("/Downloads/Large Archive", { page: 50, pageSize: 100 }).items).toHaveLength(100);
  });

  it("creates, renames and returns typed duplicate and stale conflicts", () => {
    const provider = createFixtureFilesystemProvider();
    const created = provider.createDirectory("/My Files", "Plans");
    expect(created.ok).toBe(true);
    expect(provider.createDirectory("/My Files", "plans")).toMatchObject({ ok: false, code: "duplicate_name", conflict: true });
    expect(provider.rename(created.item.path, "Roadmap", { expectedRevision: "r0" })).toMatchObject({ ok: false, code: "stale_revision" });
    const renamed = provider.rename(created.item.path, "Roadmap", { expectedRevision: "r1" });
    expect(renamed.item.path).toBe("/My Files/Roadmap");
    expect(renamed.item.revision).toBe("r2");
  });

  it("moves/copies trees, blocks recursion, and supports keep-both", () => {
    const provider = createFixtureFilesystemProvider();
    expect(provider.move("/Projects/Website", "/Projects/Website/src", { expectedRevision: "r1" })).toMatchObject({ ok: false, code: "recursive_move" });
    const copy = provider.copy("/Projects/Website", "/My Files", { expectedRevision: "r1" });
    expect(copy.ok).toBe(true);
    expect(provider.stat("/My Files/Website/src/App.jsx").ok).toBe(true);
    const duplicate = provider.copy("/Projects/Website", "/My Files", { expectedRevision: "r1" });
    expect(duplicate).toMatchObject({ ok: false, code: "duplicate_name" });
    expect(provider.copy("/Projects/Website", "/My Files", { expectedRevision: "r1", conflictPolicy: "keep_both" }).item.path).toBe("/My Files/Website (2)");
  });

  it("trashes, restores, recovers missing parents and confirms permanent deletion", () => {
    const provider = createFixtureFilesystemProvider();
    const trashed = provider.trash("/My Files/Welcome to Thrallo.txt", { expectedRevision: "r1" });
    expect(trashed.item.path).toBe("/Trash/Welcome to Thrallo.txt");
    expect(provider.restore(trashed.item.path).item.path).toBe("/My Files/Welcome to Thrallo.txt");
    const recovery = createFixtureFilesystemProvider({ scenario: "restore-parent-missing" });
    const restored = recovery.restore("/Trash/old-launch-plan.pdf");
    expect(restored.recoveryLocation).toBe("/My Files/Recovered");
    const recoveryPath = restored.item.path;
    expect(recovery.trash(recoveryPath, { expectedRevision: restored.item.revision }).ok).toBe(true);
    const trashPath = `/Trash/${restored.item.name}`;
    expect(recovery.delete(trashPath)).toMatchObject({ ok: false, code: "confirmation_required" });
    expect(recovery.delete(trashPath, { confirmed: true, expectedRevision: recovery.stat(trashPath).item.revision }).ok).toBe(true);
  });

  it("simulates uploads/downloads locally and updates storage deterministically", () => {
    const provider = createFixtureFilesystemProvider();
    const before = provider.storage().usedBytes;
    const upload = provider.beginFixtureUpload("/My Files", "campaign-board");
    expect(upload.transfer.status).toBe("uploading");
    provider.advanceTransfer(upload.transfer.id);
    expect(provider.stat("/My Files/campaign-board.png").ok).toBe(true);
    expect(provider.storage().usedBytes).toBeGreaterThan(before);
    const download = provider.beginFixtureDownload("/My Files/campaign-board.png");
    expect(download.transfer.status).toBe("preparing");
    expect(provider.advanceTransfer(download.transfer.id).transfer.status).toBe("ready");
    expect(provider.cancelTransfer(download.transfer.id).transfer.status).toBe("canceled");
    expect(createFixtureFilesystemProvider({ scenario: "storage-exhausted" }).beginFixtureUpload("/My Files", "prototype-archive")).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("enforces restricted/read-only states and explicit no-host capabilities", () => {
    const provider = createFixtureFilesystemProvider();
    expect(provider.rename("/Backups/system-checkpoint.snapshot", "renamed.snapshot", { expectedRevision: "r1" })).toMatchObject({ ok: false, code: "permission_denied" });
    expect(provider.trash("/Shared/Product roadmap.pdf", { expectedRevision: "r1" })).toMatchObject({ ok: false, code: "read_only" });
    expect(provider.stat("/Shared/Latest assets").item).toMatchObject({ kind: "symlink", targetPath: "/Assets" });
    expect(FILESYSTEM_CAPABILITIES).toMatchObject({ hostFilesystem: false, realUpload: false, realDownload: false, network: false });
  });

  it("is identical for identical scenario, seed, and journal", () => {
    const first = createFixtureFilesystemProvider({ scenario: "normal-files", seed: "same" });
    first.createDirectory("/My Files", "Deterministic");
    const second = createFixtureFilesystemProvider({ scenario: "normal-files", seed: "same", journal: first.getSnapshot().journal });
    expect(second.getSnapshot()).toEqual(first.getSnapshot());
  });
});

describe("C3 fixture persistence and isolation", () => {
  it("repairs unsafe paths and rejects corrupt or old versions", () => {
    const repaired = parseFilesystemSession(JSON.stringify({ version: FILESYSTEM_PERSISTENCE_VERSION, scenario: "normal-files", journal: [], ui: { currentPath: "C:\\Users\\Admin" } }));
    expect(repaired.session.ui.currentPath).toBe("/My Files");
    expect(repaired.recovery).toBe("repaired");
    expect(parseFilesystemSession("not json")).toMatchObject({ session: null, recovery: "corrupt" });
    expect(parseFilesystemSession(JSON.stringify({ version: 0 }))).toMatchObject({ session: null, recovery: "unsupported" });
  });

  it("contains no file picker, host filesystem import, shell, or network fallback", () => {
    const sources = ["src/apps/FilesApp.jsx", "src/filesystem/fixtureProvider.js", "src/hooks/useFixtureFilesystem.js"].map((path) => readFileSync(path, "utf8")).join("\n");
    expect(sources).not.toMatch(/type=["']file["']/i);
    expect(sources).not.toMatch(/from\s+["']node:(fs|child_process|net|http|https)["']/);
    expect(sources).not.toMatch(/fetch\s*\(|XMLHttpRequest|WebSocket|Daytona|BuilderV2|supabase/i);
  });
});
