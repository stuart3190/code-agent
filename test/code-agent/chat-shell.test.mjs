// Phase 21: the conversation shell's event reducer, replayed against the REAL event
// stream the Phase 19 live proof produced in production (FocusFlow). The thread, roster,
// and rail state are pure derivations of ca_conversation_events — this is the contract
// between the Lead Agent's vocabulary and the UI.

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvent, replayEvents, railState, emptyConversationView, beginChips, agentInitials,
} from "../../shell/web/src/chat/conversationState.js";
import { renderMarkdown } from "../../shell/web/src/chat/markdown.js";

const ev = (sequence, type, payload) => ({ sequence, type, payload });

// Abbreviated but faithful transcript of conversation 7ce3fe5f (Phase 19 live proof).
const FOCUSFLOW = [
  ev(1, "message", { role: "user", text: "Build me a small pomodoro timer web app called FocusFlow" }),
  ev(2, "agent_spawned", { agent: "Lead Agent", status: "Understanding request…" }),
  ev(3, "agent_spawned", { agent: "Planner", status: "Planning architecture…" }),
  ev(4, "plan.created", { title: "Build FocusFlow", steps: ["Create a clean, minimal Pomodoro timer experience.", "Verify the app and provide a live preview."] }),
  ev(5, "agent_done", { ok: true, agent: "Planner" }),
  ev(6, "agent_spawned", { agent: "Builder", status: "Assembling the build team…" }),
  ev(7, "build_started", { jobId: "job-1", projectId: "proj-1", message: "The team is assembling to build this." }),
  ev(8, "agent_done", { ok: true, agent: "Builder" }),
  ev(9, "agent_spawned", { agent: "Designer", status: "Creating the design system…" }),
  ev(10, "agent_done", { agent: "Lead Agent" }),
  ev(11, "message", { role: "lead", text: "I'm building FocusFlow now. I'll share the live preview as soon as it's ready." }),
  ev(12, "agent_done", { ok: true, agent: "Designer" }),
  ev(13, "agent_spawned", { agent: "Builder", status: "Writing the code…" }),
  ev(14, "agent_done", { ok: true, agent: "Builder" }),
  ev(15, "agent_spawned", { agent: "Publisher", status: "Preparing your preview…" }),
  ev(16, "agent_done", { ok: true, agent: "Publisher" }),
  ev(17, "preview_ready", { url: "https://pa12f1def.preview.thrallo.com/", projectId: "proj-1", message: "Preview ready — take a look." }),
];

test("the FocusFlow production stream replays into the wireframe choreography", () => {
  const view = replayEvents(FOCUSFLOW);

  // Thread: user message, plan card, lead message, preview card — sparse, not a log.
  const kinds = view.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["message", "plan", "message", "preview"]);
  assert.equal(view.items[0].role, "user");
  assert.equal(view.items[2].role, "lead");

  // Roster: spawn order preserved, Builder reused (disposable specialists return to one seat).
  assert.deepEqual(view.roster.map((r) => r.agent), ["Lead Agent", "Planner", "Builder", "Designer", "Publisher"]);
  assert.ok(view.roster.every((r) => r.state === "done"));

  // Rail: the living surface reached its third state, and the preview is the hero.
  assert.equal(railState(view), "preview");
  assert.equal(view.previewUrl, "https://pa12f1def.preview.thrallo.com/");
  assert.equal(view.thinking, false);
  assert.equal(view.lastSeq, 17);
});

test("rail state walks empty → team → preview as events arrive", () => {
  let view = emptyConversationView();
  assert.equal(railState(view), "empty");
  view = applyEvent(view, FOCUSFLOW[1]);
  assert.equal(railState(view), "team");
  view = applyEvent(view, FOCUSFLOW[16]);
  assert.equal(railState(view), "preview");
});

test("a user message sets thinking until the Lead Agent responds or finishes", () => {
  let view = applyEvent(emptyConversationView(), ev(1, "message", { role: "user", text: "hi" }));
  assert.equal(view.thinking, true);
  view = applyEvent(view, ev(2, "message", { role: "lead", text: "Hello." }));
  assert.equal(view.thinking, false);

  let second = applyEvent(emptyConversationView(), ev(1, "message", { role: "user", text: "hi" }));
  second = applyEvent(second, ev(2, "agent_done", { agent: "Lead Agent" }));
  assert.equal(second.thinking, false);
});

test("a business question pauses the conversation on a card", () => {
  const view = replayEvents([
    ev(1, "message", { role: "user", text: "build a booking system" }),
    ev(2, "question_asked", { question: "Pay at booking or on arrival?", businessConsequence: "Changes deposits and refunds." }),
  ]);
  assert.equal(view.waiting, true);
  assert.equal(view.thinking, false);
  assert.equal(view.items.at(-1).kind, "question");
  const resumed = applyEvent(view, ev(3, "message", { role: "user", text: "at booking" }));
  assert.equal(resumed.waiting, false);
});

test("errors surface softly and unknown event types never crash the shell", () => {
  const view = replayEvents([
    ev(1, "lead_error", { error: "model unavailable" }),
    ev(2, "some_future_event", { anything: true }),
  ]);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].kind, "error");
  assert.equal(view.lastSeq, 2);
});

test("markdown renderer escapes HTML and renders the basics", () => {
  const html = renderMarkdown("**Done** — see [the app](https://x.example) `npm run dev`\n\n- one\n- two\n\n<script>alert(1)</script>");
  assert.ok(html.includes("<strong>Done</strong>"));
  assert.ok(html.includes('<a href="https://x.example"'));
  assert.ok(html.includes("<code>npm run dev</code>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("begin chips continue the most recent conversations", () => {
  const chips = beginChips([
    { id: "a", title: "FocusFlow" },
    { id: "b", title: null },
    { id: "c", title: "Ignored (only two chips)" },
  ]);
  assert.deepEqual(chips.map((c) => c.label), ["Continue FocusFlow", "Continue where we left off"]);
  assert.equal(agentInitials("Lead Agent"), "LA");
});
