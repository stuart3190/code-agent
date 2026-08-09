import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";

export function ModalLayer({ modal, onClose }) {
  if (!modal) return <div className="modal-layer" data-modal-layer />;
  const Icon = modal.tone === "warning" ? WarningCircle : modal.tone === "success" ? CheckCircle : Info;
  return (
    <div className="modal-layer is-visible" data-modal-layer onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="fixture-dialog" role="dialog" aria-modal="true" aria-labelledby="fixture-dialog-title">
        <button className="dialog-close" aria-label="Close dialog" onClick={onClose}><X /></button>
        <Icon className={`dialog-icon tone-${modal.tone ?? "info"}`} size={30} weight="duotone" />
        <h2 id="fixture-dialog-title">{modal.title}</h2>
        <p>{modal.message}</p>
        <button className="primary-button" onClick={onClose}>{modal.actionLabel ?? "Done"}</button>
      </section>
    </div>
  );
}
