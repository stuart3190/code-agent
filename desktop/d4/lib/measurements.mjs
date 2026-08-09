export async function measure(operation, clock = () => performance.now()) {
  const started = clock();
  try {
    const value = await operation();
    return { outcome: "success", durationMs: round(clock() - started), value };
  } catch (error) {
    return { outcome: "failure", durationMs: round(clock() - started), error };
  }
}

export function summarizeSamples(samples, { percentileMinimum = 20 } = {}) {
  const values = samples.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return { count: 0, rawMs: [], minMs: null, medianMs: null, maxMs: null, p50Ms: null, p95Ms: null, percentilePrecision: "none" };
  const percentilesPermitted = values.length >= percentileMinimum;
  return {
    count: values.length,
    rawMs: values.map(round),
    minMs: round(values[0]),
    medianMs: round(percentile(values, 0.5)),
    maxMs: round(values.at(-1)),
    p50Ms: percentilesPermitted ? round(percentile(values, 0.5)) : null,
    p95Ms: percentilesPermitted ? round(percentile(values, 0.95)) : null,
    percentilePrecision: percentilesPermitted ? "reported" : "sample-too-small-raw-values-only",
  };
}

export function parseResourceSample(text) {
  const parsed = JSON.parse(String(text).trim());
  for (const key of ["memoryCurrentBytes", "memoryLimitBytes", "processCount", "load1"]) {
    if (parsed[key] !== null && !Number.isFinite(Number(parsed[key]))) throw new Error(`invalid resource sample: ${key}`);
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value === null ? null : Number(value)]));
}

function percentile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
