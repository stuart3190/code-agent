import { CloudCheck, WarningCircle } from "@phosphor-icons/react";
import { listDevelopmentScenarios } from "../fixtures/scenarios.js";

export function DesktopHeader({ state, actions }) {
  const disconnected = ["offline", "unavailable"].includes(state.connection);
  return (
    <header className="desktop-header">
      <div className="desktop-workspace-heading">
        <strong>{state.workspaceName}</strong>
        <span>{disconnected ? <WarningCircle /> : <CloudCheck />} {disconnected ? "Working from saved fixture state" : "Cloud workspace · fixture mode"}</span>
      </div>
      <label className="scenario-control" title="Development-only fixture scenarios">
        <span>Scenario</span>
        <select aria-label="Fixture scenario" value={state.scenarioId} onChange={(event) => actions.loadScenario(event.target.value)}>
          {listDevelopmentScenarios().map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
        </select>
      </label>
    </header>
  );
}
