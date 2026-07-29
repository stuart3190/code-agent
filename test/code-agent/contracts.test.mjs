import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeAgentInputError, parseAgentInput, parseRepositoryInput, parseRunInput,
} from "../../shell/server/lib/codeAgentContracts.mjs";

test("repository input only accepts an owner/name GitHub repository", () => {
  assert.deepEqual(parseRepositoryInput({ fullName: "openai/openai-node", private: false }), {
    full_name: "openai/openai-node",
    clone_url: "https://github.com/openai/openai-node.git",
    default_branch: "main",
    private: false,
    provider: "github",
  });
  assert.throws(() => parseRepositoryInput({ fullName: "invalid" }), CodeAgentInputError);
  assert.throws(() => parseRepositoryInput({ fullName: "a/b", cloneUrl: "file:///etc/passwd" }), CodeAgentInputError);
});
test("agent and run inputs are bounded and mode checked", () => {
  const agent = parseAgentInput({ repositoryId: "repo-1", name: "Fixer", mode: "review" });
  assert.equal(agent.mode, "review");
  assert.equal(parseRunInput({ prompt: "Fix the failing test." }, agent).mode, "review");
  assert.throws(() => parseRunInput({ prompt: "", mode: "agent" }, agent), CodeAgentInputError);
});
