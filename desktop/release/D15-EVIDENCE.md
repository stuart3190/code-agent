# D15 private release evidence

The pinned Code OSS 1.131.0 checkout at `3a03d6f72d628a7741c29f456b4ddbb5ae68502c` was restored, dependency-installed, compiled with zero TypeScript errors, and packaged as a private Windows x64 Thrallo build. The package contains the genuine Code OSS workbench, the built-in Thrallo extension at 0.4.0, D9-D14 commands, Open VSX configuration, the `thrallo` product scheme, disabled telemetry, and no upstream Copilot built-in.

The initial dependency restore exposed a release-order defect: bootstrap removed `extensions/copilot` before upstream postinstall enumerated that workspace, reported misleadingly by Node as `cmd.exe ENOENT`. D15 separates dependency restoration from post-install Copilot exclusion. The corrected ordering passed and the compile/package completed.

The private portable archive and installer are retained under ignored `desktop/out/` for later approved integration review. They are not committed, uploaded, published, or referenced by a customer manifest. Both executable forms are Authenticode-unsigned and therefore release-ineligible. The isolated installer installed as Thrallo Desktop, then uninstalled with exit 0; its shortcut, uninstall key, processes, and empty directory residue were removed.

Packaged smoke launched the actual Electron workbench with no PAT and no production dependency. It proved launch, Thrallo identity, and Home. The raw harness reported 5/13, but visual review showed the Settings and Companion matches were false positives from those labels in Home navigation. Screenshots also show the command palette had no matching results and the edit selector targeted the agent input. Only 3/13 are therefore visually substantiated. A follow-up Windows app-control connection was unavailable because sandbox policy metadata was missing.

The `thrallo` scheme is present in product configuration, and the D15 callback validator accepts only `thrallo://auth/callback` with `code` and `state`. Runtime protocol forwarding is not claimed: the current installer lacks an explicit scheme-registration section, and the extension does not yet register a packaged URI handler. Wiring that to a future server authorization provider remains a separately approved auth integration.

macOS x64/ARM64 and Linux x64/ARM64 remain configured-only. No genuine macOS or Linux runner was used, and no signing/notarization claim is made. Windows ARM64 is likewise configured-only.

The signed-update contracts cover internal manifests, identity/platform/architecture checks, injected manifest verification, artifact hash/signature verification, interruption-safe staging, startup validation, compatible rollback, withdrawal, offline/unavailable states, and fail-closed release gates. There is no update server, customer channel activation, arbitrary URL acceptance, execution-before-verification, or production publication path.

Public 0.4.0 is unchanged. D15 is private and not release eligible because the artifact predates the final D15 commit, the build used Node 24.16.0 rather than the pinned 24.18.0, packaged smoke is partial, Authenticode is unavailable, other platforms are unqualified, and no signed rollback artifact exists.
