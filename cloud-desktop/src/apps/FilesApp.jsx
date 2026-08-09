import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArrowCounterClockwise, ArrowLeft, ArrowRight, ArrowUp, BracketsCurly, CaretLeft, CaretRight,
  CheckSquare, Copy, DownloadSimple, File, FileCode, FileDashed, FilePdf, FileText, Folder, FolderPlus,
  GridFour, Image, LinkSimple, ListBullets, Lock, MagnifyingGlass, PencilSimple, SquaresFour, Trash,
  UploadSimple, WarningCircle, X,
} from "@phosphor-icons/react";
import { FIXTURE_UPLOADS } from "../filesystem/fixtureProvider.js";
import { basenameVirtualPath, parentVirtualPath } from "../filesystem/virtualPath.js";
import { ROOT_FOLDERS } from "../filesystem/fixtures.js";

const iconByKind = { folder: Folder, text: FileText, code: FileCode, image: Image, document: FilePdf, archive: Archive, data: BracketsCurly, binary: FileDashed, symlink: LinkSimple };
const kindLabels = { folder: "Folder", text: "Text file", code: "Code file", image: "Image", document: "Document", archive: "Archive", data: "Data file", binary: "Binary file", symlink: "Fixture link" };
const formatBytes = (bytes) => {
  if (!bytes) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

function ItemIcon({ item, size = 20 }) {
  const Icon = iconByKind[item.kind] ?? File;
  return <span className={`file-kind-icon kind-${item.kind}`} aria-hidden="true"><Icon size={size} weight="duotone" />{item.restricted && <Lock className="file-lock-badge" size={10} />}</span>;
}

function FileDialog({ dialog, close, submit, destinations = [] }) {
  const [value, setValue] = useState(dialog.initialValue ?? "");
  const [destination, setDestination] = useState(dialog.initialDestination ?? destinations[0]?.path ?? "/My Files");
  const [fixtureId, setFixtureId] = useState("campaign-board");
  const titleId = `files-dialog-${dialog.type}`;
  const dialogRef = useRef(null);
  useEffect(() => { (dialogRef.current?.querySelector("input, select") ?? dialogRef.current?.querySelector("button"))?.focus(); }, []);
  const handleDialogKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const controls = [...dialogRef.current.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
    if (!controls.length) return;
    const next = event.shiftKey ? controls.indexOf(document.activeElement) - 1 : controls.indexOf(document.activeElement) + 1;
    if (next < 0 || next >= controls.length) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus(); }
  };
  return (
    <div className="files-dialog-layer" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className="files-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleDialogKey}>
        <button className="files-dialog-close" aria-label="Close file dialog" onClick={close}><X /></button>
        <span className="eyebrow">Fixture operation</span>
        <h3 id={titleId}>{dialog.title}</h3>
        {dialog.message && <p>{dialog.message}</p>}
        {dialog.type === "name" && <label>Item name<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit({ value }); if (event.key === "Escape") close(); }} /></label>}
        {dialog.type === "destination" && <label>Destination<select autoFocus value={destination} onChange={(event) => setDestination(event.target.value)}>{destinations.map((folder) => <option key={folder.id} value={folder.path}>{folder.path}</option>)}</select></label>}
        {dialog.type === "upload" && <>
          <div className="fixture-drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); dialog.onRealDrop?.(); }}><UploadSimple size={24} /><strong>Synthetic uploads only</strong><span>No browser file picker or local file access.</span></div>
          <label>Bundled fixture<select value={fixtureId} onChange={(event) => setFixtureId(event.target.value)}>{Object.values(FIXTURE_UPLOADS).map((fixture) => <option key={fixture.fixtureId} value={fixture.fixtureId}>{fixture.name} · {formatBytes(fixture.sizeBytes)}</option>)}</select></label>
        </>}
        {dialog.type === "conflict" && <div className="conflict-review"><WarningCircle size={24} /><strong>{dialog.code.replaceAll("_", " ")}</strong><span>{dialog.message}</span></div>}
        <div className="files-dialog-actions">
          <button className="secondary-button" onClick={close}>Cancel</button>
          {dialog.type === "conflict" ? <>
            <button className="secondary-button" onClick={() => submit({ policy: "keep_both" })}>Keep both</button>
            <button className="primary-button" onClick={() => submit({ policy: "replace" })}>Replace fixture</button>
          </> : <button className={dialog.destructive ? "danger-button" : "primary-button"} onClick={() => submit({ value, destination, fixtureId })}>{dialog.actionLabel ?? "Continue"}</button>}
        </div>
      </section>
    </div>
  );
}

