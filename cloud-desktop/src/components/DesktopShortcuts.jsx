import { useEffect, useRef, useState } from "react";
import { applicationRegistry } from "../apps/registry.js";
import { AppIcon } from "./AppIcon.jsx";

const DRAG_THRESHOLD = 5;

export function DesktopShortcuts({ positions, windows, focusedApplication, actions }) {
  const [selectedApplication, setSelectedApplication] = useState(null);
  const [dragPreview, setDragPreview] = useState(null);
  const dragRef = useRef(null);

  useEffect(() => () => {
    window.removeEventListener("pointermove", dragRef.current?.move);
    window.removeEventListener("pointerup", dragRef.current?.up);
  }, []);

  const beginMouseDrag = (event, applicationId) => {
    setSelectedApplication(applicationId);
    if (event.pointerType === "touch" || event.button !== 0) return;
    const origin = positions[applicationId];
    const canvasRect = event.currentTarget.closest(".desktop-canvas")?.getBoundingClientRect();
    if (!origin || !canvasRect) return;

    const session = {
      applicationId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      canvasRect,
      moved: false,
    };
    session.move = (moveEvent) => {
      if (moveEvent.pointerId !== session.pointerId) return;
      const deltaX = moveEvent.clientX - session.startX;
      const deltaY = moveEvent.clientY - session.startY;
      if (!session.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
      session.moved = true;
      setDragPreview({ applicationId, x: origin.x + deltaX, y: origin.y + deltaY });
    };
    session.up = (upEvent) => {
      if (upEvent.pointerId !== session.pointerId) return;
      window.removeEventListener("pointermove", session.move);
      window.removeEventListener("pointerup", session.up);
      if (session.moved) {
        actions.moveDesktopShortcut(
          applicationId,
          origin.x + upEvent.clientX - session.startX,
          origin.y + upEvent.clientY - session.startY,
        );
      }
      setDragPreview(null);
      dragRef.current = null;
    };
    dragRef.current = session;
    window.addEventListener("pointermove", session.move);
    window.addEventListener("pointerup", session.up);
  };

  return (
    <div className="desktop-shortcuts" role="group" aria-label="Desktop application shortcuts" data-desktop-shortcuts>
      {applicationRegistry.map((application) => {
        const windowState = windows[application.id];
        const active = focusedApplication === application.id && windowState?.isOpen && !windowState.minimized;
        const preview = dragPreview?.applicationId === application.id ? dragPreview : positions[application.id];
        return (
          <button
            key={application.id}
            type="button"
            className={`desktop-shortcut ${selectedApplication === application.id ? "is-selected" : ""} ${active ? "is-active" : ""} ${windowState?.isOpen ? "is-running" : ""}`}
            style={{ transform: `translate(${preview.x}px, ${preview.y}px)` }}
            aria-label={`${application.title} desktop shortcut. Double-click or press Enter to open.`}
            aria-pressed={active}
            data-desktop-shortcut={application.id}
            data-running={windowState?.isOpen ? "true" : "false"}
            data-focused={active ? "true" : "false"}
            onClick={() => setSelectedApplication(application.id)}
            onDoubleClick={() => actions.open(application.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                actions.open(application.id);
              }
            }}
            onPointerDown={(event) => beginMouseDrag(event, application.id)}
            onPointerUp={(event) => {
              if (event.pointerType === "touch") actions.open(application.id);
            }}
          >
            <span className={`desktop-shortcut-icon app-tone-${application.id}`}><AppIcon name={application.icon} size={28} /></span>
            <span className="desktop-shortcut-label">{application.title}</span>
            {windowState?.isOpen && <span className="desktop-shortcut-state"><span className="sr-only">{active ? "Focused" : windowState.minimized ? "Minimized" : "Running"}</span></span>}
          </button>
        );
      })}
    </div>
  );
}
