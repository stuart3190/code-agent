// Project badges and dashboard grouping.
//
// These replaced a single coloured dot. A dot can only carry one meaning, and a project is
// regularly two things at once: live AND building, or live AND a newer build waiting to go out.
// Collapsing that to one colour is what made the dashboard unreadable at a glance.

import assert from "node:assert/strict";
import test from "node:test";

import { badgesFor, groupProjects, GROUPS, STATUS } from "../../shell/web/src/publish/publishLifecycle.js";

const labels = (c) => badgesFor(c).map((b) => b.label);
const project = (over = {}) => ({ id: "c1", state: "idle", publishStatus: STATUS.draft, ...over });

test("a draft says DRAFT rather than showing nothing", () => {
  // An absent badge reads as "unknown", not "not published yet".
  assert.deepEqual(labels(project()), ["DRAFT"]);
});

test("a live project says LIVE", () => {
  assert.deepEqual(labels(project({ publishStatus: STATUS.published })), ["LIVE"]);
});

test("a project serving an older build says BOTH LIVE and UPDATE AVAILABLE", () => {
  // The whole point: the site IS up, and a newer deployment is waiting. Showing only the amber
  // badge would imply it was down; showing only LIVE would hide the pending work.
  assert.deepEqual(labels(project({ publishStatus: STATUS.updateAvailable })), ["LIVE", "UPDATE AVAILABLE"]);
});

test("an unpublished project does not claim to be live", () => {
  assert.deepEqual(labels(project({ publishStatus: STATUS.unpublished })), ["UNPUBLISHED"]);
});

test("a live project that is building says both", () => {
  const badges = labels(project({
    publishStatus: STATUS.published,
    activity: { agent: "Builder", status: "Writing code…" },
  }));
  assert.deepEqual(badges, ["LIVE", "BUILDING"]);
});

test("BUILDING outranks the other activity states", () => {
  // While work is actually happening, that is the useful fact — not that a previous attempt failed.
  const badges = labels(project({
    activity: { agent: "Builder", status: "Working…" }, failed: true, state: "waiting_user",
  }));
  assert.deepEqual(badges, ["DRAFT", "BUILDING"]);
});

test("FAILED appears only when nothing usable came out of the build", () => {
  assert.ok(labels(project({ failed: true })).includes("FAILED"));
  // A failed attempt on a project that still verified, or still has a preview, is not a failure
  // worth alarming anyone about on the dashboard.
  assert.ok(!labels(project({ failed: true, verified: true })).includes("FAILED"));
  assert.ok(!labels(project({ failed: true, hasPreview: true })).includes("FAILED"));
});

test("a project waiting on the user says so", () => {
  assert.deepEqual(labels(project({ state: "waiting_user" })), ["DRAFT", "NEEDS INPUT"]);
});

// ── Grouping ────────────────────────────────────────────────────────────────────────────

test("projects are grouped Live apps, In progress, Drafts", () => {
  const groups = groupProjects([
    project({ id: "a", publishStatus: STATUS.published }),
    project({ id: "b", activity: { agent: "Builder", status: "…" } }),
    project({ id: "c" }),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ["Live apps", "In progress", "Drafts"]);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [["a"], ["b"], ["c"]]);
});

test("a project appears exactly once, under what it IS rather than what it is doing", () => {
  // Live and building at the same time belongs under Live apps: someone scanning for their live
  // apps must find it there, and duplicating it in two sections would overstate how much they have.
  const live = project({ id: "a", publishStatus: STATUS.published, activity: { agent: "Builder", status: "…" } });
  const groups = groupProjects([live]);
  assert.deepEqual(groups.map((g) => g.label), ["Live apps"]);
  assert.equal(groups[0].items.length, 1);

  const everywhere = groupProjects([live, project({ id: "b" })]);
  const ids = everywhere.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, [...new Set(ids)], "no project may be listed twice");
});

test("empty groups are omitted, and an unpublished project sits with the drafts", () => {
  const groups = groupProjects([project({ id: "a", publishStatus: STATUS.unpublished })]);
  assert.deepEqual(groups.map((g) => g.label), ["Drafts"],
    "a project with nothing live has nothing to show under Live apps");
});

test("every project lands in some group", () => {
  const all = [
    project({ id: "a", publishStatus: STATUS.published }),
    project({ id: "b", publishStatus: STATUS.updateAvailable }),
    project({ id: "c", publishStatus: STATUS.unpublished }),
    project({ id: "d", activity: { agent: "x", status: "y" } }),
    project({ id: "e", state: "waiting_user" }),
    project({ id: "f" }),
  ];
  const placed = groupProjects(all).flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(placed.sort(), ["a", "b", "c", "d", "e", "f"]);
  // The last group matches everything, so nothing can fall through the bottom.
  assert.equal(GROUPS[GROUPS.length - 1].matches(project()), true);
});
