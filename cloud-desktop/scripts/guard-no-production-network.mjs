import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoots = ["src", "public", "index.html"];
const files = [];

function collect(target) {
  const absolute = path.join(packageRoot, target);
  const info = statSync(absolute);
  if (info.isDirectory()) {
    for (const child of readdirSync(absolute)) collect(path.join(target, child));
  } else {
    files.push(absolute);
  }
}

for (const root of runtimeRoots) collect(root);

const forbidden = [
  { label: "fetch", expression: /\bfetch\s*\(/ },
  { label: "XMLHttpRequest", expression: /\bXMLHttpRequest\b/ },
  { label: "WebSocket", expression: /\bWebSocket\s*\(/ },
  { label: "EventSource", expression: /\bEventSource\s*\(/ },
  { label: "sendBeacon", expression: /\bsendBeacon\s*\(/ },
  { label: "absolute network URL", expression: /https?:\/\//i },
  { label: "production API path", expression: /["'`]\/api\//i },
];
const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const rule of forbidden) {
    if (rule.expression.test(source)) violations.push(`${path.relative(packageRoot, file)}: ${rule.label}`);
  }
}

if (violations.length) {
  console.error("C0 no-production-network guard failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`C0 no-production-network guard passed (${files.length} runtime files checked).`);
