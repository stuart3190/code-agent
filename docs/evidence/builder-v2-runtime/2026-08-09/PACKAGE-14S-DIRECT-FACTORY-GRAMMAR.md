# Package 14S direct factory-result capability grammar

Date: 2026-08-09
Scope: deterministic capability grammar repair only
Provider calls: zero
Production mutation: none

## Confirmed defect

The validator attributed destructuring only when the initializer was an identifier already mapped
to a recognised capability factory. Valid generated JavaScript that destructured directly from a
factory result therefore lost provenance:

```js
export const { submitContact } =
  makeContactForm({ entity: "contactMessage" });
```

The live candidate separately bound wizard `getState` and `subscribe` without invoking them. Those
are genuine contract failures and were not suppressed.

## Repair

Commit `9c794c7` introduces a common AST capability-source resolver. It resolves either:

- a unique module identifier already proven to originate from a recognised factory; or
- a direct recognised factory `CallExpression` (including the existing transparent `useMemo`
  wrapper grammar).

Named and direct sources now feed the same destructuring/member-call provenance path. Parsing is
two-pass so module-level use before declaration is deterministic. Direct instances retain factory,
source kind and AST span. Requiredness remains contract metadata; every recognised used factory
receives aggregate instance, binding, invocation and module facts.

Validation still fails closed for unknown factories, unrelated objects/functions/imports,
ambiguous declarations, invalid required configuration, missing methods and bound-but-uninvoked
methods. Rejections have machine-readable issue codes.

## Registry-driven matrix

The factory inventory is derived from the real capability registry and is pinned against its
interfaces:

- `makeBookingSystem`
- `makeContactForm`
- `makeEntityStore`
- `makeNewsletter`
- `makeWizardMachine`
- `makeWizardPersistence`

Each factory passed ten positive syntax combinations: named member call, direct factory-result
member call, named destructuring, named exported destructuring, named alias, direct destructuring,
direct exported destructuring, direct alias, cross-module named export/import and cross-module
direct export/import. That is 60 positive registry cross-product cases, in addition to negative,
configuration, mixed-factory, totality and use-before-declaration cases.

## Retained-source replay

The deterministic retained shape includes the exact direct contact binding plus booking, wizard and
entity-store adapters. It passed:

1. Babel AST parse;
2. structured patch validation;
3. enforced six-module booking plan;
4. platform capability usage lint;
5. real Vite compilation.

Capability contract result: intentionally red only for
`required_method_uninvoked:wizard:getState` and
`required_method_uninvoked:wizard:subscribe`. Contact is no longer reported absent.

A corrected fixture that genuinely invokes both wizard methods passes the complete capability
contract and compiles.

## Zero-model results

- focused capability grammar, compatibility and retained replay: 25/25 passed;
- registry cross-product: 60/60 positive syntax combinations passed;
- relevant Builder V2/provider/verification suite: 307/307 passed;
- retained candidate compile: passed;
- corrected candidate compile: passed;
- `git diff --check`: passed before commit.

No modularity threshold, booking plan, router, billing, worker, publishing or infrastructure code
changed. No live model call was made.

## Verdict

The deterministic capability-grammar blocker is closed. A separately approved single booking proof
is technically justified. Builder V2 generation quality is not yet qualified, and Package 15
remains blocked until that live proof reaches strict contracted green.