export function FilesApp({ filesystem, onFixtureNotice }) {
  const { provider, snapshot, storage, ui, setUi, navigate, back, forward, scenario, recovery } = filesystem;
  const [dialog, setDialog] = useState(null);
  const [detailsId, setDetailsId] = useState(null);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState(recovery ? "Corrupt fixture file state was safely recovered" : "Files ready");
  const rowRefs = useRef(new Map());
  const actionButtonRef = useRef(null);
  const actionMenuRef = useRef(null);
  const listing = useMemo(() => provider.list(ui.currentPath, { query: ui.query, sort: ui.sort, page: ui.page, pageSize: 100 }), [provider, snapshot, ui.currentPath, ui.query, ui.sort, ui.page]);
  const destinationResult = useMemo(() => provider.listDestinations(), [provider, snapshot]);
  const selectedItems = ui.selectedIds.map((id) => snapshot.items.find((entry) => entry.id === id)).filter(Boolean);
  const selected = selectedItems[0] ?? null;
  const details = snapshot.items.find((entry) => entry.id === detailsId) ?? null;
  const breadcrumbs = ui.currentPath.split("/").filter(Boolean);
  useEffect(() => { if (actionMenuOpen) actionMenuRef.current?.querySelector("button:not(:disabled)")?.focus(); }, [actionMenuOpen]);
  const handleActionMenuKey = (event) => {
    if (event.key === "Escape") { setActionMenuOpen(false); actionButtonRef.current?.focus(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...actionMenuRef.current.querySelectorAll("button:not(:disabled)")];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };

  const notify = (message, tone = "success") => {
    setAnnouncement(message);
    if (tone === "error") onFixtureNotice("Fixture file operation", message, "warning");
  };
  const resultNotice = (result, successMessage) => {
    if (result.ok) { notify(successMessage); return true; }
    notify(result.message, "error"); return false;
  };
  const selectItem = (item, additive = false) => {
    setActionMenuOpen(false);
    setUi((current) => ({ selectedIds: additive ? (current.selectedIds.includes(item.id) ? current.selectedIds.filter((id) => id !== item.id) : [...current.selectedIds, item.id]) : [item.id] }));
  };
  const openItem = (item) => {
    if (item.kind === "folder") navigate(item.path);
    else { setDetailsId(item.id); setAnnouncement(`${item.name} details opened`); }
  };
  const openNameDialog = (mode) => {
    const isCreate = mode === "create";
    setDialog({ type: "name", mode, title: isCreate ? "Create a fixture folder" : `Rename ${selected?.name}`, initialValue: isCreate ? "" : selected?.name, actionLabel: isCreate ? "Create folder" : "Rename" });
  };
  const submitName = ({ value, policy = "cancel" }) => {
    const pending = dialog.pending;
    const result = pending
      ? pending(policy)
      : dialog.mode === "create"
        ? provider.createDirectory(ui.currentPath, value, { conflictPolicy: policy })
        : provider.rename(selected.path, value, { expectedRevision: selected.revision, conflictPolicy: policy });
    if (!result.ok && result.conflict) {
      setDialog({ type: "conflict", sourceMode: "name", title: "Name conflict", code: result.code, message: result.message, pending: (nextPolicy) => dialog.mode === "create" ? provider.createDirectory(ui.currentPath, value, { conflictPolicy: nextPolicy }) : provider.rename(selected.path, value, { expectedRevision: selected.revision, conflictPolicy: nextPolicy }) });
      return;
    }
    if (resultNotice(result, dialog.mode === "create" ? "Fixture folder created" : result.unchanged ? "Name was unchanged" : "Fixture item renamed")) {
      setUi({ selectedIds: result.item ? [result.item.id] : [] }); setDialog(null);
    }
  };
  const openDestination = (mode) => setDialog({ type: "destination", mode, title: `${mode === "move" ? "Move" : "Copy"} ${selected?.name}`, actionLabel: mode === "move" ? "Move fixture" : "Copy fixture", initialDestination: "/Projects" });
  const submitDestination = ({ destination, policy = "cancel" }) => {
    const invoke = (nextPolicy) => dialog.mode === "move"
      ? provider.move(selected.path, destination, { expectedRevision: selected.revision, conflictPolicy: nextPolicy })
      : provider.copy(selected.path, destination, { expectedRevision: selected.revision, conflictPolicy: nextPolicy });
    const result = dialog.pending ? dialog.pending(policy) : invoke(policy);
    if (!result.ok && result.conflict) { setDialog({ type: "conflict", sourceMode: "destination", title: "Destination conflict", code: result.code, message: result.message, pending: invoke }); return; }
    if (resultNotice(result, `Fixture item ${dialog.mode === "move" ? "moved" : "copied"}`)) { setUi({ selectedIds: [] }); setDialog(null); }
  };
  const trashSelected = () => {
    setActionMenuOpen(false);
    const results = selectedItems.map((item) => provider.trash(item.path, { expectedRevision: item.revision }));
    if (results.every((result) => result.ok)) { setUi({ selectedIds: [] }); notify(`${results.length} fixture item${results.length === 1 ? "" : "s"} moved to Trash`); }
    else resultNotice(results.find((result) => !result.ok), "");
  };
  const restoreSelected = () => {
    setActionMenuOpen(false);
    const result = provider.restore(selected.path);
    if (resultNotice(result, result.recoveryLocation ? `Restored to ${result.recoveryLocation} because the original folder was missing` : "Fixture item restored")) { setUi({ selectedIds: [] }); setDialog(null); }
  };
  const deleteSelected = () => { setActionMenuOpen(false); setDialog({ type: "confirm", title: `Delete ${selected.name} permanently?`, message: "This removes only deterministic fixture state. The action cannot be undone inside this fixture session.", destructive: true, actionLabel: "Delete fixture permanently", mode: "delete" }); };
  const submitDialog = (values) => {
    if (dialog.type === "name" || dialog.type === "conflict" && dialog.sourceMode === "name") return submitName(values);
    if (dialog.type === "destination" || dialog.type === "conflict" && dialog.sourceMode === "destination") return submitDestination(values);
    if (dialog.type === "upload") {
      const result = provider.beginFixtureUpload(ui.currentPath, values.fixtureId);
      if (resultNotice(result, result.ok ? `${result.transfer.name} fixture upload started` : "")) setDialog(null);
      return;
    }
    if (dialog.mode === "delete") {
      const result = provider.delete(selected.path, { confirmed: true, expectedRevision: selected.revision });
      if (resultNotice(result, "Fixture item permanently deleted")) { setUi({ selectedIds: [] }); setDialog(null); }
    }
  };
  const download = () => {
    setActionMenuOpen(false);
    const result = provider.beginFixtureDownload(selected.path);
    resultNotice(result, result.ok ? `${selected.name} is preparing for a local fixture download simulation` : "");
  };
  const handleRowKey = (event, item, index) => {
    if (event.key === "Enter") { event.preventDefault(); openItem(item); }
    if (event.key === " ") { event.preventDefault(); selectItem(item, event.ctrlKey || event.metaKey); }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const next = Math.max(0, Math.min(listing.items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      rowRefs.current.get(listing.items[next]?.id)?.focus();
    }
    if (event.key === "Escape") { setUi({ selectedIds: [] }); setActionMenuOpen(false); setDetailsId(null); }
  };

  if (snapshot.availability === "loading") return <div className="app-view files-state-view" data-files-state="loading" role="status"><SquaresFour size={34} /><h2>Loading fixture files</h2><p>Preparing deterministic cloud-file metadata.</p></div>;
  if (!listing.ok) return <div className="app-view files-state-view" data-files-state={listing.code} role="status"><WarningCircle size={34} /><h2>{listing.code === "offline" ? "Files are offline" : "Files are unavailable"}</h2><p>Your C2 desktop layout remains available. No network fallback will be attempted.</p></div>;

  return (
    <div className="app-view files-app c3-files-app" data-testid="files-app" data-files-scenario={scenario}>
      <aside className="files-sidebar" aria-label="Fixture folders">
        <strong>Cloud files</strong>
        {ROOT_FOLDERS.map((path) => <button key={path} className={ui.currentPath === path || ui.currentPath.startsWith(`${path}/`) ? "is-selected" : ""} onClick={() => navigate(path)}>{path === "/Trash" ? <Trash /> : <Folder />}<span>{basenameVirtualPath(path)}</span></button>)}
        <div className="sidebar-storage"><span><b>{Math.round(storage.usedBytes / 1024 ** 3)} GB</b> of {Math.round(storage.quotaBytes / 1024 ** 3)} GB</span><div role="meter" aria-label="Fixture storage used" aria-valuemin="0" aria-valuemax={storage.quotaBytes} aria-valuenow={storage.usedBytes}><i style={{ width: `${Math.min(100, storage.ratio * 100)}%` }} /></div></div>
        <div className="sidebar-footnote">Virtual fixture filesystem only</div>
      </aside>
      <section className="files-main">
        <header className="files-toolbar c3-files-toolbar">
          <div className="file-nav-controls" aria-label="Folder navigation">
            <button aria-label="Back" disabled={ui.historyIndex <= 0} onClick={back}><ArrowLeft /></button>
            <button aria-label="Forward" disabled={ui.historyIndex >= ui.history.length - 1} onClick={forward}><ArrowRight /></button>
            <button aria-label="Up one folder" disabled={!parentVirtualPath(ui.currentPath)} onClick={() => navigate(parentVirtualPath(ui.currentPath) ?? "/My Files")}><ArrowUp /></button>
            <button aria-label="Refresh fixture files" onClick={() => { setAnnouncement("Fixture folder refreshed"); setUi({ selectedIds: [] }); }}><ArrowCounterClockwise /></button>
          </div>
          <nav className="files-breadcrumbs" aria-label="Current virtual path"><button onClick={() => navigate("/My Files")}>Cloud</button>{breadcrumbs.map((segment, index) => { const path = `/${breadcrumbs.slice(0, index + 1).join("/")}`; return <span key={path}><CaretRight /><button aria-current={index === breadcrumbs.length - 1 ? "page" : undefined} onClick={() => navigate(path)}>{segment}</button></span>; })}</nav>
          <div className="toolbar-actions">
            <button aria-label="New folder" onClick={() => openNameDialog("create")}><FolderPlus /><span>New folder</span></button>
            <button aria-label="Synthetic fixture upload" onClick={() => setDialog({ type: "upload", title: "Add a synthetic fixture file", actionLabel: "Start fixture upload", onRealDrop: () => notify("Real files are disabled in C3. Choose a bundled synthetic fixture instead.", "error") })}><UploadSimple /><span>Upload fixture</span></button>
          </div>
        </header>
        <div className="files-commandbar">
          <label className="files-search"><MagnifyingGlass /><span className="sr-only">Search current fixture folder</span><input placeholder="Search this folder" value={ui.query} onChange={(event) => setUi({ query: event.target.value, page: 1 })} /></label>
          <select aria-label="Sort files" value={ui.sort} onChange={(event) => setUi({ sort: event.target.value, page: 1 })}><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="modified-desc">Recently modified</option><option value="size-desc">Largest first</option><option value="type-asc">Type</option></select>
          <button aria-label="List view" aria-pressed={ui.view === "list"} onClick={() => setUi({ view: "list" })}><ListBullets /></button>
          <button aria-label="Grid view" aria-pressed={ui.view === "grid"} onClick={() => setUi({ view: "grid" })}><GridFour /></button>
          <span className="file-count">{listing.total.toLocaleString()} item{listing.total === 1 ? "" : "s"}</span>
        </div>
        <div className="selection-actions c3-selection-actions" aria-label="Selected file actions">
          <span>{selectedItems.length ? `${selectedItems.length} selected` : "Select an item"}</span>
          {selectedItems.length === 1 && <>
            <button onClick={() => openItem(selected)}>Open</button>
            <button onClick={() => { setDetailsId(selected.id); setActionMenuOpen(false); }}>Details</button>
          </>}
          <div className="file-action-menu-wrap">
            <button ref={actionButtonRef} aria-haspopup="menu" aria-expanded={actionMenuOpen} disabled={!selectedItems.length} onClick={() => setActionMenuOpen((open) => !open)}>Actions</button>
            {actionMenuOpen && <div ref={actionMenuRef} className="file-action-menu" role="menu" onKeyDown={handleActionMenuKey}>
              <button role="menuitem" disabled={selectedItems.length !== 1 || selected.restricted || selected.readOnly} onClick={() => { openNameDialog("rename"); setActionMenuOpen(false); }}><PencilSimple /> Rename</button>
              <button role="menuitem" disabled={selectedItems.length !== 1 || selected.restricted || ui.currentPath === "/Trash"} onClick={() => { openDestination("move"); setActionMenuOpen(false); }}><ArrowRight /> Move to…</button>
              <button role="menuitem" disabled={selectedItems.length !== 1 || ui.currentPath === "/Trash"} onClick={() => { openDestination("copy"); setActionMenuOpen(false); }}><Copy /> Copy to…</button>
              {ui.currentPath === "/Trash" ? <>
                <button role="menuitem" disabled={selectedItems.length !== 1} onClick={restoreSelected}><ArrowCounterClockwise /> Restore</button>
                <button role="menuitem" disabled={selectedItems.length !== 1} onClick={deleteSelected}><Trash /> Delete permanently</button>
              </> : <button role="menuitem" disabled={selectedItems.some((item) => item.restricted || item.readOnly)} onClick={trashSelected}><Trash /> Move to Trash</button>}
              <button role="menuitem" disabled={selectedItems.length !== 1 || selected.kind === "folder" || selected.restricted} onClick={download}><DownloadSimple /> Fixture download</button>
            </div>}
          </div>
        </div>
        <div className={`file-list c3-file-list view-${ui.view}`} role="listbox" aria-label={`${ui.currentPath} fixture contents`} aria-multiselectable="true">
          {listing.items.length ? listing.items.map((item, index) => <button
            key={item.id}
            ref={(element) => element ? rowRefs.current.set(item.id, element) : rowRefs.current.delete(item.id)}
            role="option"
            aria-selected={ui.selectedIds.includes(item.id)}
            className={ui.selectedIds.includes(item.id) ? "is-selected" : ""}
            onClick={(event) => selectItem(item, event.ctrlKey || event.metaKey)}
            onDoubleClick={() => openItem(item)}
            onKeyDown={(event) => handleRowKey(event, item, index)}
          >
            <span className="file-select-box" aria-hidden="true">{ui.selectedIds.includes(item.id) ? <CheckSquare weight="fill" /> : <span />}</span>
            <ItemIcon item={item} size={ui.view === "grid" ? 30 : 20} />
            <span className="file-name">{item.name}</span>
            <span className="file-type">{kindLabels[item.kind] ?? "Unknown"}{item.readOnly ? " · Read-only" : ""}{item.restricted ? " · Restricted" : ""}</span>
            <span className="file-size">{formatBytes(item.sizeBytes)}</span>
            <span className="file-modified">{new Date(item.modifiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          </button>) : <div className="empty-folder"><Folder size={34} /><strong>{ui.query ? "No fixture items match" : "This fixture folder is empty"}</strong><span>{ui.query ? "Clear the search to see every item." : "Create a folder or add a synthetic fixture upload."}</span></div>}
        </div>
        {listing.totalPages > 1 && <nav className="file-pagination" aria-label="Large directory pages"><button disabled={listing.page === 1} onClick={() => setUi({ page: listing.page - 1 })}><CaretLeft /> Previous</button><span>Page {listing.page} of {listing.totalPages} · {listing.total.toLocaleString()} entries</span><button disabled={listing.page === listing.totalPages} onClick={() => setUi({ page: listing.page + 1 })}>Next <CaretRight /></button></nav>}
        {snapshot.transfers.length > 0 && <aside className="transfer-tray" aria-label="Fixture transfers"><strong>Fixture transfers</strong>{snapshot.transfers.slice(-3).map((transfer) => <div key={transfer.id} data-transfer-status={transfer.status}><span>{transfer.direction === "upload" ? <UploadSimple /> : <DownloadSimple />}<b>{transfer.name}</b><small>{transfer.status.replaceAll("_", " ")}</small></span><div>{!["completed", "failed", "canceled"].includes(transfer.status) && <><button onClick={() => provider.advanceTransfer(transfer.id)}>Advance fixture</button><button onClick={() => provider.cancelTransfer(transfer.id)}>Cancel</button></>}</div></div>)}</aside>}
      </section>
      {details && <aside className="file-details" aria-label="File details"><button aria-label="Close file details" onClick={() => { setDetailsId(null); setUi({ selectedIds: [] }); }}><X /></button><ItemIcon item={details} size={34} /><h3>{details.name}</h3><dl><div><dt>Type</dt><dd>{kindLabels[details.kind] ?? "Unknown"}</dd></div><div><dt>Size</dt><dd>{formatBytes(details.sizeBytes)}</dd></div><div><dt>Location</dt><dd>{details.parentPath}</dd></div><div><dt>Revision</dt><dd>{details.revision}</dd></div><div><dt>Source</dt><dd>{details.source.replaceAll("_", " ")}</dd></div></dl>{details.preview ? <pre>{details.preview}</pre> : <p>No safe preview is available for this fixture type.</p>}{details.kind === "symlink" && <p>This is a fixture link to {details.targetPath}. C3 never follows a host symlink.</p>}</aside>}
      {dialog && <FileDialog dialog={dialog} close={() => setDialog(null)} submit={submitDialog} destinations={destinationResult.items ?? []} />}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    </div>
  );
}
