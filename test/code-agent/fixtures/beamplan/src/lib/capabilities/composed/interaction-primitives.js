export function useSemanticField({ name, value, onChange }) { return { labelProps: {}, inputProps: { name, value, onChange: (e) => onChange(e.target.value) } }; }
export function useSemanticAction({ onActivate }) { return { buttonProps: { onClick: (e) => { e?.preventDefault?.(); onActivate(); } } }; }
