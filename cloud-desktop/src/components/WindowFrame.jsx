import { useEffect, useRef, useState } from "react";
import { ArrowsOutCardinal, ArrowsOutSimple, CopySimple, Minus, SquareHalf, X } from "@phosphor-icons/react";
import { getApplication } from "../apps/registry.js";
import { resizeBounds } from "../state/windowManager.js";
import { AppIcon } from "./AppIcon.jsx";

const resizeEdges = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];

function snapZone(event) {
  if (event.clientY <= 18) return "maximize";
  if (event.clientX <= 22) return "left";
  if (event.clientX >= window.innerWidth - 22) return "right";
  return null;
}

export function WindowFrame({ windowState, active, viewportMode, viewport, actions, children }) {
  const application = getApplication(windowState.applicationId);
  const frameRef = useRef(null);
  const menuButtonRef = useRef(null);
  const menuRef = useRef(null);
  const [windowMenuOpen, setWindowMenuOpen] = useState(false);
  const [keyboardMode, setKeyboardMode] = useState(null);

  useEffect(() => {
    if (!windowMenuOpen) return undefined;
    const first = menuRef.current?.querySelector("button:not(:disabled)");
    first?.focus();
    const dismiss = (event) => {
      if (!menuRef.current?.contains(event.target) && event.target !== menuButtonRef.current) setWindowMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [windowMenuOpen]);

  if (!windowState.isOpen || windowState.minimized) return null;
  if (viewportMode !== "desktop" && !active) return null;

  const beginMove = (event) => {
    if (viewportMode !== "desktop" || event.target.closest("button, input, select")) return;
    event.preventDefault();
    actions.focus(application.id);
    const pointerTarget = event.currentTarget;
    const startBounds = (windowState.snap || windowState.maximized) ? (windowState.restoreBounds ?? application.defaultBounds) : windowState.bounds;
    if (windowState.snap || windowState.maximized) actions.restoreForMove(application.id);
    const origin = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: startBounds };
    try { pointerTarget.setPointerCapture?.(event.pointerId); } catch { /* A synthetic pointer may not own capture. */ }

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== origin.pointerId) return;
      const dx = moveEvent.clientX - origin.x;
      const dy = moveEvent.clientY - origin.y;
      if (frameRef.current) frameRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      actions.setSnapPreview(snapZone(moveEvent));
    };
    const finish = (upEvent, canceled = false) => {
      if (upEvent.pointerId !== origin.pointerId) return;
      try { if (pointerTarget.hasPointerCapture?.(origin.pointerId)) pointerTarget.releasePointerCapture(origin.pointerId); } catch { /* Pointer already ended. */ }
      pointerTarget.removeEventListener("pointermove", move);
      pointerTarget.removeEventListener("pointerup", finish);
      pointerTarget.removeEventListener("pointercancel", cancel);
      if (frameRef.current) frameRef.current.style.transform = "";
      const zone = canceled ? null : snapZone(upEvent);
      actions.setSnapPreview(null);
      if (canceled) return;
      if (zone) actions.snap(application.id, zone);
      else actions.move(application.id, origin.bounds.x + upEvent.clientX - origin.x, origin.bounds.y + upEvent.clientY - origin.y);
    };
    const cancel = () => finish({ pointerId: origin.pointerId, clientX: origin.x, clientY: origin.y }, true);
    pointerTarget.addEventListener("pointermove", move);
    pointerTarget.addEventListener("pointerup", finish);
    pointerTarget.addEventListener("pointercancel", cancel);
  };

  const beginResize = (event, edge) => {
    if (viewportMode !== "desktop" || windowState.maximized || windowState.snap) return;
    event.preventDefault();
    event.stopPropagation();
    actions.focus(application.id);
    const pointerTarget = event.currentTarget;
    const origin = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: windowState.bounds };
    try { pointerTarget.setPointerCapture?.(event.pointerId); } catch { /* A synthetic pointer may not own capture. */ }
    const preview = (moveEvent) => {
      if (moveEvent.pointerId !== origin.pointerId) return;
      const next = resizeBounds(origin.bounds, edge, moveEvent.clientX - origin.x, moveEvent.clientY - origin.y, viewport, application.minimumSize);
      if (frameRef.current) Object.assign(frameRef.current.style, { left: `${next.x}px`, top: `${next.y}px`, width: `${next.width}px`, height: `${next.height}px` });
    };
    const finish = (upEvent, canceled = false) => {
      if (upEvent.pointerId !== origin.pointerId) return;
      try { if (pointerTarget.hasPointerCapture?.(origin.pointerId)) pointerTarget.releasePointerCapture(origin.pointerId); } catch { /* Pointer already ended. */ }
      pointerTarget.removeEventListener("pointermove", preview);
      pointerTarget.removeEventListener("pointerup", finish);
      pointerTarget.removeEventListener("pointercancel", cancel);
      if (frameRef.current) Object.assign(frameRef.current.style, { left: `${origin.bounds.x}px`, top: `${origin.bounds.y}px`, width: `${origin.bounds.width}px`, height: `${origin.bounds.height}px` });
      if (!canceled) actions.resizeEdge(application.id, edge, upEvent.clientX - origin.x, upEvent.clientY - origin.y);
    };
    const cancel = () => finish({ pointerId: origin.pointerId, clientX: origin.x, clientY: origin.y }, true);
    pointerTarget.addEventListener("pointermove", preview);
    pointerTarget.addEventListener("pointerup", finish);
    pointerTarget.addEventListener("pointercancel", cancel);
  };

  const runMenuAction = (action) => {
    setWindowMenuOpen(false);
    action();
    requestAnimationFrame(() => frameRef.current?.focus());
  };

  const handleMenuKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setWindowMenuOpen(false);
      menuButtonRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...menuRef.current.querySelectorAll("button:not(:disabled)")];
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const handleFrameKey = (event) => {
    if (!keyboardMode || !event.key.startsWith("Arrow")) {
      if (keyboardMode && ["Escape", "Enter"].includes(event.key)) setKeyboardMode(null);
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 1 : 10;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (keyboardMode === "move") actions.move(application.id, windowState.bounds.x + dx, windowState.bounds.y + dy);
    else actions.resizeEdge(application.id, "se", dx, dy);
  };

  const style = viewportMode === "desktop" ? { left: windowState.bounds.x, top: windowState.bounds.y, width: windowState.bounds.width, height: windowState.bounds.height, zIndex: windowState.zIndex } : { zIndex: windowState.zIndex };
  const arrangeDisabled = viewportMode !== "desktop";

  return (
    <section
      aria-label={`${application.title} application window`}
      aria-keyshortcuts="Alt+F4"
      ref={frameRef}
      tabIndex={-1}
      className={`app-window ${active ? "is-active" : ""} ${windowState.maximized ? "is-maximized" : ""} ${keyboardMode ? "is-keyboard-adjusting" : ""}`}
      data-application-window={application.id}
      data-window-state={windowState.maximized ? "maximized" : windowState.snap ?? "floating"}
      data-keyboard-mode={keyboardMode ?? "none"}
      onKeyDown={handleFrameKey}
      onPointerDown={() => actions.focus(application.id)}
      style={style}
    >
      <header className="window-titlebar" data-testid={`titlebar-${application.id}`} onDoubleClick={() => viewportMode === "desktop" && actions.maximize(application.id)} onPointerDown={beginMove}>
        <div className="window-title"><AppIcon name={application.icon} size={19} /><span>{application.title}</span></div>
        <div className="window-controls" aria-label={`${application.title} window controls`}>
          <button aria-label={`Minimize ${application.title}`} data-action="minimize" onClick={() => actions.minimize(application.id)}><Minus /></button>
          <div className="snap-control">
            <button ref={menuButtonRef} aria-haspopup="menu" aria-expanded={windowMenuOpen} aria-label={`Arrange ${application.title}`} data-action="window-menu" onClick={() => setWindowMenuOpen((open) => !open)}><SquareHalf /></button>
            {windowMenuOpen && (
              <div ref={menuRef} className="snap-menu window-menu" role="menu" aria-label={`${application.title} window menu`} onKeyDown={handleMenuKey}>
                <button role="menuitem" disabled={!windowState.snap && !windowState.maximized} onClick={() => runMenuAction(() => actions.maximize(application.id))}><ArrowsOutSimple /> Restore</button>
                <button role="menuitem" disabled={arrangeDisabled || windowState.maximized || windowState.snap} onClick={() => runMenuAction(() => setKeyboardMode("move"))}><ArrowsOutCardinal /> Move</button>
                <button role="menuitem" disabled={arrangeDisabled || windowState.maximized || windowState.snap} onClick={() => runMenuAction(() => setKeyboardMode("resize"))}><ArrowsOutCardinal /> Resize</button>
                <button role="menuitem" onClick={() => runMenuAction(() => actions.minimize(application.id))}><Minus /> Minimise</button>
                <button role="menuitem" disabled={arrangeDisabled || windowState.maximized} onClick={() => runMenuAction(() => actions.snap(application.id, "maximize"))}><ArrowsOutSimple /> Maximise</button>
                <button role="menuitem" disabled={arrangeDisabled || windowState.snap === "left"} onClick={() => runMenuAction(() => actions.snap(application.id, "left"))}><SquareHalf /> Snap left · Left half</button>
                <button role="menuitem" disabled={arrangeDisabled || windowState.snap === "right"} onClick={() => runMenuAction(() => actions.snap(application.id, "right"))}><CopySimple /> Snap right · Right half</button>
                <button role="menuitem" onClick={() => runMenuAction(() => actions.close(application.id))}><X /> Close</button>
              </div>
            )}
          </div>
          <button aria-label={`${windowState.maximized || windowState.snap ? "Restore" : "Maximize"} ${application.title}`} data-action="maximize" disabled={arrangeDisabled} onClick={() => actions.maximize(application.id)}><ArrowsOutSimple /></button>
          <button aria-label={`Close ${application.title}`} className="close-control" data-action="close" onClick={() => actions.close(application.id)}><X /></button>
        </div>
      </header>
      <div className="window-content">{children}</div>
      {viewportMode === "desktop" && resizeEdges.map((edge) => (
        <button key={edge} className={`window-resize-handle resize-${edge}`} aria-label={`Resize ${application.title} from ${edge}`} data-testid={edge === "se" ? `resize-${application.id}` : `resize-${application.id}-${edge}`} onPointerDown={(event) => beginResize(event, edge)} />
      ))}
    </section>
  );
}
