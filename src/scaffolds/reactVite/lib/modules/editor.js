// Editor state and history module v1 — platform infrastructure, do not edit or reimplement.
//
// The audit's finding (§7.2, "Recovery/history/undo state"): every generated editor reinvented
// selection, viewport and undo, and every one of them got undo wrong in one of two ways — it
// stored whole snapshots of the document and ran out of memory, or it stored "the inverse" as the
// screen imagined it and drifted from what the command actually did.
//
// This module takes the only honest position: a command DECLARES its own inverse, and the stack
// stores commands, not documents. Three consequences the generated code never had:
//
//   1. A command with no declared inverse is REFUSED at registration, not silently made
//      irreversible at the moment the visitor presses undo.
//   2. A transaction is one undo entry. Dragging twenty objects is one command to the visitor and
//      must be one press of undo, which is impossible when the stack is per-mutation.
//   3. Executing after an undo truncates the redo branch. Keeping it would let a visitor redo
//      their way into a document that never existed.
//
// Objects are addressed by declared ID. Undo restores identity, not just shape: the object that
// comes back is the same object, so a selection, a reference and a route parameter still point at
// something real. Headless: no canvas, no rendering, no layout.

export const EDITOR_MODULE_VERSION = "1.0.0";

export const EDITOR_ERROR = Object.freeze({
  UNKNOWN_COMMAND: "editor_command_unknown",
  NOT_REVERSIBLE: "editor_command_not_reversible",
  COMMAND_FAILED: "editor_command_failed",
  NOTHING_TO_UNDO: "editor_nothing_to_undo",
  NOTHING_TO_REDO: "editor_nothing_to_redo",
  TRANSACTION_OPEN: "editor_transaction_open",
});

export class EditorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);
const idOf = (object) => String(object?.id ?? "");

/**
 * Compile command definitions.
 *   commands: { [id]: { apply(document, payload) -> document, invert(document, payload, before) -> payload } }
 * `invert` returns the PAYLOAD that undoes the command, computed from the document as it was
 * before the command ran — so the inverse is derived from what actually happened, never guessed.
 */
export function compileCommands(commands = {}) {
  const compiled = {};
  for (const [id, definition] of Object.entries(commands || {})) {
    if (typeof definition?.apply !== "function") {
      throw new EditorError(EDITOR_ERROR.UNKNOWN_COMMAND, `command "${id}" declares no apply`);
    }
    if (typeof definition?.invert !== "function") {
      throw new EditorError(EDITOR_ERROR.NOT_REVERSIBLE, `command "${id}" declares no inverse; an irreversible command cannot enter the history`);
    }
    compiled[id] = freeze({ id, apply: definition.apply, invert: definition.invert, label: definition.label || id });
  }
  return freeze(compiled);
}

/** The standard object commands, so an application does not rewrite add/update/remove/move. */
export function objectCommands({ collection = "objects" } = {}) {
  const read = (document) => listOf(document?.[collection]);
  const write = (document, objects) => ({ ...document, [collection]: objects });
  return {
    add: {
      label: "add",
      apply: (document, { object }) => write(document, [...read(document), clone(object)]),
      invert: (document, { object }) => ({ id: idOf(object) }),
    },
    remove: {
      label: "remove",
      // The inverse of a removal carries the object AND its position, so undo restores order too.
      apply: (document, { id }) => write(document, read(document).filter((object) => idOf(object) !== String(id))),
      invert: (document, { id }) => {
        const index = read(document).findIndex((object) => idOf(object) === String(id));
        return { object: clone(read(document)[index]), index };
      },
    },
    update: {
      label: "update",
      apply: (document, { id, values }) => write(document, read(document)
        .map((object) => (idOf(object) === String(id) ? { ...object, ...clone(values) } : object))),
      invert: (document, { id, values }) => {
        const before = read(document).find((object) => idOf(object) === String(id)) || {};
        return { id, values: Object.fromEntries(Object.keys(values || {}).map((key) => [key, clone(before[key])])) };
      },
    },
    insert: {
      label: "insert",
      apply: (document, { object, index }) => {
        const objects = [...read(document)];
        objects.splice(Math.max(0, Math.min(objects.length, Number(index) || 0)), 0, clone(object));
        return write(document, objects);
      },
      invert: (document, { object }) => ({ id: idOf(object) }),
    },
  };
}

const INVERSE_OF = Object.freeze({ add: "remove", remove: "insert", insert: "remove", update: "update" });

/**
 * @param {object} options
 * @param {object} [options.document] the initial document ({ objects: [...] } by default)
 * @param {object} [options.commands] command definitions; the standard object commands by default
 * @param {number} [options.historyLimit] entries kept; the oldest are dropped, never the newest
 */
