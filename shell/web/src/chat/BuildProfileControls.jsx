import React from "react";
import {
  APPLICATION_SUBTYPE_OPTIONS,
  BUILD_TYPE_OPTIONS,
  REQUIREMENT_SIGNAL_OPTIONS,
  buildProfileInterpretation,
} from "../../../shared/buildProfile.mjs";

export default function BuildProfileControls({
  profile,
  requestedBuildType,
  onBuildTypeChange,
  applicationSubtype,
  onApplicationSubtypeChange,
  onToggleRequirement,
}) {
  const applicationContext = requestedBuildType === "application"
    || profile?.resolvedBuildType === "application";
  const selected = new Set(profile?.requirementSignals || []);
  const interpretation = buildProfileInterpretation(profile);

  return (
    <div className="ct-build-profile">
      <div className="ct-build-profile-head">
        <span className="ct-build-profile-label">What are you building?</span>
        <div className="ct-build-type" role="group" aria-label="What are you building?">
          {BUILD_TYPE_OPTIONS.map((option) => (
            <button key={option.id} type="button" className={requestedBuildType === option.id ? "on" : ""}
              aria-pressed={requestedBuildType === option.id}
              onClick={() => onBuildTypeChange(option.id)}>{option.label}</button>
          ))}
        </div>
      </div>
      {applicationContext && (
        <div className="ct-application-context">
          <label className="ct-app-subtype">
            <span>Application type</span>
            <select aria-label="Application type" value={applicationSubtype}
              onChange={(event) => onApplicationSubtypeChange(event.target.value)}>
              {APPLICATION_SUBTYPE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="ct-requirement-chips" aria-label="Optional application requirements">
            {REQUIREMENT_SIGNAL_OPTIONS.map((option) => (
              <button key={option.id} type="button" className={selected.has(option.id) ? "on" : ""}
                aria-pressed={selected.has(option.id)}
                onClick={() => onToggleRequirement(option.id)}>{option.label}</button>
            ))}
          </div>
        </div>
      )}
      <div className="ct-build-interpretation" aria-label="Thrallo build interpretation">
        <span>Thrallo understands this as:</span>
        <strong>{interpretation.join(" · ")}</strong>
      </div>
    </div>
  );
}
