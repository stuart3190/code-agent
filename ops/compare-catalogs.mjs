#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [localPath, productionPath, outputPath] = process.argv.slice(2);
if (!localPath || !productionPath || !outputPath) {
  throw new Error("usage: node ops/compare-catalogs.mjs <local.json> <production.json> <output.json>");
}

const local = JSON.parse(await readFile(localPath, "utf8"));
const production = JSON.parse(await readFile(productionPath, "utf8"));
const sections = ["schemas", "tables", "columns", "constraints", "indexes", "functions", "triggers", "policies", "grants", "extensions"];

const keys = {
  schemas: (r) => r.schema,
  tables: (r) => `${r.schema}.${r.table}`,
  columns: (r) => `${r.schema}.${r.table}.${String(r.ordinal).padStart(5, "0")}.${r.column}`,
  constraints: (r) => `${r.schema}.${r.table}.${r.constraint}`,
  indexes: (r) => `${r.schema}.${r.table}.${r.index}`,
  functions: (r) => `${r.schema}.${r.function}(${r.identity_arguments})`,
  triggers: (r) => `${r.schema}.${r.table}.${r.trigger}`,
  policies: (r) => `${r.schema}.${r.table}.${r.policy}`,
  grants: (r) => `${r.object_type}.${r.schema}.${r.object}.${r.grantee}.${r.privilege}`,
  extensions: (r) => r.extension,
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function comparable(section, row) {
  const value = structuredClone(row);
  if (section === "functions") {
    value.definition = value.definition.replace(/\$function\$/g, "$$").replace(/\r\n/g, "\n").trim();
  }
  if (section === "grants") delete value.specific_name;
  return value;
}

function expectedLocalOnly(section, key) {
  return (section === "schemas" && new Set(["_realtime", "net", "supabase_functions"]).has(key))
    || (section === "extensions" && key === "pg_net");
}

const report = {
  generatedAt: new Date().toISOString(),
  local: path.basename(localPath),
  production: path.basename(productionPath),
  sections: {},
  totals: { expectedEnvironment: 0, productionOnly: 0, localOnly: 0, changed: 0 },
};

for (const section of sections) {
  const localRows = local[section] || [];
  const productionRows = production[section] || [];
  const localMap = new Map(localRows.map((row) => [keys[section](row), row]));
  const productionMap = new Map(productionRows.map((row) => [keys[section](row), row]));
  const expectedEnvironment = [];
  const productionOnly = [];
  const localOnly = [];
  const changed = [];

  for (const [key, row] of productionMap) {
    if (!localMap.has(key)) {
      productionOnly.push({ key, production: row });
      continue;
    }
    const localRow = localMap.get(key);
    if (digest(comparable(section, localRow)) !== digest(comparable(section, row))) {
      const extensionVersionOnly = section === "extensions"
        && digest({ ...localRow, version: null }) === digest({ ...row, version: null });
      const schemaOwnerOnly = section === "schemas"
        && digest({ ...localRow, owner: null }) === digest({ ...row, owner: null });
      if (extensionVersionOnly || schemaOwnerOnly) {
        expectedEnvironment.push({ key, reason: extensionVersionOnly ? "extension version" : "managed schema owner", local: localRow, production: row });
      } else {
        changed.push({ key, local: localRow, production: row });
      }
    }
  }
  for (const [key, row] of localMap) {
    if (productionMap.has(key)) continue;
    if (expectedLocalOnly(section, key)) {
      expectedEnvironment.push({ key, reason: "local Supabase platform service", local: row, production: null });
    } else {
      localOnly.push({ key, local: row });
    }
  }

  report.sections[section] = {
    localCount: localRows.length,
    productionCount: productionRows.length,
    localSha256: digest(localRows),
    productionSha256: digest(productionRows),
    expectedEnvironment,
    productionOnly,
    localOnly,
    changed,
  };
  report.totals.expectedEnvironment += expectedEnvironment.length;
  report.totals.productionOnly += productionOnly.length;
  report.totals.localOnly += localOnly.length;
  report.totals.changed += changed.length;
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.totals));
