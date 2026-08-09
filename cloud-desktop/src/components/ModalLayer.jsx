import { useEffect, useRef } from "react";
import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";

export function ModalLayer({ modal, onClose }) {
  const dialogRef = useRef(null);
  const previousFocus = useRef(null);

  useEffect(() => {
    if (!modal) return undefined;
    previousFocus.current = document.activeElement;
    requestAnimationFrame(() => dialogRef.current?.querySelector("button")?.focus());
    const handleKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const focusable = [...dialogRef.current.querySelectorAll("button")];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus.current?.focus?.();
    };
  }, [modal]);

  if (!modal) return <div className="modal-layer" data-modal-layer />;
  const Icon = modal.tone === "warning" ? WarningCircle : modal.tone === "success" ? CheckCircle : Info;
  return (
    <div className="modal-layer is-visible" data-modal-layer onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="fixture-dialog" role="dialog" aria-modal="true" aria-labelledby="fixture-dialog-title" aria-describedby="fixture-dialog-description">
        <button className="dialog-close" aria-label="Close dialog" onClick={onClose}><X /></button>
        <Icon className={`dialog-icon tone-${modal.tone ?? "info"}`} size={30} weight="duotone" />
        <h2 id="fixture-dialog-title">{modal.title}</h2>
        <p id="fixture-dialog-description">{modal.message}</p>
        <button className="primary-button" onClick={onClose}>{modal.actionLabel ?? "Done"}</button>
      </section>
    </div>
  );
}
