import { createFilesystemScenario, GIB, MIB } from "./fixtures.js";
import { basenameVirtualPath, isSameOrDescendantPath, joinVirtualPath, normalizeVirtualPath, parentVirtualPath, validateVirtualName, virtualPathKey, VirtualPathError } from "./virtualPath.js";

export const FILESYSTEM_PROVIDER_VERSION = 1;
export const FILESYSTEM_CAPABILITIES = Object.freeze({
  list: true, stat: true, search: true, createDirectory: true, rename: true, move: true, copy: true,
  trash: true, restore: true, delete: true, fixtureUpload: true, fixtureDownload: true,
  hostFilesystem: false, realUpload: false, realDownload: false, network: false,
});

export const FIXTURE_UPLOADS = Object.freeze({
  "campaign-board": Object.freeze({ fixtureId: "campaign-board", name: "campaign-board.png", kind: "image", mime: "image/png", sizeBytes: 7.2 * MIB }),
  "research-notes": Object.freeze({ fixtureId: "research-notes", name: "research-notes.csv", kind: "data", mime: "text/csv", sizeBytes: 18 * MIB }),
  "prototype-archive": Object.freeze({ fixtureId: "prototype-archive", name: "prototype.zip", kind: "archive", mime: "application/zip", sizeBytes: 64 * MIB }),
});

const success = (value = {}) => ({ ok: true, ...value });
const failure = (code, message, details = {}) => ({ ok: false, code, message, ...details });
const cloneArgs = (args) => JSON.parse(JSON.stringify(args ?? {}));

function revisionAfter(revision) {
  const current = Number.parseInt(String(revision ?? "r0").replace(/\D/g, ""), 10) || 0;
  return `r${current + 1}`;
}

function categoryForPath(path) {
  if (path.startsWith("/Projects")) return "projects";
  if (path.startsWith("/Assets")) return "assets";
  if (path.startsWith("/Downloads")) return "downloads";
  if (path.startsWith("/Backups")) return "backups";
  if (path.startsWith("/Trash")) return "trash";
  return "projects";
}

function keepBothPath(items, destination, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; index < 100; index += 1) {
    const candidate = joinVirtualPath(destination, `${stem} (${index})${extension}`);
    if (!items.some((item) => virtualPathKey(item.path) === virtualPathKey(candidate))) return candidate;
  }
  throw new VirtualPathError("duplicate_name", "No deterministic keep-both name is available");
}

export function deriveStorageSnapshot(state) {
  const categories = { ...state.categoryBaseBytes };
  for (const entry of state.items) categories[categoryForPath(entry.path)] = (categories[categoryForPath(entry.path)] ?? 0) + (entry.sizeBytes || 0);
  const usedBytes = Object.values(categories).reduce((total, value) => total + value, 0);
  const availableBytes = Math.max(0, state.quotaBytes - usedBytes);
  const ratio = usedBytes / state.quotaBytes;
  const tone = availableBytes === 0 ? "exhausted" : ratio >= 0.9 ? "near-full" : ratio >= 0.8 ? "warning" : "normal";
  return { quotaBytes: state.quotaBytes, usedBytes, availableBytes, ratio, tone, categories };
}

