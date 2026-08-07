# C7 current execution map (pre-change)

Captured from remediation branch `remediation/builder-v2-production` at
`9f05aa8310c066f96b1002d1cd436ae67beda318` before worker-isolation changes.

## Production shell paths

| Entry | Current call chain | Expensive work in `thrallo-shell` | Failure/restart behavior |
|---|---|---|---|
| `POST /api/generate` | `routes/generate.mjs:21-69` -> `buildJobs.createJob` -> in-process `schedule`/`runJob` | The complete Builder V1 engine, dependency refresh, stage compiles, final compile, polish compile, preview startup and shadow indexing | `build_jobs` stores coarse state only; the input and queue authority are process memory. Shell restart marks work interrupted and cannot resume it. |
| Conversation `startAppBuild` | `appBuildService.mjs:637-688` -> the same `buildJobs.createJob` path | Same as `/api/generate` | Same in-memory authority; relay subscriptions are process-local. |
| Repair and verification repair | `appBuildService.mjs:969-979`, `1492-1528`, `1400-1448` -> `createJob(mode=iterate)` | Repair model work plus stage/final compiles | Lost on shell restart; cancellation is a Boolean checked only between engine log callbacks. |
| Stage compile | `buildJobs.mjs:941-949` -> `runStageGate` -> `harness/workspace.mjs:59-82` | synchronous `npm run build` through `execFileSync` | Blocks the shell event loop. |
| Final/re-polish compile | `buildJobs.mjs:1095-1150`, `1225-1236` -> `harness/workspace.mjs` | synchronous `npm install` when shared dependencies are absent/stale and synchronous `npm run build` | Blocks the shell event loop; no process-tree cancellation or per-build cgroup. |
| Verification gate | `appBuildService.mjs:1155-1454` -> `verificationAgent.verifyApp` and `journeyVerifier.verifyJourneys` | Playwright Chromium and all browser journeys | Browser belongs to shell; timeout/crash/resource pressure shares the shell service. |
| QA route | `routes/qa.mjs:11-21` -> `qaRuns.createQaRun` -> detached in-process `execute` -> `qaRunner.runQaBrowser` | preview startup, Chromium crawl and screenshots | `active` is process memory. Restart leaves queued/running rows for a later stale sweep rather than recovery. |
| Legacy direct publish | `routes/publish.mjs:146-225` | `ensureDeps`, synchronous compile, PWA icon Chromium rendering, dist traversal, provisiond upload | A long HTTP request owns the work; shell restart loses it. |
| Conversation publish | `appPublishService.publishApp:162-316` | `ensureDeps`, synchronous compile and dist traversal before provisiond | Runs in shell conversation execution; no durable work lease. |
| Deployment rollback | `appPublishService.rollbackToDeployment:386-486` | rebuilds retained source with `ensureDeps`/`buildTree` before activation | Runs in shell and rebuilds rather than activating immutable output (C8 remains out of scope for this phase). |
| Android package | `routes/android.mjs:18-55` -> `android.buildAndroid` | synchronous Docker invocation through `execFileSync` | Blocks the shell event loop for the whole package build. |
| Local preview mode | `preview/index.mjs:55-130` | dependency install, synchronous Windows junction creation, Vite child lifecycle | Development-only when `PREVIEW_MODE=local`; production VPS mode delegates preview containers to provisiond. |

## Builder V2 and asset paths

| Path | Current behavior |
|---|---|
| `builderV2/verification.mjs` | Calls the same `journeyVerifier.verifyJourneys`; it would launch Chromium in whichever process owns the future V2 composition. V2 customer composition still returns `handled:false`, so this is not yet a customer path. |
| `builderV2/assets/assetService.mjs` -> `assets/optimiser.mjs` | Provider download, MIME/pixel/decompression checks, Sharp AVIF/WebP/blur generation and Storage upload execute in the caller. The live V2 composition is not wired, but the boundary is unsafe to enable as-is. |
| `runtime-worker/index.mjs` | Existing capability worker consumes `background_tasks` for generated-app actions. It is durable only for that action queue and does not lease or execute Builder compile/browser/publish work. It is retained, not overloaded with build authority. |

## `harness/workspace.mjs` consumers outside the shell

The harness and `ops/` scripts also import `ensureDeps`/`buildTree` for deterministic local
proofs. They are CLI/test processes, not customer HTTP execution. They remain allowed to run
locally, but the shared command runner must become asynchronous and process-tree cancellable so
the production worker can use the same build bar without `execFileSync`.

## Design consequence

The smallest safe boundary is a separate durable `build_work_jobs` queue rather than reusing
`background_tasks` (different trust and resource model) or pretending the existing process-local
`build_jobs` registry is durable. `build_jobs` remains the customer-facing Builder V1 lifecycle;
it links to a durable worker job when the worker path is enabled. Expensive leaf operations use
typed worker jobs, while model orchestration can move as a `builder_pipeline` job without changing
Builder V1's external behavior. The enable flag stays off until the additive migration, worker
image, and service are deployed in order.
