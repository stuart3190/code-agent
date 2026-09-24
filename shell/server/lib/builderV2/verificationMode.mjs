// How a Builder V2 build is verified, decided by the customer's "Use verifier" choice on the
// build form and carried on the queued job input (`input.useVerifier`), so the toggle changes the
// worker's actual execution path rather than hiding a stage in the UI.
//
//   smoke     (default) - the sandbox smoke test gates the preview: compiles, opens, renders,
//                         visible controls activate without a crash. Verdicts may be cached.
//   bypassed            - no browser runs. The preview is shown as soon as the app compiles,
//                         starts and answers HTTP. Nothing is cached as a verified verdict, no
//                         repair round is briefed, and the preview is labelled "Not verified".
//
// Compilation, sandbox isolation, provenance checks, runtime preflight and publishing safeguards
// are untouched by this choice.

import {
  BYPASSED_VERIFIER_POLICY, SMOKE_VERIFIER_POLICY, VERIFICATION_RESULT_CLASS,
} from "../appBuild/verifierPolicy.mjs";

export const VERIFICATION_MODE = Object.freeze({ SMOKE: "smoke", BYPASSED: "bypassed" });

export function resolveVerificationMode(input = {}) {
  const useVerifier = input?.useVerifier !== false;
  return Object.freeze({
    useVerifier,
    mode: useVerifier ? VERIFICATION_MODE.SMOKE : VERIFICATION_MODE.BYPASSED,
    verifierPolicy: useVerifier ? SMOKE_VERIFIER_POLICY : BYPASSED_VERIFIER_POLICY,
    verified: useVerifier,
  });
}

/** The most recent explicit form choice stored on a conversation turn; the default is on. */
export function latestUseVerifier(turns = []) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const stored = turns[index]?.payload?.use_verifier;
    if (typeof stored === "boolean") return stored;
  }
  return true;
}

/** A bypassed build must never write or read a verified verdict. */
export function nullVerificationCache() {
  return {
    async get() { return null; },
    async put() {},
    async invalidate() { return 0; },
    async prune() { return 0; },
  };
}

/**
 * The preview "started and is reachable" proof used when the verifier is bypassed: the preview
 * host answers an HTTP request with anything below 500. Retries until the deadline, then throws a
 * platform error (the candidate is retained; no model spend follows).
 */
export async function awaitPreviewReachable(url, {
  fetchImpl = globalThis.fetch, timeoutMs = 90_000, intervalMs = 1_000, requestTimeoutMs = 8_000,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let last = null;
  while (true) {
    attempts += 1;
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "follow",
        signal: AbortSignal.timeout(requestTimeoutMs), headers: { "user-agent": "thrallo-preview-reachability/1" } });
      last = `HTTP ${response.status}`;
      if (response.status < 500) return { ok: true, status: response.status, attempts, detail: last };
    } catch (error) {
      last = String(error?.cause?.code || error?.code || error?.message || error).slice(0, 200);
    }
    if (now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw Object.assign(new Error(`preview did not become reachable within ${timeoutMs}ms (${last})`), {
    code: "preview_unreachable", classification: "platform", retryable: true,
  });
}

/**
 * The journeys layer for a bypassed build. It starts the preview, proves it answers HTTP, and
 * returns every journey as passing WITHOUT a browser verdict, marked `verifiedBy: bypassed_v1` so
 * nothing downstream can mistake it for verification.
 */
export function createBypassJourneysFn({ startPreview, reachable = awaitPreviewReachable, timeoutMs = 90_000, log = () => {} }) {
  if (typeof startPreview !== "function") throw new Error("createBypassJourneysFn needs startPreview()");
  return async ({ journeys = [], tree }) => {
    const previewResult = await startPreview(tree);
    if (!previewResult?.url) throw Object.assign(new Error("bypassed verification: the preview returned no URL"), {
      code: "preview_unreachable", classification: "platform", retryable: true,
    });
    const probe = await reachable(previewResult.url, { timeoutMs });
    const detail = `verifier bypassed by the build form: the app compiled, the preview started and answered ${probe.detail}`;
    log(`[bv2] ${detail} after ${probe.attempts} probe(s); no browser verification ran`);
    return {
      pass: true,
      verified: false,
      bypassed: true,
      verifierPolicy: BYPASSED_VERIFIER_POLICY,
      journeys: journeys.map((journey) => ({
        id: journey.id, title: journey.title, priority: journey.priority,
        status: "pass", classification: VERIFICATION_RESULT_CLASS.PASS, detail,
        steps: [], failedSteps: 0, verifiedBy: BYPASSED_VERIFIER_POLICY,
      })),
      consoleErrors: [], failedRequests: [], fatalErrors: [],
      advisories: [{ code: "verifier_bypassed", detail }],
      verifierDefects: [], unavailable: false, error: null, mechanics: null, failureRefs: [],
      reachability: probe,
    };
  };
}
