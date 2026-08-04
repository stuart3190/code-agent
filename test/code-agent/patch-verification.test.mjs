// PR3 — every patch is checked for having done the right thing, and an unchanged failure escalates.
//
// Both production repairs applied cleanly to the active worktree and both were aimed at the wrong
// line. The fingerprint was identical across all four builds, the system noticed, and it stopped
// at attempt 2 of 3. Detection was right; the reaction was not.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyPatch, failureTarget, escalate, strategy, STRATEGIES, FIRST_STRATEGY,
} from "../../shell/server/lib/appBuild/patchVerification.mjs";
import { buildRepairBrief } from "../../shell/server/lib/appBuild/repairContext.mjs";

const OUTPUT = `error during build:
src/App.jsx (7:129): "Instagram" is not exported by "../../.deps/node_modules/lucide-react/dist/esm/lucide-react.mjs", imported by "src/App.jsx".`;

const BEFORE = {
  "src/App.jsx": `import { Instagram, Clock, Users, Phone } from "lucide-react";\nexport default () => <Instagram />;\n`,
  "src/Booking.jsx": `export function cancel() { return true; }\n`,
};

test("the failure's file, line and symbol are extracted from the compiler output", () => {
  const target = failureTarget(OUTPUT);
  assert.equal(target.file, "src/App.jsx");
  assert.equal(target.line, 7);
  assert.equal(target.symbol, "Instagram");

  assert.equal(failureTarget("Cannot find name 'formatDate'.").symbol, "formatDate");
  assert.equal(failureTarget("nothing useful here").file, null);
});

test("PRODUCTION REPAIR 1 — deleting unused imports is judged irrelevant, and costs no attempt", () => {
  // Verbatim from diagnostics baa3e8fc step 9: "Removed the unused Clock, Users, and Phone icon
  // imports from src/App.jsx, addressing the build quality/lint failure". Right file. Wrong symbol.
  const after = {
    ...BEFORE,
    "src/App.jsx": `import { Instagram } from "lucide-react";\nexport default () => <Instagram />;\n`,
  };
  const result = verifyPatch({
    before: BEFORE, after, output: OUTPUT, fingerprint: "ac60a9b4", previousFingerprint: "ac60a9b4",
  });

  assert.equal(result.verdict, "irrelevant");
  assert.equal(result.touchedTargetFile, true, "it did edit the right file");
  assert.equal(result.touchedFailingSymbol, false, "but never touched the symbol the error names");
  assert.equal(result.countsAsAttempt, false, "a patch that never engaged with the fault is not a paid attempt");
  assert.match(result.summary, /not what the error names/);
  assert.match(result.summary, /"Instagram"/);
});

test("PRODUCTION REPAIR 2 — editing an unrelated file is judged irrelevant", () => {
  // f00c7950 step 7 restored a window.confirm in a booking-cancellation handler.
  const after = {
    ...BEFORE,
    "src/Booking.jsx": `export function cancel() { return window.confirm("Cancel this booking?"); }\n`,
  };
  const result = verifyPatch({
    before: BEFORE, after, output: OUTPUT, fingerprint: "ac60a9b4", previousFingerprint: "ac60a9b4",
  });
  assert.equal(result.verdict, "irrelevant");
  assert.equal(result.touchedTargetFile, false);
  assert.equal(result.countsAsAttempt, false);
  assert.deepEqual(result.changedFiles, ["src/Booking.jsx"]);
});

test("a patch that changes nothing is a no-op, not an attempt", () => {
  const result = verifyPatch({ before: BEFORE, after: { ...BEFORE }, output: OUTPUT });
  assert.equal(result.verdict, "no_op");
  assert.equal(result.countsAsAttempt, false);
  assert.deepEqual(result.changedFiles, []);
  assert.match(result.summary, /did not attempt a fix/);

  // A whitespace nudge is equally not an attempt.
  const nudged = verifyPatch({
    before: BEFORE, after: { ...BEFORE, "src/App.jsx": `${BEFORE["src/App.jsx"]}\n` }, output: OUTPUT,
  });
  assert.equal(nudged.verdict, "no_op");
});

test("the correct fix is judged effective and does count", () => {
  const after = {
    ...BEFORE,
    "src/App.jsx": `import { Camera as Instagram, Clock, Users, Phone } from "lucide-react";\nexport default () => <Instagram />;\n`,
  };
  const result = verifyPatch({
    before: BEFORE, after, output: OUTPUT, fingerprint: "different", previousFingerprint: "ac60a9b4",
  });
  assert.equal(result.verdict, "effective");
  assert.equal(result.touchedTargetFile, true);
  assert.equal(result.touchedFailingSymbol, true);
  assert.equal(result.signatureMoved, true);
  assert.equal(result.countsAsAttempt, true);
});

test("a resolved build is effective even when no fingerprint is supplied", () => {
  const after = { ...BEFORE, "src/App.jsx": `import { Camera } from "lucide-react";\nexport default () => <Camera />;\n` };
  assert.equal(verifyPatch({ before: BEFORE, after, output: OUTPUT, resolved: true }).verdict, "effective");
});

