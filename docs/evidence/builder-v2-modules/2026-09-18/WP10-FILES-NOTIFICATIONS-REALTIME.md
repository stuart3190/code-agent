# WP10 — Files, notifications and realtime (2026-09-18)

Three modules over SDK surfaces that already work. What each adds is the policy and the lifecycle
the generated code around those surfaces kept getting wrong.

## Architectural change

- **Files** `src/lib/modules/files.js`: the upload policy is DECLARED — accepted kinds, a maximum size, how many files one subject may hold — and checked before a byte is sent. A refusal the visitor can act on ("the file is larger than the 1MB limit", with the accepted types) is worth more than a network failure halfway through a large upload. Metadata is recorded by the module against the subject record, so what the application believes it has and what the bucket holds cannot drift, and removing a subject removes both sides. Access is a short-lived signed URL minted on demand, returned with its own expiry so a caller cannot keep a dead link on screen.
- **Notifications** `src/lib/modules/notifications.js`: every send carries a deduplication key derived from the event and its subject, so a retried effect, a double-clicked button and a job that ran twice converge on ONE notification. Read state is the stored row; the unread badge is derived from the same rows the inbox renders, so the two cannot disagree, and an optimistic receipt rolls back when the write fails. Events are declared: one the contract never named cannot be sent. A stream the visitor must not be able to forge — a security alert — is typed `recipient: "server"` and emitted as an event rather than written from the client.
- **Realtime** `src/lib/modules/realtime.js`: a reconnect RESYNCS. The generated version resubscribed and carried on, so every change made while the socket was down was lost behind a list that looked authoritative; here the topic re-reads its own rows and delivers a `resync` event. Topics are declared and name the entity they watch, which is what makes resync meaningful. A subscription is a read, so it is authorised before a socket opens and a refusal is an explicit state rather than a stream that is silently empty. One channel per topic, reference counted, closed when the last subscriber leaves.
- **Plan** `platformModules/deliveryPlan.mjs` derives all three from the contract: file subjects from declared file-typed fields, notification events from journey steps that say someone is told something, realtime topics from the contract's own claim that changes appear without a reload.
- **Availability**: the source baseline now declares `notifications`, because the notification tables ship in this repository. It does NOT declare `storage`: the bucket is provisioned per deployment, so a contract that wants files blocks with `module_unavailable` + `configurationRequired` until a deployment declares it. That is the audit's availability-gated activation, and it is the difference between blocking and shipping a dead upload button.

## What is claimed, and what is not

Every claim is keyed on something the contract states: a declared field type, a requirement signal,
or the contract's own vocabulary. Where the contract is silent the plan is empty rather than
defaulted. An upload surface nobody described, an inbox nobody reads and a socket nobody needs are
all costs an application did not agree to.

A field named `fileId` is a reference to a file, not a file, and does not make its entity a file
subject. A limit the platform chose rather than the contract is recorded under `defaults`, so a
reader can tell a declared limit from a fallback one.

## Compatibility

- The SDK's `storage`, `notifications` and `db.entity().subscribe` surfaces are unchanged and keep
  working for anything already written against them. The modules sit on top through the facade.
- No module is locked for a contract that declares none of it, and the composed tree for such a
  contract is byte-identical to before.
- Coverage ledger: format `deliveryPlan: 1`; the WP10 catalogue rows for files, notifications and
  realtime were in place from WP0 and now point at registered modules.

## Tests

`builder-v2-files-notifications-realtime.test.mjs` (13): policy refusal by type, size, emptiness
and quota with nothing sent; storage plus metadata written together, per-subject quotas and
prefixes, signed-URL expiry, and cleanup of both sides on subject removal; a broken storage surface
as a reported error state; idempotent delivery across repeated sends with different subjects still
distinct; undeclared events refused and server-only recipients never written from the client; the
derived unread badge with an optimistic receipt that rolls back, and empty distinguished from
ready; reconnect resync with `resync: false` respected; one channel per topic with a real close on
last unsubscribe; undeclared and unauthorised subscriptions refused; the plan derived from declared
fields and contract words with silence claiming nothing; a declaring contract locking all three
modules and composing protected facades; the storage availability gate; and a negative control
where a quiet contract composes none of it.
