import { Archive, DownloadSimple, Folder, HardDrives, Image, ShieldCheck, Trash, WarningCircle } from "@phosphor-icons/react";
import { storageFixtures } from "../fixtures/data.js";

const GIB = 1024 ** 3;
const formatGiB = (bytes) => `${(bytes / GIB).toFixed(bytes < GIB ? 2 : 1)} GB`;

export function StorageApp({ storageState = "normal", filesystem, onFixtureNotice }) {
  const legacy = storageFixtures[storageState] ?? storageFixtures.normal;
  const storage = filesystem?.storage ?? {
    quotaBytes: legacy.total * GIB,
    usedBytes: legacy.used * GIB,
    availableBytes: (legacy.total - legacy.used) * GIB,
    ratio: legacy.used / legacy.total,
    tone: storageState === "near-full" ? "near-full" : storageState === "warning" ? "warning" : "normal",
    categories: { projects: legacy.projects * GIB, assets: 0, downloads: legacy.downloads * GIB, backups: legacy.backups * GIB, trash: 0 },
  };
  const warning = storage.tone !== "normal";
  const segments = [
    { label: "Projects", value: storage.categories.projects, icon: Folder, tone: "projects" },
    { label: "Assets", value: storage.categories.assets, icon: Image, tone: "assets" },
    { label: "Downloads", value: storage.categories.downloads, icon: DownloadSimple, tone: "downloads" },
    { label: "Backups", value: storage.categories.backups, icon: Archive, tone: "backups" },
    { label: "Trash", value: storage.categories.trash, icon: Trash, tone: "trash" },
  ];
  return (
    <div className="app-view storage-app" data-testid="storage-app" data-storage-tone={storage.tone}>
      <header><div className={`storage-status-icon tone-${warning ? "warning" : "positive"}`}>{warning ? <WarningCircle /> : <HardDrives />}</div><div><span className="eyebrow">Fixture cloud storage</span><h2>{storage.tone === "exhausted" ? "Storage exhausted" : storage.tone === "near-full" ? "Storage is nearly full" : storage.tone === "warning" ? "Storage is getting full" : "Storage is healthy"}</h2></div></header>
      <div className="storage-overview"><div><strong>{formatGiB(storage.usedBytes)}</strong><span>of {formatGiB(storage.quotaBytes)} used</span></div><span>{formatGiB(storage.availableBytes)} available</span></div>
      <div className="storage-meter" role="meter" aria-label="Fixture storage used" aria-valuemin="0" aria-valuemax={storage.quotaBytes} aria-valuenow={Math.min(storage.usedBytes, storage.quotaBytes)}><span className={`tone-${storage.tone}`} style={{ width: `${Math.min(100, storage.ratio * 100)}%` }} /></div>
      <div className="storage-breakdown">{segments.map(({ label, value, icon: Icon, tone }) => <div key={label}><span className={`breakdown-icon tone-${tone}`}><Icon /></span><span><strong>{label}</strong><small>Deterministic fixture allocation</small></span><b>{formatGiB(value)}</b></div>)}</div>
      <div className="snapshot-status"><ShieldCheck weight="duotone" /><span><strong>Latest fixture snapshot is healthy</strong><small>Recovery checkpoint · deterministic state</small></span><button onClick={() => onFixtureNotice("Snapshot details", "Snapshots are fixture presentation only in C3.")}>View details</button></div>
    </div>
  );
}