test("relevant edits that do not move the signature are ineffective, and DO cost an attempt", () => {
  // Touched the right symbol in the right file, and it still fails identically. That is a genuine
  // attempt that genuinely failed — the only kind that should spend the budget.
  const after = {
    ...BEFORE,
    "src/App.jsx": `import { Instagram2 as Instagram } from "lucide-react";\nexport default () => <Instagram />;\n`,
  };
  const result = verifyPatch({
    before: BEFORE, after, output: OUTPUT, fingerprint: "ac60a9b4", previousFingerprint: "ac60a9b4",
  });
  assert.equal(result.verdict, "ineffective");
  assert.equal(result.countsAsAttempt, true);
  assert.match(result.summary, /did not change/);
});

test("absolute compiler paths still match project-relative tree paths", () => {
  const output = `/home/ubuntu/code-agent/harness/.work/shell-521c8922/src/App.jsx:7:129: "Instagram" is not exported`;
  const result = verifyPatch({
    before: BEFORE,
    after: { ...BEFORE, "src/App.jsx": `import { Camera as Instagram } from "lucide-react";\n<Instagram/>\n` },
    output, fingerprint: "a", previousFingerprint: "b",
  });
  assert.equal(result.touchedTargetFile, true, "a worktree path must resolve to the tree file it is");
});

test("the escalation ladder is four materially different approaches, in order", () => {
  assert.deepEqual(STRATEGIES.map((s) => s.id), [
    "targeted_fix", "dependency_inspection", "regenerate_module", "revert_and_rebuild",
  ]);
  assert.equal(FIRST_STRATEGY, "targeted_fix");
  assert.equal(escalate("targeted_fix"), "dependency_inspection");
  assert.equal(escalate("dependency_inspection"), "regenerate_module");
  assert.equal(escalate("regenerate_module"), "revert_and_rebuild");
  assert.equal(escalate("revert_and_rebuild"), null, "the top of the ladder is where a run may stop");

  // Each rung must actually instruct something different — otherwise it is a retry wearing a label.
  const instructions = STRATEGIES.map((s) => s.instruction);
  assert.equal(new Set(instructions).size, instructions.length);
  assert.match(strategy("dependency_inspection").instruction, /exports/);
  assert.match(strategy("regenerate_module").instruction, /from scratch/);
});

test("the brief tells the repair agent what the verifier concluded and which approach to take", () => {
  const brief = buildRepairBrief({
    output: OUTPUT,
    fingerprint: "ac60a9b4",
    previousFingerprint: "ac60a9b4",
    strategy: strategy("dependency_inspection"),
    // Production repair 1 exactly: the sibling imports deleted, everything about Instagram intact.
    patchVerdict: verifyPatch({
      before: BEFORE,
      after: {
        ...BEFORE,
        "src/App.jsx": `import { Instagram } from "lucide-react";\nexport default () => <Instagram />;\n`,
      },
      output: OUTPUT, fingerprint: "ac60a9b4", previousFingerprint: "ac60a9b4",
    }),
  });

  assert.match(brief, /THE LAST REPAIR DID NOT WORK/);
  assert.match(brief, /VERIFIED ABOUT YOUR LAST PATCH: .*not what the error names/);
  assert.match(brief, /APPROACH FOR THIS ATTEMPT — inspecting the dependency's real exports/);
  assert.match(brief, /"Instagram" is not exported by/, "and it still carries the error itself");
});

test("no strategy or verdict leaves the brief unchanged from PR1's shape", () => {
  const brief = buildRepairBrief({ output: OUTPUT });
  assert.ok(!/APPROACH FOR THIS ATTEMPT/.test(brief));
  assert.ok(!/VERIFIED ABOUT YOUR LAST PATCH/.test(brief));
  assert.match(brief, /"Instagram" is not exported by/);
});

test("colourised compiler output still resolves to the right file", () => {
  // Vite colourises stderr. Left unstripped, the path arrives as "<ESC>[31msrc/App.jsx" and every
  // comparison against a tree path fails, so a correct patch is judged to have touched the wrong
  // file. Found by ops/prove-pipeline-reliability.mjs against real compiler output.
  const ESC = String.fromCharCode(27);
  const coloured = `${ESC}[31msrc/App.jsx${ESC}[39m (2:9): "Instagram" is not exported by "lucide-react".`;

  const target = failureTarget(coloured);
  assert.equal(target.file, "src/App.jsx", "no escape sequence may survive into the parsed path");
  assert.equal(target.symbol, "Instagram");

  const result = verifyPatch({
    before: BEFORE,
    after: { ...BEFORE, "src/App.jsx": `import { Camera as Instagram, Clock, Users, Phone } from "lucide-react";\nexport default () => <Instagram />;\n` },
    output: coloured, fingerprint: "a", previousFingerprint: "b",
  });
  assert.equal(result.touchedTargetFile, true);
  assert.equal(result.touchedFailingSymbol, true);
});
