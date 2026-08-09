# C3 filesystem provider boundary

The Files UI consumes the host-neutral provider exported by `fixtureProvider.js`. Its operations use workspace-root-relative virtual paths, optimistic revisions, typed conflicts, bounded listings, and deterministic transfer records.

The fixture provider has no host-filesystem, shell, network, upload-picker, Daytona, Supabase, Builder V2, or production capability. `hostFilesystem`, `realUpload`, `realDownload`, and `network` are explicitly false.

C8 may implement the same interface against an approved workspace gateway. It must not change the Files presentation contract or introduce a fallback from an unavailable workspace gateway to the browser host filesystem.
