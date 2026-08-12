// React bindings for the headless capability runtime.
//
// Capabilities are plain stores: `subscribe(listener)` + `getState()`, plus their operations.
// That is exactly React's external-store contract, but every generated application had to
// rediscover the wiring by hand — and hand-rolled selection state breaking under repair
// pressure was the single most repeated generation failure in Builder V2's history.
//
// These hooks are domain-neutral. They hold no application vocabulary and render no JSX: they
// return STATE and PROP OBJECTS, so accessible names, selected state and change propagation are
// correct by construction while layout, styling and component structure stay entirely yours.
//
// This module is platform infrastructure. Import it; never edit or reimplement it.

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

const identity = (value) => value;

/**
 * Subscribe a component to any capability store.
 *
 *   const state = useCapabilityState(wizard);
 *   const step  = useCapabilityState(wizard, (s) => s.stepId);
 *
 * Re-renders when the store emits. `selector` narrows the slice you depend on.
 */
export function useCapabilityState(store, selector = identity) {
  const subscribe = useCallback((listener) => {
    if (typeof store?.subscribe !== "function") return () => {};
    return store.subscribe(listener);
  }, [store]);

  // Capability stores hand out a fresh cloned object on every getState(), which is correct for
  // them and fatal for useSyncExternalStore: React compares snapshots by identity, so an
  // always-new object is an infinite render loop ("Maximum update depth exceeded"). Caching the
  // snapshot until its VALUE actually changes is the whole reason this hook exists — it is a
  // sharp edge every generated application would otherwise have to rediscover.
  const cache = useRef({ key: undefined, value: undefined });
  const getSnapshot = useCallback(() => {
    if (typeof store?.getState !== "function") return undefined;
    const next = store.getState();
    let key;
    try { key = JSON.stringify(next); } catch { key = undefined; }
    // An unserialisable snapshot cannot be compared, so fall back to identity and let the
    // store's own emit discipline drive updates.
    if (key === undefined) return next;
    if (cache.current.key !== key) cache.current = { key, value: next };
    return cache.current.value;
  }, [store]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => selector(snapshot), [snapshot, selector]);
}

/**
 * Run one capability operation with pending/error state, ignoring stale results.
 *
 *   const { run, pending, error, result } = useCapabilityAction(booking.createBooking);
 *   <button onClick={() => run(values)} disabled={pending}>Confirm</button>
 */
export function useCapabilityAction(action) {
  const [state, setState] = useState({ pending: false, error: null, result: null });
  const generation = useRef(0);

  const run = useCallback(async (...args) => {
    const ticket = ++generation.current;
    setState((prior) => ({ ...prior, pending: true, error: null }));
    try {
      const result = await action(...args);
      if (generation.current === ticket) setState({ pending: false, error: null, result });
      return result;
    } catch (error) {
      if (generation.current === ticket) setState({ pending: false, error, result: null });
      throw error;
    }
  }, [action]);

  return { run, ...state };
}

const slug = (value) => String(value || "field").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
const spaced = (value) => String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
const titled = (value) => {
  const text = spaced(value);
  return text ? text[0].toUpperCase() + text.slice(1) : "";
};

/**
 * A stable, opaque MACHINE IDENTITY for a contracted control, emitted as a data attribute.
 *
 * Verification targets this, not your labels. Rename a button, translate the page, reorder the
 * DOM or ship an icon-only control and the identity is unchanged — while a verifier that had to
 * recognise "Guest name" from prose would have to be taught every application's vocabulary, and
 * once drove a party-size number input because a field was called guestName.
 *
 * FNV-1a over the control's name, matching verificationManifest.controlIdFor on the platform side,
 * so both compute the same id from the same name with nothing to keep in sync. Accessibility is
 * still required on its own merits: this attribute is for machines, a label is for people.
 */
