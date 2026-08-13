import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkerCredentialAuthority,
  resolveWorkerJobTypes,
  SUPPORTED_BUILD_JOB_TYPES,
} from "../../build-worker/runtimeConfig.mjs";

test("worker job types default to the supported V2-only set", () => {
  assert.deepEqual(resolveWorkerJobTypes(), [...SUPPORTED_BUILD_JOB_TYPES]);
  assert.ok(SUPPORTED_BUILD_JOB_TYPES.includes("builder_pipeline"));
  assert.ok(!SUPPORTED_BUILD_JOB_TYPES.includes("android_package"));
});

test("worker job types preserve supported subsets and reject retired or unknown types", () => {
  assert.deepEqual(resolveWorkerJobTypes("proof_slow,publish_package,proof_slow"), [
    "proof_slow", "publish_package",
  ]);
  assert.throws(
    () => resolveWorkerJobTypes("builder_pipeline,android_package"),
    (error) => error?.code === "unsupported_worker_job_type" && /android_package/.test(error.message),
  );
  assert.throws(
    () => resolveWorkerJobTypes(", ,"),
    (error) => error?.code === "worker_job_types_required",
  );
});

test("non-pipeline dark workers do not require provider credential authority", () => {
  assert.doesNotThrow(() => assertWorkerCredentialAuthority(["proof_slow"], {}));
});

test("builder pipeline worker refuses the process-local credential store", () => {
  assert.throws(
    () => assertWorkerCredentialAuthority(["builder_pipeline"], {
      CODE_AGENT_STORE: "memory", PLATFORM_ENC_KEY: "present", PREVIEW_MODE: "vps",
      PROVISIOND_URL: "http://127.0.0.1:8790", PROVISIOND_TOKEN: "present",
    }),
    (error) => error.code === "worker_credential_store_required",
  );
});

test("builder pipeline worker requires encrypted owner credential access", () => {
  assert.throws(
    () => assertWorkerCredentialAuthority(["builder_pipeline"], { CODE_AGENT_STORE: "supabase",
      PREVIEW_MODE: "vps", PROVISIOND_URL: "http://127.0.0.1:8790", PROVISIOND_TOKEN: "present" }),
    (error) => error.code === "worker_credential_key_required",
  );
  assert.doesNotThrow(() => assertWorkerCredentialAuthority(["builder_pipeline"], {
    CODE_AGENT_STORE: "supabase", PLATFORM_ENC_KEY: "present", PREVIEW_MODE: "vps",
    PROVISIOND_URL: "http://127.0.0.1:8790", PROVISIOND_TOKEN: "present",
  }));
});
