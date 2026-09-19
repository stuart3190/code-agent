// Regression cover for THR-04DC8D.
//
// A conversation was permanently blocked with provider_replay_unsafe because the
// codex adapter threw ENOENT for a missing ~/.codex/auth.json. That error carried
// no dispatchState, so it fell to the fail-safe default of "ambiguous" and replay
// was refused — for a request that had failed on a local file read in 2ms and had
// never touched the network.
//
// The fail-safe default is right and must stay. What these tests pin down is the
// narrow set of failures that provably pre-date dispatch, and — just as important —
// everything that must NOT be treated that way.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPATCH_STATES,
  classifyProviderFailure,
  isPreDispatchFailure,
  providerFailure,
} from "../../shell/server/lib/providerOutcome.mjs";

const withCode = (code, extra = {}) =>
  Object.assign(new Error(`simulated ${code}`), { code, ...extra });

test("a missing local credential file is pre-dispatch and replayable", () => {
  const result = classifyProviderFailure(withCode("ENOENT"));
  assert.equal(result.state, DISPATCH_STATES.before);
  assert.equal(result.retrySafe, true);
});

test("failures that never established a connection are pre-dispatch", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EACCES"]) {
    const result = classifyProviderFailure(withCode(code));
    assert.equal(result.state, DISPATCH_STATES.before, `${code} should be pre-dispatch`);
    assert.equal(result.retrySafe, true, `${code} should be replayable`);
  }
});

test("mid-flight transport failures stay ambiguous — a request may have landed", () => {
  for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ABORT_ERR", "UND_ERR_SOCKET"]) {
    const result = classifyProviderFailure(withCode(code));
    assert.equal(result.state, DISPATCH_STATES.ambiguous, `${code} must not be inferred safe`);
    assert.equal(result.retrySafe, false);
  }
});

test("an unrecognised failure still defaults to ambiguous", () => {
  const result = classifyProviderFailure(new Error("something unexpected"));
  assert.equal(result.state, DISPATCH_STATES.ambiguous);
  assert.equal(result.retrySafe, false);
});

test("evidence of dispatch overrides the pre-dispatch inference", () => {
  const withUsage = classifyProviderFailure(withCode("ENOENT", { usage: { total_tokens: 12 } }));
  assert.equal(withUsage.state, DISPATCH_STATES.ambiguous);
  assert.equal(withUsage.retrySafe, false);

  const withIdentity = classifyProviderFailure(withCode("ENOENT", { providerRequestId: "resp_abc" }));
  assert.equal(withIdentity.state, DISPATCH_STATES.ambiguous);
  assert.equal(withIdentity.retrySafe, false);
});

test("an adapter's explicit verdict always beats inference", () => {
  const explicit = providerFailure(withCode("ENOENT"), { state: DISPATCH_STATES.ambiguous });
  const result = classifyProviderFailure(explicit);
  assert.equal(result.state, DISPATCH_STATES.ambiguous);
  assert.equal(result.retrySafe, false);
  assert.equal(result.inferredState, false);
});

test("a provider rejection stays rejected and honours its own retrySafe flag", () => {
  const rateLimited = providerFailure(
    Object.assign(new Error("429"), { status: 429 }),
    { state: DISPATCH_STATES.rejected, retrySafe: true },
  );
  const result = classifyProviderFailure(rateLimited);
  assert.equal(result.state, DISPATCH_STATES.rejected);
  assert.equal(result.retrySafe, true);

  const refused = providerFailure(
    Object.assign(new Error("400"), { status: 400 }),
    { state: DISPATCH_STATES.rejected, retrySafe: false },
  );
  assert.equal(classifyProviderFailure(refused).retrySafe, false);
});

test("isPreDispatchFailure reads a wrapped cause", () => {
  const wrapped = new Error("fetch failed");
  wrapped.cause = { code: "ECONNREFUSED" };
  assert.equal(isPreDispatchFailure(wrapped), true);
  assert.equal(isPreDispatchFailure(new Error("plain")), false);
});

test("the exact THR-04DC8D shape is now replayable rather than blocked", () => {
  // What the codex adapter actually threw: a bare fs error, no dispatch metadata.
  const actual = Object.assign(
    new Error("ENOENT: no such file or directory, open '/home/ubuntu/.codex/auth.json'"),
    { code: "ENOENT" },
  );
  const result = classifyProviderFailure(actual);
  assert.equal(result.state, DISPATCH_STATES.before);
  assert.equal(result.retrySafe, true);
  assert.equal(result.hasUsage, false);
  assert.equal(result.hasIdentity, false);
});

// ── Diagnosability ────────────────────────────────────────────────────────────
//
// THR-04DC8D was blocked by a wrapper error whose own message says only that
// replay was refused. The provider failure that caused it was attached but never
// persisted, so the incident recorded the symptom and not the cause — the fault
// had to be reproduced on the host to identify it.

import { underlyingEvidence } from "../../shell/server/lib/errorShield.mjs";
import { replayUnsafe } from "../../shell/server/lib/providerOutcome.mjs";

test("incident evidence preserves the underlying provider failure", () => {
  const enoent = Object.assign(
    new Error("ENOENT: no such file or directory, open '/home/ubuntu/.codex/auth.json'"),
    { code: "ENOENT" },
  );
  const evidence = underlyingEvidence(replayUnsafe(enoent, { reservationId: "res_1" }));
  assert.match(evidence, /code=ENOENT/);
  assert.match(evidence, /auth\.json/);
});

test("evidence records the dispatch verdict and provider request id", () => {
  const inner = providerFailure(
    Object.assign(new Error("502 upstream"), { status: 502, code: "openai_request_failed" }),
    { state: DISPATCH_STATES.ambiguous, providerRequestId: "resp_123" },
  );
  const evidence = underlyingEvidence(replayUnsafe(inner, {}));
  assert.match(evidence, /status=502/);
  assert.match(evidence, /dispatchState=provider_dispatch_ambiguous/);
  assert.match(evidence, /providerRequestId=resp_123/);
});

test("an error with no cause yields no evidence rather than throwing", () => {
  assert.equal(underlyingEvidence(new Error("plain")), null);
  assert.equal(underlyingEvidence(null), null);
});

test("evidence recursion is bounded", () => {
  let error = new Error("root");
  for (let i = 0; i < 12; i += 1) error = Object.assign(new Error(`layer ${i}`), { cause: error });
  const evidence = underlyingEvidence(error);
  assert.ok(evidence.split("\n").length <= 4, "must not walk an unbounded cause chain");
});