const machineId = (name, prefix) => {
  const text = String(name || "").trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}_${hash.toString(16).padStart(8, "0")}`;
};

export const controlId = (name) => machineId(name, "ctl");
export const actionId = (name) => machineId(name, "act");

/**
 * Props for a labelled, driveable text-like input.
 *
 * Returns `{ labelProps, inputProps }` guaranteeing an accessible name (label/htmlFor), a
 * stable id, a name attribute, a value and a change handler — the properties a browser
 * verifier needs to find and drive the control. Spread them onto whatever markup you like.
 *
 *   const email = useSemanticField({ name: "email", value, onChange: setValue, type: "email" });
 *   <label {...email.labelProps}>Email</label>
 *   <input {...email.inputProps} className="…" />
 */
export function useSemanticField({
  name, label = null, value = "", onChange = null, type = "text", required = false,
  invalid = false, describedBy = null, id = null,
} = {}) {
  const fieldId = id || `field-${slug(name)}`;
  const accessibleName = label || titled(name);
  const handleChange = useCallback((event) => {
    if (!onChange) return;
    onChange(event?.target ? event.target.value : event);
  }, [onChange]);

  return {
    id: fieldId,
    accessibleName,
    labelProps: { htmlFor: fieldId, children: accessibleName },
    inputProps: {
      id: fieldId,
      name: String(name || ""),
      type,
      value: value ?? "",
      onChange: handleChange,
      required: required || undefined,
      "data-thrallo-control": controlId(name),
      "aria-label": accessibleName,
      "aria-required": required || undefined,
      "aria-invalid": invalid || undefined,
      "aria-describedby": describedBy || undefined,
    },
  };
}

/**
 * Props for one option in a selectable group, with observable selected state.
 *
 * Selection a browser cannot observe is the classic silent failure: the click "works" but
 * nothing on the page changes. `optionProps` therefore carries an accessible name AND an
 * observable selected state.
 *
 * It deliberately does NOT set role="radio". A live qualification proved why: overriding the
 * native button role made every generated date/slot/party control invisible to Thrallo's own
 * journey verifier, which locates actionable controls as button/link/tab. The control was
 * correct and undriveable at the same time. Spread these onto a <button> and it stays a button;
 * `aria-pressed` carries the selected state, which is the correct ARIA pattern for a toggle
 * button and is exactly what the interaction lint and the verifier both already read.
 *
 *   const slot = useSemanticSelection({ name: "slot", value: chosen, onSelect: setChosen });
 *   {slots.map((s) => <button key={s} {...slot.optionProps(s)} className="…">{s}</button>)}
 */
export function useSemanticSelection({ name, value = null, onSelect = null, label = null } = {}) {
  const groupName = String(name || "selection");
  const accessibleName = label || titled(groupName);

  const optionProps = useCallback((option, optionLabel = null) => {
    const optionValue = typeof option === "object" && option !== null ? option.value : option;
    const text = optionLabel
      || (typeof option === "object" && option !== null ? option.label : null)
      || String(optionValue);
    const selected = optionValue === value;
    return {
      type: "button",
      // No `role` override: the element keeps its native role so the verifier can find it.
      id: `${slug(groupName)}-${slug(optionValue)}`,
      name: groupName,
      value: String(optionValue ?? ""),
      // Every option of a group carries the GROUP's identity, so the group is addressable as one
      // thing however its options are labelled, ordered or re-rendered.
      "data-thrallo-control": controlId(groupName),
      "data-thrallo-option": slug(optionValue),
      "aria-pressed": selected,
      "aria-label": text,
      "data-selected": selected ? "true" : "false",
      onClick: () => onSelect?.(optionValue),
    };
  }, [groupName, value, onSelect]);

  return {
    // `group` keeps the set announced without changing what its children are.
    groupProps: { role: "group", "aria-label": accessibleName, "data-thrallo-control": controlId(groupName) },
    optionProps,
    selected: value,
    accessibleName,
  };
}

/**
 * Props for a contracted ACTION control — the button or link a journey step activates.
 *
 * Same machine identity as a field, for the same reason: verification should not have to read
 * "Confirm booking" and infer that it commits a booking. Style and label it however you like.
 */
export function useSemanticAction({ name, label = null, onActivate = null, disabled = false } = {}) {
  const accessibleName = label || titled(name);
  return {
    accessibleName,
    buttonProps: {
      type: "button",
      "data-thrallo-action": actionId(name),
      "aria-label": accessibleName,
      disabled: disabled || undefined,
      onClick: () => onActivate?.(),
    },
  };
}

/**
 * Props for a live region announcing a state transition (confirmation, error, empty state).
 * A verifier — and a screen reader — sees the change because it is announced, not merely drawn.
 */
export function useStatusRegion({ label = "Status", polite = true } = {}) {
  return {
    statusProps: {
      role: polite ? "status" : "alert",
      "aria-live": polite ? "polite" : "assertive",
      "aria-label": label,
    },
  };
}
