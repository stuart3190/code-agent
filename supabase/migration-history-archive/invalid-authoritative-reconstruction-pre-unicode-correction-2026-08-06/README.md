# Invalid first authoritative reconstruction

This directory preserves the 61 active migration files as they existed immediately before the
2026-08-06 Unicode correction. The first production-ledger export crossed a lossy Windows text
boundary and replaced non-ASCII punctuation in 13 historical SQL statements with question marks.
The schema was unaffected because the changed text was confined to comments and comment strings,
but the files were not faithful copies of the authoritative ledger.

The production migration ledger was never changed. The active 60 historical migrations were
re-read through the connected Supabase plugin, written byte-for-byte from the authoritative
`statements` arrays, and protected from Git line-ending conversion by the repository
`.gitattributes`. The additive reconciliation migration remains migration 61 and is not applied to
production.
