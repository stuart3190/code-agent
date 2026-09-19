# WP9 — Workflow, booking, workspace and editor primitives (2026-09-18)

Replaces the generic lifecycle code the retained corpus rebuilt in every application: a step index
a screen incremented, a project save that created a second record, and an undo stack of whole
documents.

## Architectural change

- **Workflow** `src/lib/modules/workflow.js`: a multi-step flow is a compiled STATE GRAPH. A transition out of an invalid step is refused with the failing fields, not silently ignored — refusing is a state the screen can render, which is what the generated version never had. A terminal state is terminal: after confirm or cancel there is no transition, no second confirmation and no value change, which forecloses the double-submitted booking. Persistence mode is explicit (`none`, `session`, `durable`); a flow reports whether it has read its own storage yet, so a resumed flow is never rendered as a fresh one. Confirmation validates every step, not just the one on screen, and lands on the first that fails.
- **Workspace** `src/lib/modules/workspace.js`: an open workspace has a durable identity and every later save updates that id. The only path that creates a record is one explicitly opened as new. Saving is a compare-and-set on the record version, so a concurrent save is a conflict the application resolves rather than a silent overwrite, and the unsaved draft survives the conflict because it is the one thing recoverable from nowhere else. `dirty` is derived from the draft against the saved record, so setting a field back to its saved value stops being a change.
- **Editor** `src/lib/modules/editor.js`: the history stores COMMANDS, not documents, and each command declares its own inverse — computed from the document as it was before the command ran. A command with no inverse is refused at registration rather than becoming irreversible when the visitor presses undo. A transaction is one history entry, so dragging twenty objects is one undo; a failure inside it rolls the document back whole. Executing after an undo truncates the redo branch. A selection can only name objects that exist, so undoing the creation of a selected object deselects it.
- **Booking 1.1.0**: the proven capacity-admission algorithm, now declaring the versioned entities repository it sits on. Its manifest states `concurrency: "versioned"` on cancellation, so what the module claims and what it does agree.
- **Workflow 1.1.0**: a new version of the wizard wrapper, not a second module — the same treatment entities 1.1.0 and forms 1.1.0 received. 1.0.0 stays registered for locks that pinned it.
- **Modules** `thrallo.workspace@1.0.0` and `thrallo.editor@1.0.0` are selected from contract STRUCTURE, like routing and query, never from a capability a contract declares. `selectedFamilies` is now exported from the scaffold graph and asked for once, so the modules a build locks and the families it composes cannot disagree.
- **Plan** `platformModules/behaviourPlan.mjs` derives all three shapes from the typed contract: workflow graphs from stepped journeys, workspace roots from durable entities that are opened and updated in place, an editor surface from the objects an editor manipulates.
- **Composition**: `composed/{workflow,workspace,editor}.js` plus `src/lib/app/{workflow,workspace,editor}.js`. The workspace facade returns the SAME controller per root entity, so two screens editing one project share its draft instead of racing. The workflow facade does the same per journey.

## What is claimed, and what is not

A journey becomes a workflow only when it has at least three steps and the contract's own step
vocabulary, or when an operation binds the wizard capability. Selecting the workflow family for one
wizard must not turn "open, edit, save" into a three-step wizard as well, which is what a plan
keyed on the family alone would have done.

A durable entity becomes a workspace root only when it is updated in place and also read or listed.
A record that is only created and listed is a catalogue; composing lifecycle machinery for
something nobody edits is the same class of invention as the settings singleton WP8 removed.

Durable workflow progress is REFUSED where the contract declares nowhere to keep it: the plan
records `persistenceRefused` and falls back to transient, rather than fabricating a `wizardState`
table. Writing a visitor's half-finished data to a durable store they never asked about is not a
default anyone should get by accident.

## Deferred within WP9

The module catalogue also assigns `thrallo.browser3d` to WP9. It is NOT implemented here: the
audit's required proof for it is real-render, picking and cleanup, which is browser evidence rather
than deterministic coverage, and this milestone is deterministic. The catalogue row stands; the
module remains unimplemented and unselected, so no build can claim it.

## Compatibility

- The scaffold's own `useWorkflowState`, `useProjectWorkspace` and `useCanvasState` primitives keep
  shipping unchanged for screens already written against them. The modules are the deterministic
  replacement, not a forced migration.
- The booking capability's public surface is unchanged; only its manifest and its declared
  dependency moved.
- Lock order changed for contracts using booking: entities now resolves before booking, because
  booking 1.1.0 declares it. Dependency order is what the lock order means.
- Coverage ledger: format `behaviourPlan: 1`; the WP9 catalogue rows for workflow, workspace,
  editor and booking were already in place from WP0 and now point at registered modules.

## Tests

`builder-v2-workflow-workspace-editor.test.mjs` (16): refused transitions with the failing fields
and per-field error clearing; bounded navigation with back always available and a forward jump
refused; terminal state with exactly one domain effect and every step validated at confirmation;
explicit persistence with save, resume, restored-versus-fresh, cleared-on-confirm and a reported
persistence failure that does not take the flow down; compile-time refusal of malformed graphs;
the same-ID guarantee across three saves and two sessions; derived dirty, discard, and a
concurrent save that conflicts with both sides preserved; inverse declaration refusal; undo, redo,
identity and order restoration, and redo-branch truncation; transactions as one undo with whole
rollback and selection integrity; booking concurrency admitting exactly capacity with a visible
cancellation transition; the plan derived from declared structure; negative controls where a plain
CRUD contract composes none of it; composition with no dangling durable import; and durable
workflow persistence writing one row and clearing it on cancel.
