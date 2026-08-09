import { ArrowClockwise, CloudArrowUp, CloudSlash, PauseCircle, WarningCircle } from "@phosphor-icons/react";

const lifecycleCopy = {
  saving: { title: "Saving workspace", detail: "Fixture changes are being preserved.", icon: CloudArrowUp, tone: "progress" },
  waking: { title: "Waking workspace", detail: "Your fixture workspace is preparing to reconnect.", icon: ArrowClockwise, tone: "progress" },
  reconnecting: { title: "Reconnecting", detail: "Your layout remains available while the fixture connection recovers.", icon: ArrowClockwise, tone: "progress" },
  degraded: { title: "Workspace degraded", detail: "Some fixture services are unavailable.", icon: WarningCircle, tone: "warning" },
  suspended: { title: "Workspace suspended", detail: "Resume is simulated locally in C2.", icon: PauseCircle, tone: "warning" },
  recovery_required: { title: "Recovery required", detail: "Review the fixture state before continuing.", icon: CloudSlash, tone: "warning" },
};

export function WorkspaceLifecycleOverlay({ lifecycle, actions }) {
  const content = lifecycleCopy[lifecycle];
  if (!content) return null;
  const Icon = content.icon;
  const canResolve = ["waking", "reconnecting", "suspended", "recovery_required"].includes(lifecycle);
  return (
    <aside className={`lifecycle-overlay tone-${content.tone}`} data-lifecycle-overlay={lifecycle} role="status" aria-live="polite">
      <Icon size={20} weight="duotone" />
      <span><strong>{content.title}</strong><small>{content.detail}</small></span>
      {canResolve && <button onClick={() => actions.setLifecycle("ready", "recovered", "Workspace fixture recovered")}>{lifecycle === "suspended" ? "Resume fixture" : "Recover fixture"}</button>}
    </aside>
  );
}
