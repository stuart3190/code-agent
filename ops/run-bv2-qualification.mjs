import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(await readFile(path.join(root, "test/code-agent/fixtures/bv2-qualification-matrix.json"), "utf8"));
if (matrix.modelSpend !== false) throw new Error("deterministic qualification must never authorise model spend");
const files = [...new Set(matrix.classes.map((row) => path.join("test/code-agent", row.proof)))];
const child = spawn(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit", env: { ...process.env, THRALLO_BV2_QUALIFICATION: "1" } });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
