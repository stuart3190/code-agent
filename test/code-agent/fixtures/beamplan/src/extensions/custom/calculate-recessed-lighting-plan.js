const FACTOR = 3.28084;

function empty(message) {
  return { lengthMetres: null, widthMetres: null, roomLengthDisplay: "", roomWidthDisplay: "", totalLights: 0, lengthSpacing: null, widthSpacing: null, lengthWallOffset: null, widthWallOffset: null, lengthSpacingDisplay: "", widthSpacingDisplay: "", lengthWallOffsetDisplay: "", widthWallOffsetDisplay: "", diagramMarkerCount: 0, planMessage: "Enter valid room dimensions to create a room plan.", validationMessage: message };
}

export function runCalculateRecessedLightingPlanCustomBehavior(inputs, { operation }) {
  if (operation !== "calculate-lighting-plan") return empty("Something went wrong. Please try again.");
  const { unit, roomLength, roomWidth, rows, columns } = inputs;
  const length = Number(roomLength);
  const width = Number(roomWidth);
  const toMetres = unit === "feet" ? 1 / FACTOR : 1;
  const lengthMetres = length * toMetres;
  const widthMetres = width * toMetres;
  if (!Number.isFinite(length) || length <= 0) return empty("Enter a room length greater than 0.");
  if (!Number.isFinite(width) || width <= 0) return empty("Enter a room width greater than 0.");
  if (lengthMetres < 0.5 || lengthMetres > 50) return empty("Room length must be between 0.5 and 50 metres.");
  if (widthMetres < 0.5 || widthMetres > 50) return empty("Room width must be between 0.5 and 50 metres.");
  if (!Number.isInteger(Number(rows)) || !Number.isInteger(Number(columns)) || Number(rows) < 1 || Number(columns) < 1) return empty("Choose both rows and columns for your grid.");
  const displayFactor = unit === "feet" ? FACTOR : 1;
  const suffix = unit === "feet" ? "ft" : "m";
  const format = (value) => `${(value * displayFactor).toFixed(2)} ${suffix}`;
  const lengthSpacing = lengthMetres / Number(columns);
  const widthSpacing = widthMetres / Number(rows);
  const totalLights = Number(rows) * Number(columns);
  return {
    lengthMetres, widthMetres, roomLengthDisplay: format(lengthMetres), roomWidthDisplay: format(widthMetres), totalLights,
    lengthSpacing, widthSpacing, lengthWallOffset: lengthSpacing / 2, widthWallOffset: widthSpacing / 2,
    lengthSpacingDisplay: format(lengthSpacing), widthSpacingDisplay: format(widthSpacing),
    lengthWallOffsetDisplay: format(lengthSpacing / 2), widthWallOffsetDisplay: format(widthSpacing / 2),
    diagramMarkerCount: totalLights, planMessage: `${totalLights} lights arranged in ${rows} rows by ${columns} columns`, validationMessage: ""
  };
}