export function createFixtureFilesystemProvider({ scenario = "normal-files", seed = "thrallo-c3", journal = [] } = {}) {
  let state = createFilesystemScenario(scenario, seed);
  let calls = [];
  const listeners = new Set();
  const emit = () => listeners.forEach((listener) => listener());
  const setState = (next, journalEntry = null) => {
    state = { ...next, journal: journalEntry ? [...next.journal, journalEntry].slice(-200) : next.journal };
    emit();
  };
  const call = (method, args) => calls.push(Object.freeze({ index: calls.length + 1, method, args: cloneArgs(args) }));
  const unavailable = () => state.availability === "unavailable" ? failure("capability_unavailable", "Fixture files are unavailable") : state.availability === "offline" ? failure("offline", "Fixture files are offline") : null;
  const find = (path) => {
    const key = virtualPathKey(path);
    return state.items.find((entry) => virtualPathKey(entry.path) === key) ?? null;
  };
  const children = (path) => state.items.filter((entry) => virtualPathKey(entry.parentPath ?? "/") === virtualPathKey(path));
  const ensureFolder = (path) => {
    const folder = find(path);
    return folder?.kind === "folder" ? folder : null;
  };
  const revisionFailure = (entry, expectedRevision) => expectedRevision && entry.revision !== expectedRevision
    ? failure("stale_revision", `${entry.name} changed before this operation`, { currentRevision: entry.revision, expectedRevision })
    : null;
  const permissionFailure = (entry) => entry?.restricted ? failure("permission_denied", `${entry.name} is restricted`) : entry?.readOnly ? failure("read_only", `${entry.name} is read-only`) : null;
  const forced = (operation) => {
    if (state.forcedConflict === "stale_revision") return failure("stale_revision", "The fixture revision is stale", { expectedRevision: "r0", currentRevision: "r2" });
    if (state.forcedConflict === `${operation}_conflict` || (state.forcedConflict === "duplicate_filename" && operation === "rename")) return failure("duplicate_name", `Fixture ${operation} conflict`, { conflict: true });
    return null;
  };
  const conflictAt = (path, sourceId) => state.items.find((entry) => virtualPathKey(entry.path) === virtualPathKey(path) && entry.id !== sourceId);
  const applyConflictPolicy = (items, conflict, destination, name, policy) => {
    if (!conflict) return { ok: true, items, path: joinVirtualPath(destination, name) };
    if (policy === "replace" && !conflict.restricted && !conflict.readOnly) return { ok: true, items: items.filter((entry) => entry.id !== conflict.id && !isSameOrDescendantPath(entry.path, conflict.path)), path: conflict.path };
    if (policy === "keep_both") return { ok: true, items, path: keepBothPath(items, destination, name) };
    return failure("duplicate_name", `${name} already exists in ${destination}`, { conflict: true, existing: { id: conflict.id, name: conflict.name, revision: conflict.revision } });
  };

  const provider = {
    kind: "deterministic_fixture",
    version: FILESYSTEM_PROVIDER_VERSION,
    capabilities: FILESYSTEM_CAPABILITIES,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot() { return state; },
    getCalls() { return [...calls]; },
    clearCalls() { calls = []; },
    list(path, { query = "", sort = "name-asc", page = 1, pageSize = 100 } = {}) {
      call("list", { path, query, sort, page, pageSize });
      const blocked = unavailable(); if (blocked) return blocked;
      let normalized; try { normalized = normalizeVirtualPath(path); } catch (error) { return failure(error.code, error.message); }
      if (!ensureFolder(normalized)) return failure("not_found", "Folder was not found");
      const needle = query.trim().toLocaleLowerCase("en-US");
      const comparators = {
        "name-asc": (a, b) => a.name.localeCompare(b.name),
        "name-desc": (a, b) => b.name.localeCompare(a.name),
        "modified-desc": (a, b) => b.modifiedAt.localeCompare(a.modifiedAt),
        "size-desc": (a, b) => b.sizeBytes - a.sizeBytes,
        "type-asc": (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
      };
      const matching = children(normalized).filter((entry) => !needle || entry.name.toLocaleLowerCase("en-US").includes(needle)).sort(comparators[sort] ?? comparators["name-asc"]);
      const boundedSize = Math.min(200, Math.max(20, Number(pageSize) || 100));
      const totalPages = Math.max(1, Math.ceil(matching.length / boundedSize));
      const boundedPage = Math.min(totalPages, Math.max(1, Number(page) || 1));
      return success({ path: normalized, items: matching.slice((boundedPage - 1) * boundedSize, boundedPage * boundedSize), total: matching.length, page: boundedPage, pageSize: boundedSize, totalPages });
    },
    stat(path) {
      call("stat", { path });
      const blocked = unavailable(); if (blocked) return blocked;
      try { const entry = find(path); return entry ? success({ item: entry }) : failure("not_found", "Item was not found"); } catch (error) { return failure(error.code, error.message); }
    },
    search(query, { root = "/", limit = 100 } = {}) {
      call("search", { query, root, limit });
      const blocked = unavailable(); if (blocked) return blocked;
      let normalized; try { normalized = normalizeVirtualPath(root); } catch (error) { return failure(error.code, error.message); }
      const needle = String(query ?? "").trim().toLocaleLowerCase("en-US");
      if (!needle) return success({ items: [], total: 0 });
      const matches = state.items.filter((entry) => isSameOrDescendantPath(entry.path, normalized) && entry.name.toLocaleLowerCase("en-US").includes(needle));
      return success({ items: matches.slice(0, Math.min(200, limit)), total: matches.length });
    },
    listDestinations() {
      call("listDestinations", {});
      return success({ items: state.items.filter((entry) => entry.kind === "folder" && entry.path !== "/Trash" && !isSameOrDescendantPath(entry.path, "/Trash")) });
    },
    createDirectory(parentPath, name, { conflictPolicy = "cancel" } = {}) {
      call("createDirectory", { parentPath, name, conflictPolicy });
      const blocked = unavailable(); if (blocked) return blocked;
      let parent; let destination; try { parent = normalizeVirtualPath(parentPath); destination = joinVirtualPath(parent, name); } catch (error) { return failure(error.code, error.message); }
      if (!ensureFolder(parent)) return failure("destination_unavailable", "Destination folder is unavailable");
      const validation = validateVirtualName(name); if (!validation.ok) return failure(validation.code, "Folder name is not allowed");
      const conflict = conflictAt(destination);
      const resolution = applyConflictPolicy(state.items, conflict, parent, validation.name, conflictPolicy);
      if (!resolution.ok) return resolution;
      const entry = { id: `created:${state.journal.length + 1}`, path: resolution.path, parentPath: parent, name: basenameVirtualPath(resolution.path), kind: "folder", sizeBytes: 0, modifiedAt: "2026-08-09T15:00:00.000Z", revision: "r1", source: "fixture_created" };
      const journalEntry = { operation: "createDirectory", args: [parent, entry.name, { conflictPolicy }] };
      setState({ ...state, items: [...resolution.items, entry] }, journalEntry);
      return success({ item: entry });
    },
    rename(path, newName, { expectedRevision, conflictPolicy = "cancel" } = {}) {
      call("rename", { path, newName, expectedRevision, conflictPolicy });
      const blocked = unavailable(); if (blocked) return blocked;
      const scenarioConflict = forced("rename"); if (scenarioConflict) return scenarioConflict;
      let normalized; let nextPath; try { normalized = normalizeVirtualPath(path); nextPath = joinVirtualPath(parentVirtualPath(normalized), newName); } catch (error) { return failure(error.code, error.message); }
      const entry = find(normalized); if (!entry) return failure("not_found", "Item was not found");
      const denied = permissionFailure(entry) ?? revisionFailure(entry, expectedRevision); if (denied) return denied;
      if (entry.name === newName.trim()) return success({ item: entry, unchanged: true });
      const conflict = conflictAt(nextPath, entry.id);
      const resolution = applyConflictPolicy(state.items, conflict, parentVirtualPath(normalized), newName.trim(), conflictPolicy);
      if (!resolution.ok) return resolution;
      const updates = resolution.items.map((candidate) => {
        if (!isSameOrDescendantPath(candidate.path, normalized)) return candidate;
        const suffix = candidate.path.slice(normalized.length);
        const candidatePath = `${resolution.path}${suffix}`;
        return { ...candidate, path: candidatePath, parentPath: parentVirtualPath(candidatePath), name: basenameVirtualPath(candidatePath), revision: revisionAfter(candidate.revision), modifiedAt: "2026-08-09T15:01:00.000Z" };
      });
      const journalEntry = { operation: "rename", args: [normalized, basenameVirtualPath(resolution.path), { expectedRevision, conflictPolicy }] };
      setState({ ...state, items: updates }, journalEntry);
      return success({ item: updates.find((candidate) => candidate.id === entry.id) });
    },
    move(path, destinationPath, { expectedRevision, conflictPolicy = "cancel" } = {}) {
      call("move", { path, destinationPath, expectedRevision, conflictPolicy });
      const blocked = unavailable(); if (blocked) return blocked;
      const scenarioConflict = forced("move"); if (scenarioConflict) return scenarioConflict;
      let source; let destination; try { source = normalizeVirtualPath(path); destination = normalizeVirtualPath(destinationPath); } catch (error) { return failure(error.code, error.message); }
      const entry = find(source); if (!entry) return failure("not_found", "Item was not found");
      const denied = permissionFailure(entry) ?? revisionFailure(entry, expectedRevision); if (denied) return denied;
      if (!ensureFolder(destination)) return failure("destination_unavailable", "Destination folder is unavailable");
      if (entry.kind === "folder" && isSameOrDescendantPath(destination, source)) return failure("recursive_move", "A folder cannot be moved into itself or its descendant");
      const proposed = joinVirtualPath(destination, entry.name);
      const resolution = applyConflictPolicy(state.items, conflictAt(proposed, entry.id), destination, entry.name, conflictPolicy);
      if (!resolution.ok) return resolution;
      const updates = resolution.items.map((candidate) => {
        if (!isSameOrDescendantPath(candidate.path, source)) return candidate;
        const nextPath = `${resolution.path}${candidate.path.slice(source.length)}`;
        return { ...candidate, path: nextPath, parentPath: parentVirtualPath(nextPath), name: basenameVirtualPath(nextPath), revision: revisionAfter(candidate.revision) };
      });
      setState({ ...state, items: updates }, { operation: "move", args: [source, destination, { expectedRevision, conflictPolicy }] });
      return success({ item: updates.find((candidate) => candidate.id === entry.id) });
    },
    copy(path, destinationPath, { expectedRevision, conflictPolicy = "cancel" } = {}) {
      call("copy", { path, destinationPath, expectedRevision, conflictPolicy });
      const blocked = unavailable(); if (blocked) return blocked;
      const scenarioConflict = forced("copy"); if (scenarioConflict) return scenarioConflict;
      let source; let destination; try { source = normalizeVirtualPath(path); destination = normalizeVirtualPath(destinationPath); } catch (error) { return failure(error.code, error.message); }
      const entry = find(source); if (!entry) return failure("not_found", "Item was not found");
      const denied = revisionFailure(entry, expectedRevision); if (denied) return denied;
      if (!ensureFolder(destination)) return failure("destination_unavailable", "Destination folder is unavailable");
      if (entry.kind === "folder" && isSameOrDescendantPath(destination, source)) return failure("recursive_copy", "A folder cannot be copied into itself or its descendant");
      const subtree = state.items.filter((candidate) => isSameOrDescendantPath(candidate.path, source));
      const additionalBytes = subtree.reduce((total, candidate) => total + candidate.sizeBytes, 0);
      if (deriveStorageSnapshot(state).availableBytes < additionalBytes) return failure("quota_exceeded", "The fixture storage quota is exhausted");
      const resolution = applyConflictPolicy(state.items, conflictAt(joinVirtualPath(destination, entry.name)), destination, entry.name, conflictPolicy);
      if (!resolution.ok) return resolution;
      const copies = subtree.map((candidate, index) => {
        const nextPath = `${resolution.path}${candidate.path.slice(source.length)}`;
        return { ...candidate, id: `copy:${state.journal.length + 1}:${index}`, path: nextPath, parentPath: parentVirtualPath(nextPath), name: basenameVirtualPath(nextPath), revision: "r1", source: "fixture_copy" };
      });
      setState({ ...state, items: [...resolution.items, ...copies] }, { operation: "copy", args: [source, destination, { expectedRevision, conflictPolicy }] });
      return success({ item: copies[0] });
    },
    trash(path, { expectedRevision } = {}) {
      call("trash", { path, expectedRevision });
      const blocked = unavailable(); if (blocked) return blocked;
      let source; try { source = normalizeVirtualPath(path); } catch (error) { return failure(error.code, error.message); }
      const entry = find(source); if (!entry) return failure("not_found", "Item was not found");
      const denied = permissionFailure(entry) ?? revisionFailure(entry, expectedRevision); if (denied) return denied;
      if (isSameOrDescendantPath(source, "/Trash")) return failure("already_trashed", "Item is already in Trash");
      const rootPath = conflictAt(joinVirtualPath("/Trash", entry.name)) ? keepBothPath(state.items, "/Trash", entry.name) : joinVirtualPath("/Trash", entry.name);
      const updates = state.items.map((candidate) => {
        if (!isSameOrDescendantPath(candidate.path, source)) return candidate;
        const nextPath = `${rootPath}${candidate.path.slice(source.length)}`;
        return { ...candidate, path: nextPath, parentPath: parentVirtualPath(nextPath), name: basenameVirtualPath(nextPath), revision: revisionAfter(candidate.revision), ...(candidate.id === entry.id ? { originalPath: source, trashedAt: "2026-08-09T15:02:00.000Z" } : {}) };
      });
      setState({ ...state, items: updates }, { operation: "trash", args: [source, { expectedRevision }] });
      return success({ item: updates.find((candidate) => candidate.id === entry.id) });
    },
    restore(path, { conflictPolicy = "keep_both" } = {}) {
      call("restore", { path, conflictPolicy });
      const blocked = unavailable(); if (blocked) return blocked;
      let source; try { source = normalizeVirtualPath(path); } catch (error) { return failure(error.code, error.message); }
      const entry = find(source); if (!entry || !isSameOrDescendantPath(source, "/Trash")) return failure("not_found", "Trashed item was not found");
      let targetPath = entry.originalPath;
      let recovery = false;
      if (!targetPath || !ensureFolder(parentVirtualPath(targetPath))) {
        const recoveredFolder = "/My Files/Recovered";
        if (!ensureFolder(recoveredFolder)) state = { ...state, items: [...state.items, { id: "recovery:folder", path: recoveredFolder, parentPath: "/My Files", name: "Recovered", kind: "folder", sizeBytes: 0, modifiedAt: "2026-08-09T15:03:00.000Z", revision: "r1", source: "fixture_recovery" }] };
        targetPath = joinVirtualPath(recoveredFolder, entry.name);
        recovery = true;
      }
      const destination = parentVirtualPath(targetPath);
      const resolution = applyConflictPolicy(state.items, conflictAt(targetPath, entry.id), destination, basenameVirtualPath(targetPath), conflictPolicy);
      if (!resolution.ok) return resolution;
      const updates = resolution.items.map((candidate) => {
        if (!isSameOrDescendantPath(candidate.path, source)) return candidate;
        const nextPath = `${resolution.path}${candidate.path.slice(source.length)}`;
        const restored = { ...candidate, path: nextPath, parentPath: parentVirtualPath(nextPath), name: basenameVirtualPath(nextPath), revision: revisionAfter(candidate.revision) };
        if (candidate.id === entry.id) { delete restored.originalPath; delete restored.trashedAt; }
        return restored;
      });
      setState({ ...state, items: updates }, { operation: "restore", args: [source, { conflictPolicy }] });
      return success({ item: updates.find((candidate) => candidate.id === entry.id), recoveryLocation: recovery ? "/My Files/Recovered" : null });
    },
    delete(path, { confirmed = false, expectedRevision } = {}) {
      call("delete", { path, confirmed, expectedRevision });
      const blocked = unavailable(); if (blocked) return blocked;
      let source; try { source = normalizeVirtualPath(path); } catch (error) { return failure(error.code, error.message); }
      const entry = find(source); if (!entry || !isSameOrDescendantPath(source, "/Trash")) return failure("not_found", "Trash item was not found");
      if (!confirmed) return failure("confirmation_required", "Permanent fixture deletion requires confirmation");
      const denied = permissionFailure(entry) ?? revisionFailure(entry, expectedRevision); if (denied) return denied;
      setState({ ...state, items: state.items.filter((candidate) => !isSameOrDescendantPath(candidate.path, source)) }, { operation: "delete", args: [source, { confirmed: true, expectedRevision }] });
      return success({ deletedId: entry.id });
    },
    beginFixtureUpload(destinationPath, fixtureId) {
      call("beginFixtureUpload", { destinationPath, fixtureId });
      const blocked = unavailable(); if (blocked) return blocked;
      const fixture = FIXTURE_UPLOADS[fixtureId]; if (!fixture) return failure("fixture_only", "Only bundled synthetic uploads are accepted");
      let destination; try { destination = normalizeVirtualPath(destinationPath); } catch (error) { return failure(error.code, error.message); }
      if (!ensureFolder(destination) || isSameOrDescendantPath(destination, "/Trash")) return failure("destination_unavailable", "Upload destination is unavailable");
      if (deriveStorageSnapshot(state).availableBytes < fixture.sizeBytes) return failure("quota_exceeded", "The fixture storage quota is exhausted");
      if (conflictAt(joinVirtualPath(destination, fixture.name))) return failure("duplicate_name", `${fixture.name} already exists`, { conflict: true });
      const transfer = { id: `upload:${state.journal.length + state.transfers.length + 1}`, direction: "upload", status: "uploading", destinationPath: destination, fixtureId, name: fixture.name, sizeBytes: fixture.sizeBytes, progress: 42, createdAt: "2026-08-09T15:04:00.000Z" };
      setState({ ...state, transfers: [...state.transfers, transfer] }, { operation: "beginFixtureUpload", args: [destination, fixtureId] });
      return success({ transfer });
    },
    advanceTransfer(transferId) {
      call("advanceTransfer", { transferId });
      const transfer = state.transfers.find((candidate) => candidate.id === transferId); if (!transfer) return failure("not_found", "Transfer was not found");
      if (["completed", "failed", "canceled"].includes(transfer.status)) return success({ transfer, unchanged: true });
      let nextStatus;
      if (transfer.direction === "upload") nextStatus = transfer.status === "uploading" ? "completed" : "uploading";
      else nextStatus = transfer.status === "preparing" ? "ready" : transfer.status === "ready" ? "downloading" : "completed";
      const nextTransfer = { ...transfer, status: nextStatus, progress: nextStatus === "completed" ? 100 : nextStatus === "downloading" ? 62 : 48 };
      let items = state.items;
      if (transfer.direction === "upload" && nextStatus === "completed") {
        const fixture = FIXTURE_UPLOADS[transfer.fixtureId];
        const path = joinVirtualPath(transfer.destinationPath, fixture.name);
        items = [...items, { id: `uploaded:${transfer.id}`, path, parentPath: transfer.destinationPath, name: fixture.name, kind: fixture.kind, mime: fixture.mime, sizeBytes: fixture.sizeBytes, modifiedAt: "2026-08-09T15:05:00.000Z", revision: "r1", source: "fixture_upload" }];
      }
      setState({ ...state, items, transfers: state.transfers.map((candidate) => candidate.id === transferId ? nextTransfer : candidate) }, { operation: "advanceTransfer", args: [transferId] });
      return success({ transfer: nextTransfer });
    },
    cancelTransfer(transferId) {
      call("cancelTransfer", { transferId });
      const transfer = state.transfers.find((candidate) => candidate.id === transferId); if (!transfer) return failure("not_found", "Transfer was not found");
      const nextTransfer = { ...transfer, status: "canceled", progress: transfer.progress ?? 0 };
      setState({ ...state, transfers: state.transfers.map((candidate) => candidate.id === transferId ? nextTransfer : candidate) }, { operation: "cancelTransfer", args: [transferId] });
      return success({ transfer: nextTransfer });
    },
    beginFixtureDownload(path) {
      call("beginFixtureDownload", { path });
      const blocked = unavailable(); if (blocked) return blocked;
      let normalized; try { normalized = normalizeVirtualPath(path); } catch (error) { return failure(error.code, error.message); }
      const entry = find(normalized); if (!entry || entry.kind === "folder") return failure("unavailable", "This fixture item cannot be downloaded");
      if (entry.restricted) return failure("permission_denied", "Restricted fixture items cannot be downloaded");
      const transfer = { id: `download:${state.journal.length + state.transfers.length + 1}`, direction: "download", status: "preparing", sourcePath: normalized, name: entry.name, sizeBytes: entry.sizeBytes, progress: 0, createdAt: "2026-08-09T15:06:00.000Z" };
      setState({ ...state, transfers: [...state.transfers, transfer] }, { operation: "beginFixtureDownload", args: [normalized] });
      return success({ transfer });
    },
    storage() { call("storage", {}); return deriveStorageSnapshot(state); },
  };

  // Replaying uses the same checked operations but resets the journal to the accepted persisted entries.
  for (const entry of Array.isArray(journal) ? journal.slice(0, 200) : []) {
    if (!entry || typeof provider[entry.operation] !== "function" || !Array.isArray(entry.args)) continue;
    provider[entry.operation](...entry.args);
  }
  if (journal.length) state = { ...state, journal: journal.slice(0, 200) };
  calls = [];
  return provider;
}
