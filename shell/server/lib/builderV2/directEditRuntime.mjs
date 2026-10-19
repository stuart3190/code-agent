// Offline compile and smoke for a direct edit.
//
// Production direct edit uses the sandbox Vite compile and the Playwright smoke_v1 gate.
// The BeamPlan fixture shipped with this change is a partial app: it has the flow component
// and its extension modules, and it does not have package.json, index.html, vite.config.js
// or src/main.jsx, so that sandbox gate cannot run it. This module reconstructs the proof
// the harness needs: esbuild bundles the real component (JSX automatic, relative imports
// resolved from the tree), Babel's indexer rejects a file that does not parse, and jsdom
// with React 18 renders it and activates its controls. Value checks for the centimetre
// edit live in smokeBeamPlan; the generic smoke only requires a render and a click that
// does not throw.

import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { indexFile } from "./indexer.mjs";

const require = createRequire(import.meta.url);
const CODE = /\.(jsx?|tsx?|mjs|cjs)$/;

async function materialise(tree) {
  const dir = await mkdtemp(path.join(tmpdir(), "thrallo-direct-edit-"));
  await Promise.all(Object.entries(tree || {}).map(async ([file, content]) => {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(content), "utf8");
  }));
  return dir;
}

export async function compileDirectEditTree(tree, { entry } = {}) {
  const failures = [];
  for (const [file, content] of Object.entries(tree || {})) {
    if (!CODE.test(file)) continue;
    const indexed = indexFile(file, String(content));
    if (indexed.opaque) failures.push(`${file} does not parse`);
  }
  if (!entry || typeof tree?.[entry] !== "string") failures.push("compile entry is missing from the tree");
  if (failures.length) return { ok: false, error: failures.join("; ") };
  const dir = await materialise(tree);
  try {
    const esbuild = await import("esbuild");
    const built = await esbuild.build({
      absWorkingDir: dir,
      entryPoints: [entry],
      bundle: true,
      format: "cjs",
      platform: "browser",
      jsx: "automatic",
      write: false,
      external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"],
      logLevel: "silent",
    });
    return { ok: true, code: built.outputFiles[0].text, dir };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 2_000) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function assignGlobal(key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor && descriptor.writable === false && descriptor.configurable === false) return false;
  try {
    if (descriptor && descriptor.configurable === false) return false;
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    return true;
  } catch {
    return false;
  }
}

