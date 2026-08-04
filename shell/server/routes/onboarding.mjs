// First-run state.
//
// Server-side so it does not reappear on a second device, which is the one thing a localStorage
// flag cannot promise — and the reason the requirement asks for it.
//
// The rule that matters: an owner with no stored state has NOT onboarded. An absent row must read
// as "show it", never as "already done", or every genuinely new account would miss the tour. The
// store returns `{}` for a missing row and `pending` is derived from the absence of `completedAt`,
// so there is no branch where the default falls the wrong way.

import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import { conversationStore } from "../lib/conversationStore.mjs";

export async function handleOnboardingGet(_req, res, owner) {
  return wrap(async () => {
    const state = await conversationStore().getOnboarding(owner.id);
    sendJson(res, 200, publicState(state));
  });
}

export async function handleOnboardingUpdate(_req, res, owner, body = {}) {
  return wrap(async () => {
    const action = String(body?.action || "");
    const store = conversationStore();
    const now = new Date().toISOString();

    if (action === "complete" || action === "skip") {
      // Skipping and finishing are both "do not show this again unaided", and both are recorded
      // for what they are — a skip is a signal about the tour, not a completion.
      const state = await store.setOnboarding(owner.id, {
        completedAt: now, skipped: action === "skip", step: Number(body?.step) || null,
      });
      return sendJson(res, 200, publicState(state));
    }
    if (action === "reopen") {
      // Reopening clears completion so the flow runs again, and remembers that it was asked for —
      // a reopened tour is not a new account, and nothing should treat it as one.
      const state = await store.setOnboarding(owner.id, {
        completedAt: null, skipped: false, step: 0, reopenedAt: now,
      });
      return sendJson(res, 200, publicState(state));
    }
    if (action === "step") {
      // Progress is stored so closing the tab mid-tour resumes where it was, rather than
      // restarting from the welcome step every time.
      const step = Number(body?.step);
      if (!Number.isFinite(step) || step < 0 || step > 20) {
        throw new CodeAgentInputError("That is not a step in this flow", 400, "invalid_step");
      }
      const state = await store.setOnboarding(owner.id, { step });
      return sendJson(res, 200, publicState(state));
    }
    throw new CodeAgentInputError("That action is not available.", 400, "unknown_action");
  });
}

function publicState(state = {}) {
  return {
    // Derived, never stored: one field cannot disagree with the other if only one exists.
    pending: !state.completedAt,
    completedAt: state.completedAt || null,
    skipped: !!state.skipped,
    step: Number(state.step) || 0,
    reopenedAt: state.reopenedAt || null,
  };
}

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CodeAgentInputError) throw error;
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "onboarding_failed");
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
