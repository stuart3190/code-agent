import { useRef, useState } from "react";
import { ArrowsOutSimple, CaretDown, CopySimple, Minus, SquareHalf, X } from "@phosphor-icons/react";
import { getApplication } from "../apps/registry.js";
import { AppIcon } from "./AppIcon.jsx";

export function WindowFrame({ windowState, active, viewportMode, actions, children }) {
  const application = getApplication(windowState.applicationId);
  const frameRef = useRef(null);
  const dragOrigin = useRef(null);
  const resizeOrigin = useRef(null);
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);

  if (!windowState.isOpen || windowState.minimized) return null;
  if (viewportMode === "mobile" && !active) return null;

  const interactiveMove = (event) => {
    if (viewportMode !== "desktop" || windowState.maximized || windowState.snap) return;
    if (event.target.closest("button, input, select")) return;
    const origin = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: windowState.bounds };
    dragOrigin.current = origin;
    actions.focus(application.id);
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== origin.pointerId) return;
      if (frameRef.current) frameRef.current.style.transform = `translate(${moveEvent.clientX - origin.x}px, ${moveEvent.clientY - origin.y}px)`;
    };
    const finish = (upEvent) => {
      if (upEvent.pointerId !== origin.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (frameRef.current) frameRef.current.style.transform = "";
      if (upEvent.clientY <= 12) actions.snap(application.id, "maximize");
      else if (upEvent.clientX <= 16) actions.snap(application.id, "left");
      else if (upEvent.clientX >= window.innerWidth - 16) actions.snap(application.id, "right");
      else actions.move(application.id, origin.bounds.x + upEvent.clientX - origin.x, origin.bounds.y + upEvent.clientY - origin.y);
      dragOrigin.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const beginResize = (event) => {
    if (viewportMode !== "desktop" || windowState.maximized || windowState.snap) return;
    const origin = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: windowState.bounds };
    resizeOrigin.current = origin;
    event.preventDefault();
    const resize = (moveEvent) => {
      if (moveEvent.pointerId !== origin.pointerId) return;
      if (frameRef.current) {
        frameRef.current.style.width = `${origin.bounds.width + moveEvent.clientX - origin.x}px`;
        frameRef.current.style.height = `${origin.bounds.height + moveEvent.clientY - origin.y}px`;
      }
    };
    const finish = (upEvent) => {
      if (upEvent.pointerId !== origin.pointerId) return;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (frameRef.current) {
        frameRef.current.style.width = `${origin.bounds.width}px`;
        frameRef.current.style.height = `${origin.bounds.height}px`;
      }
      actions.resize(application.id, origin.bounds.width + upEvent.clientX - origin.x, origin.bounds.height + upEvent.clientY - origin.y);
      resizeOrigin.current = null;
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const style = viewportMode === "desktop" ? {
    left: windowState.bounds.x,
    top: windowState.bounds.y,
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    zIndex: windowState.zIndex,
  } : { zIndex: windowState.zIndex };

  return (
    <section
      aria-label={`${application.title} application window`}
      ref={frameRef}
      className={`app-window ${active ? "is-active" : ""} ${windowState.maximized ? "is-maximized" : ""}`}
      data-application-window={application.id}
      data-window-state={windowState.maximized ? "maximized" : windowState.snap ?? "floating"}
      onPointerDown={() => actions.focus(application.id)}
      style={style}
    >
      <header
        className="window-titlebar"
        data-testid={`titlebar-${application.id}`}
        onDoubleClick={() => actions.maximize(application.id)}
        onPointerDown={interactiveMove}
      >
        <div className="window-title">
          <AppIcon name={application.icon} size={19} />
          <span>{application.title}</span>
        </div>
        <div className="window-controls" aria-label={`${application.title} window controls`}>
          <button aria-label={`Minimize ${application.title}`} data-action="minimize" onClick={() => actions.minimize(application.id)}><Minus /></button>
          <div className="snap-control">
            <button aria-expanded={snapMenuOpen} aria-label={`Arrange ${application.title}`} data-action="snap-menu" onClick={() => setSnapMenuOpen((open) => !open)}><SquareHalf /><CaretDown size={10} /></button>
            {snapMenuOpen && (
              <div className="snap-menu" role="menu">
                <button role="menuitem" onClick={() => { actions.snap(application.id, "left"); setSnapMenuOpen(false); }}><SquareHalf /> Left half</button>
                <button role="menuitem" onClick={() => { actions.snap(application.id, "right"); setSnapMenuOpen(false); }}><CopySimple /> Right half</button>
                <button role="menuitem" onClick={() => { actions.snap(application.id, "maximize"); setSnapMenuOpen(false); }}><ArrowsOutSimple /> Maximize</button>
              </div>
            )}
          </div>
          <button aria-label={`${windowState.maximized || windowState.snap ? "Restore" : "Maximize"} ${application.title}`} data-action="maximize" onClick={() => actions.maximize(application.id)}><ArrowsOutSimple /></button>
          <button aria-label={`Close ${application.title}`} className="close-control" data-action="close" onClick={() => actions.close(application.id)}><X /></button>
        </div>
      </header>
      <div className="window-content">{children}</div>
      <button
        className="window-resize-handle"
        aria-label={`Resize ${application.title}`}
        data-testid={`resize-${application.id}`}
        onPointerDown={beginResize}
      />
    </section>
  );
}