function installDom(dom) {
  const keys = ["window", "document", "HTMLElement", "HTMLInputElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  assignGlobal("window", dom.window);
  assignGlobal("document", dom.window.document);
  assignGlobal("HTMLElement", dom.window.HTMLElement);
  assignGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  assignGlobal("Node", dom.window.Node);
  assignGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return () => {
    for (const [key, descriptor] of previous) {
      if (!descriptor) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  };
}

async function renderDefault(code) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/", pretendToBeVisual: true,
  });
  const restore = installDom(dom);
  try {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const act = React.act;
    const module = { exports: {} };
    const wrapper = new Function("require", "module", "exports", code);
    wrapper(require, module, module.exports);
    const Component = module.exports.default || module.exports;
    if (typeof Component !== "function") throw new Error("bundled entry has no component export");
    const root = createRoot(dom.window.document.getElementById("root"));
    await act(async () => { root.render(React.createElement(Component)); });
    return { React, act, root, document: dom.window.document, window: dom.window, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

export async function smokeRenderedTree(tree, { entry } = {}) {
  const compiled = await compileDirectEditTree(tree, { entry });
  if (!compiled.ok) return { pass: false, error: compiled.error };
  let session;
  try {
    session = await renderDefault(compiled.code);
    const button = session.document.querySelector("button");
    if (button) await session.act(async () => { button.click(); });
    const fatal = session.window.__fatal || null;
    return { pass: !fatal, error: fatal, activated: Boolean(button) };
  } catch (error) {
    return { pass: false, error: String(error?.message || error).slice(0, 2_000) };
  } finally {
    session?.restore?.();
  }
}

function buttonByText(document, text) {
  return [...document.querySelectorAll("button")].find((button) => button.textContent.includes(text));
}

function setInput(window, act, document, name, value) {
  const element = document.querySelector(`input[name=${name}]`);
  if (!element) throw new Error(`missing input ${name}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** Pull the numbers a display actually rendered. Trailing zeros and unit words are not part of the value. */
export function numbersInText(text) {
  const found = [];
  for (const match of String(text || "").matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/** True when every expected value appears, within `tolerance`, regardless of formatting. */
export function textHasNumbersNear(text, expected, tolerance = 0.01) {
  const found = numbersInText(text);
  const slack = Math.abs(Number(tolerance) || 0);
  return expected.every((target) => found.some((value) => Math.abs(value - Number(target)) <= slack + 1e-9));
}

// 400×300 cm on a 2×3 grid. Feet use the fixture's 3.28084 factor, shown to 2dp as 4.37 and 4.92.
export const BEAMPLAN_EXPECTED_SPACING = Object.freeze({
  cm: [133.33, 150],
  metres: [1.33, 1.5],
  feet: [4.37, 4.92],
});

/** Compare rendered spacing numerically. "150.00 cm" and "150 cm" are the same value. */
export function beamPlanObservationProblems(observed = {}) {
  const problems = [];
  if (!textHasNumbersNear(observed.cm, BEAMPLAN_EXPECTED_SPACING.cm)) {
    problems.push(`cm spacing was ${observed.cm}`);
  }
  if (!textHasNumbersNear(observed.metres, BEAMPLAN_EXPECTED_SPACING.metres)) {
    problems.push(`metre spacing was ${observed.metres}`);
  }
  if (!textHasNumbersNear(observed.feet, BEAMPLAN_EXPECTED_SPACING.feet)) {
    problems.push(`feet spacing was ${observed.feet}`);
  }
  if (!/met(?:re|er)s?/i.test(String(observed.reset || ""))) {
    problems.push(`reset unit was ${observed.reset}`);
  }
  return problems;
}

/**
 * BeamPlan centimetre proof. 400×300 cm on a 2×3 grid spaces lights at 133.33 cm by 150 cm.
 * Switching to metres shows 1.33 m and 1.50 m; feet shows 4.37 ft and 4.92 ft.
 * Reset returns the selector to metres. Values are compared numerically, not as source text.
 */
export async function smokeBeamPlan(tree, { entry } = {}) {
  const compiled = await compileDirectEditTree(tree, { entry });
  if (!compiled.ok) return { pass: false, error: compiled.error };
  let session;
  try {
    session = await renderDefault(compiled.code);
    const { act, document, window } = session;
    const click = (text) => {
      const button = buttonByText(document, text);
      if (!button) throw new Error(`missing button ${text}`);
      act(() => { button.click(); });
    };
    click("Centimetres");
    setInput(window, act, document, "roomLength", "400");
    setInput(window, act, document, "roomWidth", "300");
    click("2 × 3");
    click("Calculate plan");
    const cm = document.querySelector(".bp-result")?.textContent || "";
    click("Metres (m)");
    const metres = document.querySelector(".bp-result")?.textContent || "";
    click("Feet");
    const feet = document.querySelector(".bp-result")?.textContent || "";
    click("Reset");
    const reset = document.querySelector(".bp-unit button[aria-pressed=true]")?.textContent || "";
    const observed = { cm, metres, feet, reset };
    const problems = beamPlanObservationProblems(observed);
    return { pass: problems.length === 0, error: problems.join("; "), observed };
  } catch (error) {
    return { pass: false, error: String(error?.message || error).slice(0, 2_000) };
  } finally {
    session?.restore?.();
  }
}

export const directEditRuntimeNote = "offline esbuild+jsdom reconstruction; production uses sandbox vite compile and Playwright smoke_v1";
