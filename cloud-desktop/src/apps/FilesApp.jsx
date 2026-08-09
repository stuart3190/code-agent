import { useMemo, useState } from "react";
import { ArrowCounterClockwise, DownloadSimple, File, Folder, FolderPlus, GridFour, ListBullets, PencilSimple, Trash, UploadSimple, ArrowsLeftRight } from "@phosphor-icons/react";
import { initialFiles } from "../fixtures/data.js";

export function FilesApp({ onFixtureNotice }) {
  const [files, setFiles] = useState(initialFiles.map((item) => ({ ...item })));
  const [location, setLocation] = useState("Cloud drive");
  const [selectedId, setSelectedId] = useState(initialFiles[0].id);
  const [view, setView] = useState("list");
  const visibleFiles = useMemo(() => files.filter((item) => item.location === location), [files, location]);
  const selected = files.find((item) => item.id === selectedId);

  const createFolder = () => {
    const count = files.filter((item) => item.name.startsWith("New folder")).length;
    const name = count ? `New folder ${count + 1}` : "New folder";
    const item = { id: `folder-${files.length + 1}`, name, type: "folder", location: "Cloud drive", size: "—", modified: "Just now" };
    setFiles((current) => [...current, item]);
    setLocation("Cloud drive");
    setSelectedId(item.id);
  };

  const rename = () => {
    if (!selected) return;
    setFiles((current) => current.map((item) => item.id === selected.id ? { ...item, name: item.name.includes("renamed") ? item.name : `${item.name.replace(/(\.[^.]+)?$/, "")} renamed${item.type === "file" && item.name.includes(".") ? `.${item.name.split(".").pop()}` : ""}` } : item));
  };

  const move = () => {
    if (!selected || selected.location === "Trash") return;
    setFiles((current) => current.map((item) => item.id === selected.id ? { ...item, location: item.location === "Cloud drive" ? "Projects" : "Cloud drive" } : item));
    setSelectedId(null);
  };

  const trash = () => {
    if (!selected) return;
    setFiles((current) => current.map((item) => item.id === selected.id ? { ...item, previousLocation: item.location, location: "Trash" } : item));
    setSelectedId(null);
  };

  const restore = () => {
    if (!selected || selected.location !== "Trash") return;
    setFiles((current) => current.map((item) => item.id === selected.id ? { ...item, location: item.previousLocation ?? "Cloud drive", previousLocation: undefined } : item));
    setSelectedId(null);
  };

  const upload = () => {
    const item = { id: `upload-${files.length + 1}`, name: "uploaded-brief.pdf", type: "file", location, size: "1.8 MB", modified: "Just now" };
    setFiles((current) => [...current, item]);
    setSelectedId(item.id);
    onFixtureNotice("Fixture upload complete", "A deterministic file was added to this in-memory workspace. No local file was read.");
  };

  return (
    <div className="app-view files-app" data-testid="files-app">
      <aside className="files-sidebar" aria-label="Fixture folders">
        <strong>Cloud files</strong>
        {["Cloud drive", "Projects", "Shared", "Backups", "Trash"].map((item) => <button key={item} className={location === item ? "is-selected" : ""} onClick={() => { setLocation(item); setSelectedId(null); }}>{item === "Trash" ? <Trash /> : <Folder />}<span>{item}</span></button>)}
        <div className="sidebar-footnote">Fixture filesystem only</div>
      </aside>
      <section className="files-main">
        <header className="files-toolbar">
          <div><span className="eyebrow">Location</span><strong>{location}</strong></div>
          <div className="toolbar-actions">
            <button onClick={createFolder}><FolderPlus /> <span>New folder</span></button>
            <button onClick={upload}><UploadSimple /> <span>Fixture upload</span></button>
            <button aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><ListBullets /></button>
            <button aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><GridFour /></button>
          </div>
        </header>
        <div className="selection-actions" aria-label="Selected file actions">
          <span>{selected ? selected.name : "Select an item"}</span>
          <button disabled={!selected} onClick={rename}><PencilSimple /> Rename</button>
          <button disabled={!selected || selected?.location === "Trash"} onClick={move}><ArrowsLeftRight /> Move</button>
          {location === "Trash" ? <button disabled={!selected} onClick={restore}><ArrowCounterClockwise /> Restore</button> : <button disabled={!selected} onClick={trash}><Trash /> Trash</button>}
          <button disabled={!selected || selected?.type !== "file"} onClick={() => onFixtureNotice("Fixture download ready", `${selected?.name} was prepared as a presentation-only download.`)}><DownloadSimple /> Download</button>
        </div>
        <div className={`file-list view-${view}`} role={view === "list" ? "table" : "list"} aria-label={`${location} fixture contents`}>
          {visibleFiles.length ? visibleFiles.map((item) => <button key={item.id} className={selectedId === item.id ? "is-selected" : ""} onClick={() => setSelectedId(item.id)} onDoubleClick={() => item.type === "folder" && setLocation(item.name === "Starter Project" ? "Projects" : "Cloud drive")}>{item.type === "folder" ? <Folder weight="duotone" /> : <File weight="duotone" />}<span className="file-name">{item.name}</span><span className="file-type">{item.type === "folder" ? "Folder" : "File"}</span><span className="file-size">{item.size}</span><span className="file-modified">{item.modified}</span></button>) : <div className="empty-folder"><Folder size={34} /><strong>This fixture folder is empty</strong><span>Create a folder or add a fixture upload.</span></div>}
        </div>
      </section>
    </div>
  );
}
