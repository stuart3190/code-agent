import assert from "node:assert/strict";
import test from "node:test";

import { assertWorkerCredentialAuthority } from "../../build-worker/runtimeConfig.mjs";

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
