# D15 private release boundary

D15 builds and validates private artifacts only. Customer publication, public download-manifest changes, stable-channel activation, and merge to main are separate Track C approvals. The public 0.4.0 files are comparison inputs and must remain byte-for-byte unchanged.

Build order is clean checkout, pinned dependency restore, Copilot exclusion, Thrallo overlay sync, compile, package, hash, signing boundary, signature verification, smoke, private manifest, eligibility evaluation, and private retention. Signing credentials come only from protected CI storage; no filesystem or repository fallback exists.

An artifact is customer-release-ineligible if any required gate is absent. In particular, unsigned Windows artifacts remain private, macOS is not considered built or notarized without a genuine macOS runner, and Linux is not considered runtime-qualified without a genuine Linux run.

Future Builder V2 compatibility remains unknown and cannot be inferred by D15. Production update hosting and publication are intentionally absent.
