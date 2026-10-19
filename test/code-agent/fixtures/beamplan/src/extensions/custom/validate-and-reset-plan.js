import { runCalculateRecessedLightingPlanCustomBehavior } from "./calculate-recessed-lighting-plan.js";

export function runValidateAndResetPlanCustomBehavior(inputs, { operation }) {
  if (operation === "calculate-lighting-plan") {
    return runCalculateRecessedLightingPlanCustomBehavior({ roomLength: inputs.roomLength, roomWidth: inputs.roomWidth, unit: inputs.unit, rows: inputs.rows, columns: inputs.columns }, { operation: "calculate-lighting-plan" });
  }
  if (operation === "reset-lighting-plan") {
    return { roomLength: "", roomWidth: "", rows: "", columns: "", layoutPreset: "", lengthMetres: null, widthMetres: null, roomLengthDisplay: "", roomWidthDisplay: "", totalLights: 0, lengthSpacing: null, widthSpacing: null, lengthWallOffset: null, widthWallOffset: null, lengthSpacingDisplay: "", widthSpacingDisplay: "", lengthWallOffsetDisplay: "", widthWallOffsetDisplay: "", diagramMarkerCount: 0, planMessage: "Enter valid room dimensions to create a room plan.", validationMessage: "" };
  }
  return { validationMessage: "Something went wrong. Please try again." };
}
