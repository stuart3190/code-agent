// Shared interpretation for interaction modes that sit on top of a browser primitive.
//
// A focus-only step still names the primitive it must reach (textbox or selection), but it must
// not edit the value held by that control. Keep this decision shared between contract derivation
// and browser execution so the data-flow graph and verifier cannot disagree.
const KEYBOARD_FOCUS = /\b(?:keyboard\s+)?focus\b|\btab(?:\s+through|\s+to)?\b/i;
const VALUE_OR_ACTION_CHANGE = /\b(?:enter|type|fill|choose|select|pick|edit|change|toggle|activate|click|press|submit|save|create|add|remove|delete)\b/i;

export function isKeyboardFocusOnlyStep(step = {}) {
  const action = String(step?.action || "");
  return KEYBOARD_FOCUS.test(action) && !VALUE_OR_ACTION_CHANGE.test(action);
}

// A pure, explicitly requested route link is navigation, not a second button on the
// destination. Composite value/mutation steps must retain their existing execution.
export function isExplicitRouteLinkStep(step = {}) {
  const target = String(step.route || step.target || '');
  return /^\/(?!\/)/.test(target)
    && ![...(step.operates || []), ...(step.produces || [])].length
    && /^(?:use|click|follow|tap)\s+(?:the\s+)?[^\n]+\s+(?:navigation\s+)?link\.?$/i.test(String(step.action || '').trim())
    && !/\b(?:and|then|before|after|submit|save|delete|create|enter|fill)\b/i.test(String(step.action || ''));
}
