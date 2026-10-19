import { runCalculateRecessedLightingPlanCustomBehavior } from "./calculate-recessed-lighting-plan.js";

export function runConvertUnitsWithoutChangingRoomCustomBehavior(inputs, { operation }) {
  if (operation === "calculate-lighting-plan") {
    return runCalculateRecessedLightingPlanCustomBehavior({ roomLength: inputs.roomLength, roomWidth: inputs.roomWidth, unit: inputs.unit, rows: inputs.rows, columns: inputs.columns }, { operation: "calculate-lighting-plan" });
  }
  if (operation !== "convert-measurement-unit" || !Number.isFinite(inputs.lengthMetres) || !Number.isFinite(inputs.widthMetres)) {
    return { validationMessage: "Calculate a valid plan before changing units." };
  }
  const factor = inputs.unit === "feet" ? 3.28084 : 1;
  return runCalculateRecessedLightingPlanCustomBehavior({ roomLength: inputs.lengthMetres * factor, roomWidth: inputs.widthMetres * factor, unit: inputs.unit, rows: inputs.rows, columns: inputs.columns }, { operation: "calculate-lighting-plan" });
}
