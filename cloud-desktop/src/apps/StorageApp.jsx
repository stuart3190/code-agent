import { Archive, DownloadSimple, Folder, HardDrives, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { storageFixtures } from "../fixtures/data.js";

export function StorageApp({ storageState = "normal", onFixtureNotice }) {
  const storage = storageFixtures[storageState] ?? storageFixtures.normal;
  const available = storage.total - storage.used;
  const percentage = Math.round((storage.used / storage.total) * 100);
  const segments = [
    { label: "Projects", value: storage.projects, icon: Folder, tone: "projects" },
    { label: "Downloads", value: storage.downloads, icon: DownloadSimple, tone: "downloads" },
    { label: "Backups", value: storage.backups, icon: Archive, tone: "backups" },
  ];
  return (
    <div className="app-view storage-app" data-testid="storage-app" data-storage-tone={storage.tone}>
      <header><div className={`storage-status-icon tone-${storage.tone}`}>{storage.tone === "positive" ? <HardDrives /> : <WarningCircle />}</div><div><span className="eyebrow">Cloud workspace storage</span><h2>{storage.label}</h2></div></header>
      <div className="storage-overview"><div><strong>{storage.used} GB</strong><span>of {storage.total} GB used</span></div><span>{available} GB available</span></div>
      <div className="storage-meter" role="meter" aria-label="Storage used" aria-valuemin="0" aria-valuemax={storage.total} aria-valuenow={storage.used}><span className={`tone-${storage.tone}`} style={{ width: `${percentage}%` }} /></div>
      <div className="storage-breakdown">{segments.map(({ label, value, icon: Icon, tone }) => <div key={label}><span className={`breakdown-icon tone-${tone}`}><Icon /></span><span><strong>{label}</strong><small>Fixture allocation</small></span><b>{value} GB</b></div>)}</div>
      <div className="snapshot-status"><ShieldCheck weight="duotone" /><span><strong>Latest snapshot is healthy</strong><small>Fixture checkpoint · Today at 9:42 AM</small></span><button onClick={() => onFixtureNotice("Snapshot details", "Recovery points are fixture presentation only in C1.")}>View details</button></div>
    </div>
  );
}
