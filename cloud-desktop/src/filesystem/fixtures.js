import { joinVirtualPath, parentVirtualPath } from "./virtualPath.js";

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

const FIXED_TIME = "2026-08-09T14:30:00.000Z";
const item = (path, kind, sizeBytes = 0, extra = {}) => Object.freeze({
  id: extra.id ?? `fixture:${path.toLocaleLowerCase("en-US")}`,
  path,
  parentPath: parentVirtualPath(path),
  name: path.slice(path.lastIndexOf("/") + 1),
  kind,
  sizeBytes,
  modifiedAt: extra.modifiedAt ?? FIXED_TIME,
  revision: extra.revision ?? "r1",
  source: "fixture",
  ...extra,
});

export const ROOT_FOLDERS = Object.freeze(["/My Files", "/Projects", "/Assets", "/Downloads", "/Backups", "/Shared", "/Trash"]);

export const baseFixtureItems = Object.freeze([
  ...ROOT_FOLDERS.map((path) => item(path, "folder", 0, { restricted: path === "/Backups" })),
  item("/My Files/Welcome to Thrallo.txt", "text", 3_240, { mime: "text/plain", preview: "This is a deterministic cloud-files fixture. No host file was read." }),
  item("/My Files/Workspace brief.pdf", "document", 4.3 * MIB, { mime: "application/pdf", preview: "PDF metadata preview · 12 pages" }),
  item("/My Files/Empty", "folder"),
  item("/Projects/Website", "folder"),
  item("/Projects/Website/src", "folder"),
  item("/Projects/Website/src/App.jsx", "code", 18_420, { mime: "text/javascript", preview: "export function App() { return <main>Fixture preview</main>; }" }),
  item("/Projects/Website/package.json", "data", 1_280, { mime: "application/json", preview: "{\n  \"name\": \"fixture-website\",\n  \"private\": true\n}" }),
  item("/Projects/Website/README.md", "text", 8_420, { mime: "text/markdown", preview: "# Fixture Website\nSafe, deterministic project metadata." }),
  item("/Projects/Analytics", "folder"),
  item("/Projects/Analytics/metrics.json", "data", 92_000, { mime: "application/json", preview: "{ \"visitors\": 4820, \"source\": \"fixture\" }" }),
  item("/Assets/Images", "folder"),
  item("/Assets/Images/hero-light.png", "image", 6.8 * MIB, { mime: "image/png", preview: "Bundled image placeholder · 2400 × 1400" }),
  item("/Assets/Images/logo-mark.svg", "image", 28_400, { mime: "image/svg+xml", preview: "Vector image metadata · fixture only" }),
  item("/Assets/brand-library.zip", "archive", 41 * MIB, { mime: "application/zip" }),
  item("/Downloads/research-notes.txt", "text", 24_000, { mime: "text/plain", preview: "Research notes fixture preview." }),
  item("/Downloads/design-export.bin", "binary", 780 * MIB, { mime: "application/octet-stream", oversized: true, unsupported: true }),
  item("/Shared/Product roadmap.pdf", "document", 8.2 * MIB, { mime: "application/pdf", readOnly: true, preview: "Shared document · read-only fixture" }),
  item("/Shared/Latest assets", "symlink", 0, { targetPath: "/Assets", readOnly: true }),
  item("/Backups/system-checkpoint.snapshot", "binary", 2.4 * GIB, { restricted: true, readOnly: true, mime: "application/x-thrallo-snapshot" }),
]);

function largeDirectoryItems(count = 5000) {
  const folder = item("/Downloads/Large Archive", "folder");
  return [folder, ...Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(5, "0");
    return item(joinVirtualPath(folder.path, `report-${suffix}.json`), "data", 2_048 + (index % 17) * 128, {
      id: `large:${suffix}`,
      revision: `r${1 + (index % 4)}`,
      modifiedAt: `2026-08-${String(1 + (index % 9)).padStart(2, "0")}T12:00:00.000Z`,
    });
  })];
}

const transfer = (id, direction, status, name, sizeBytes) => ({ id, direction, status, name, sizeBytes, createdAt: FIXED_TIME });

export const FILESYSTEM_SCENARIO_IDS = Object.freeze([
  "normal-files", "empty-folder", "large-folder", "upload-success", "upload-failure", "upload-canceled",
  "duplicate-filename", "move-conflict", "copy-conflict", "stale-revision", "storage-warning", "storage-exhausted",
  "trash-populated", "restore-success", "restore-parent-missing", "restricted-item", "symlink-item", "read-only-item",
  "loading-files", "offline-files", "unavailable-files", "corrupted-fixture-recovery",
]);

export function createFilesystemScenario(scenarioId = "normal-files", seed = "thrallo-c3") {
  const id = FILESYSTEM_SCENARIO_IDS.includes(scenarioId) ? scenarioId : "normal-files";
  const items = baseFixtureItems.map((entry) => ({ ...entry }));
  const scenario = {
    id,
    seed,
    items,
    transfers: [],
    quotaBytes: 200 * GIB,
    categoryBaseBytes: { projects: 38 * GIB, assets: 12 * GIB, downloads: 7 * GIB, backups: 11 * GIB, trash: 0 },
    availability: "ready",
    forcedConflict: null,
    journal: [],
  };
  if (id === "large-folder") scenario.items.push(...largeDirectoryItems());
  if (id === "upload-success") scenario.transfers.push(transfer("upload-success", "upload", "completed", "campaign-board.png", 7.2 * MIB));
  if (id === "upload-failure") scenario.transfers.push(transfer("upload-failure", "upload", "failed", "customer-data.csv", 18 * MIB));
  if (id === "upload-canceled") scenario.transfers.push(transfer("upload-canceled", "upload", "canceled", "prototype.zip", 64 * MIB));
  if (["duplicate-filename", "move-conflict", "copy-conflict"].includes(id)) scenario.forcedConflict = id.replace("-", "_");
  if (id === "stale-revision") scenario.forcedConflict = "stale_revision";
  if (id === "storage-warning") scenario.categoryBaseBytes.projects = 136 * GIB;
  if (id === "storage-exhausted") scenario.categoryBaseBytes.projects = 171 * GIB;
  if (["trash-populated", "restore-success", "restore-parent-missing"].includes(id)) {
    scenario.items.push(item("/Trash/old-launch-plan.pdf", "document", 5.1 * MIB, {
      id: "trash:old-launch-plan",
      originalPath: id === "restore-parent-missing" ? "/Projects/Removed/old-launch-plan.pdf" : "/Projects/old-launch-plan.pdf",
      trashedAt: FIXED_TIME,
    }));
  }
  if (id === "loading-files") scenario.availability = "loading";
  if (id === "offline-files") scenario.availability = "offline";
  if (id === "unavailable-files") scenario.availability = "unavailable";
  return scenario;
}
