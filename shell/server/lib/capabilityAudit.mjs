const PROVIDER_ENDPOINTS = [
  /api\.openai\.com/i,
  /api\.replicate\.com/i,
  /generativelanguage\.googleapis\.com/i,
  /api\.anthropic\.com/i,
  /graph\.facebook\.com/i,
];

const EXPOSED_CREDENTIALS = [
  /\bsk-(?:proj-)?[a-zA-Z0-9_-]{12,}/,
  /\br8_[a-zA-Z0-9_-]{12,}/,
  /\bAIza[a-zA-Z0-9_-]{20,}/,
  /VITE_(?:OPENAI|REPLICATE|ANTHROPIC|GOOGLE|RUNTIME_HTTP)_(?:API_KEY|TOKEN)/i,
];

function sourceEntries(tree) {
  return Object.entries(tree || {}).filter(([name, value]) =>
    typeof value === "string"
    && !name.includes("node_modules/")
    && !name.endsWith("package-lock.json")
    && !name.startsWith("src/lib/backend/"));
}

export function auditCapabilityTree(tree, manifest = []) {
  const hardIssues = [];
  const warnings = [];
  const entries = sourceEntries(tree);
  for (const [name, source] of entries) {
    if (PROVIDER_ENDPOINTS.some((pattern) => pattern.test(source))) {
      hardIssues.push(`${name} calls an external provider directly. Route it through the protected backend SDK so credentials and billing stay server-side.`);
    }
    if (EXPOSED_CREDENTIALS.some((pattern) => pattern.test(source))) {
      hardIssues.push(`${name} appears to expose a provider credential or a client-visible secret variable.`);
    }
  }
  const combined = entries.map(([, source]) => source).join("\n");
  const configured = Array.isArray(manifest) ? manifest : [];
  for (const action of configured) {
    const key = String(action?.key || "");
    if (key && !combined.includes(key)) warnings.push(`Configured action '${key}' is not currently used by the generated interface.`);
  }
  if (configured.length && !/actions\.(?:invoke|wait|subscribe)\s*\(/.test(combined)) {
    warnings.push("This app has configured server actions but its current interface does not invoke one yet.");
  }
  return { ok: hardIssues.length === 0, hardIssues: [...new Set(hardIssues)], warnings: [...new Set(warnings)] };
}