export function createEditor({ document: initialDocument = { objects: [] }, commands = null, historyLimit = 100 } = {}) {
  const registry = compileCommands(commands || objectCommands());
  const listeners = new Set();
  let document = clone(initialDocument);
  let undoStack = [];
  let redoStack = [];
  let transaction = null;
  let state = {
    selection: [], viewport: { x: 0, y: 0, zoom: 1 }, revision: 0,
    canUndo: false, canRedo: false, error: null, lastCommand: null,
  };
  let snapshot = null;

  const objects = () => listOf(document?.objects);
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const getState = () => {
    if (!snapshot) {
      snapshot = freeze({
        ...clone(state),
        document: freeze(clone(document)),
        objects: freeze(clone(objects())),
        selected: freeze(objects().filter((object) => state.selection.includes(idOf(object))).map(clone)),
        undoDepth: undoStack.length, redoDepth: redoStack.length,
        undoLabel: undoStack.at(-1)?.label || null, redoLabel: redoStack.at(-1)?.label || null,
      });
    }
    return snapshot;
  };
  const commit = (patch = {}) => {
    state = {
      ...state, ...patch, revision: state.revision + 1,
      canUndo: undoStack.length > 0, canRedo: redoStack.length > 0,
    };
    // A selection can only name objects that exist. Undoing the creation of a selected object
    // must not leave a route parameter or a property panel pointing at nothing.
    const live = new Set(objects().map(idOf));
    state.selection = state.selection.filter((id) => live.has(id));
    snapshot = null;
    emit();
    return getState();
  };

  /** Run one command against the document, returning the document and the entry that undoes it. */
  function runOne(commandId, payload) {
    const command = registry[commandId];
    if (!command) throw new EditorError(EDITOR_ERROR.UNKNOWN_COMMAND, `no command "${commandId}" is registered`, { known: Object.keys(registry) });
    const inversePayload = command.invert(document, payload, clone(document));
    const inverseId = registry[INVERSE_OF[commandId]] ? INVERSE_OF[commandId] : commandId;
    if (!registry[inverseId]) throw new EditorError(EDITOR_ERROR.NOT_REVERSIBLE, `command "${commandId}" has no registered inverse command`);
    const next = command.apply(document, payload);
    if (!next || typeof next !== "object") throw new EditorError(EDITOR_ERROR.COMMAND_FAILED, `command "${commandId}" returned no document`);
    return { document: next, undo: { commandId: inverseId, payload: inversePayload }, redo: { commandId, payload: clone(payload) }, label: command.label };
  }

  return {
    commands: registry,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    select(id) { return commit({ selection: id === null || id === undefined ? [] : [String(id)] }); },
    selectMany(ids = []) { return commit({ selection: [...new Set(listOf(ids).map(String))] }); },
    toggleSelect(id) {
      const key = String(id);
      return commit({ selection: state.selection.includes(key) ? state.selection.filter((row) => row !== key) : [...state.selection, key] });
    },
    clearSelection() { return commit({ selection: [] }); },
    setViewport(patch = {}) { return commit({ viewport: { ...state.viewport, ...patch } }); },

    /** Execute one command. Refused, not ignored, when the command is unknown or fails. */
    execute(commandId, payload = {}) {
      try {
        const step = runOne(commandId, payload);
        document = step.document;
        if (transaction) {
          transaction.undo.unshift(step.undo);
          transaction.redo.push(step.redo);
        } else {
          undoStack.push({ label: step.label, undo: [step.undo], redo: [step.redo] });
          if (undoStack.length > historyLimit) undoStack.shift();
          // A new command means the old redo branch describes a document that no longer exists.
          redoStack = [];
        }
        return { ok: true, state: commit({ error: null, lastCommand: commandId }) };
      } catch (error) {
        commit({ error: { code: error?.code || EDITOR_ERROR.COMMAND_FAILED, message: String(error?.message || error) } });
        return { ok: false, reason: error?.code || EDITOR_ERROR.COMMAND_FAILED, state: getState() };
      }
    },

    /**
     * Group several commands into ONE history entry. A failure inside the transaction rolls the
     * document back to where it started: a half-applied group is not a state anyone chose.
     */
    transaction(label, run) {
      if (transaction) return { ok: false, reason: EDITOR_ERROR.TRANSACTION_OPEN, state: getState() };
      const before = clone(document);
      transaction = { label: String(label || "change"), undo: [], redo: [] };
      let failure = null;
      try {
        run(this);
      } catch (error) {
        failure = error;
      }
      const entry = transaction;
      transaction = null;
      if (failure || state.error) {
        document = before;
        commit({ error: failure ? { code: failure?.code || EDITOR_ERROR.COMMAND_FAILED, message: String(failure?.message || failure) } : state.error });
        return { ok: false, reason: failure?.code || EDITOR_ERROR.COMMAND_FAILED, state: getState() };
      }
      if (entry.undo.length) {
        undoStack.push(entry);
        if (undoStack.length > historyLimit) undoStack.shift();
        redoStack = [];
      }
      return { ok: true, state: commit({ error: null, lastCommand: entry.label }) };
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return { ok: false, reason: EDITOR_ERROR.NOTHING_TO_UNDO, state: getState() };
      for (const step of entry.undo) document = registry[step.commandId].apply(document, step.payload);
      redoStack.push(entry);
      return { ok: true, label: entry.label, state: commit({ error: null }) };
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return { ok: false, reason: EDITOR_ERROR.NOTHING_TO_REDO, state: getState() };
      for (const step of entry.redo) document = registry[step.commandId].apply(document, step.payload);
      undoStack.push(entry);
      return { ok: true, label: entry.label, state: commit({ error: null }) };
    },

    /** The history, newest first, for an application that wants to show or label it. */
    history() {
      return freeze({
        undo: freeze(undoStack.map((entry) => entry.label).reverse()),
        redo: freeze(redoStack.map((entry) => entry.label).reverse()),
      });
    },

    /** Replace the document — opening a different one. History does not survive: it described another document. */
    load(next) {
      document = clone(next || { objects: [] });
      undoStack = [];
      redoStack = [];
      return commit({ selection: [], error: null, lastCommand: null });
    },
  };
}
