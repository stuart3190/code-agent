import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRepository,
  extractFileIntelligence,
} from "../../shell/server/lib/repositoryIntelligence.mjs";

test("language-aware extraction finds definitions across major repository languages", () => {
  const fixtures = [
    {
      language: "typescript",
      content: "export interface Session {}\nexport async function authenticate() {}\n",
      expected: [["Session", "interface"], ["authenticate", "function"]],
    },
    {
      language: "python",
      content: "class Account:\n    async def login(self):\n        return True\n",
      expected: [["Account", "class"], ["login", "method"]],
    },
    {
      language: "go",
      content: "type Server struct {}\nfunc (s *Server) Start() {}\n",
      expected: [["Server", "struct"], ["Start", "method"]],
    },
    {
      language: "rust",
      content: "pub trait Runner {}\npub fn execute() {}\n",
      expected: [["Runner", "trait"], ["execute", "function"]],
    },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const file = {
      fileId: `file-${index}`,
      path: `fixture-${index}`,
      pathHash: `hash-${index}`,
      ...fixture,
    };
    const result = extractFileIntelligence(file);
    for (const [name, kind] of fixture.expected) {
      assert.ok(result.symbols.some((symbol) => symbol.name === name && symbol.kind === kind));
    }
  }
});

test("repository graph resolves imports, calls, and reverse dependencies", () => {
  const graph = analyzeRepository([
    {
      fileId: "auth-file",
      path: "src/auth.ts",
      pathHash: "auth-hash",
      language: "typescript",
      content: "export function verifyToken(token) {\n  return Boolean(token);\n}\n",
    },
    {
      fileId: "app-file",
      path: "src/app.ts",
      pathHash: "app-hash",
      language: "typescript",
      content: "import { verifyToken } from './auth';\nexport function login(token) {\n  return verifyToken(token);\n}\n",
    },
  ]);
  const verify = graph.symbols.find((symbol) => symbol.name === "verifyToken");
  assert.ok(verify);
  assert.ok(graph.relations.some((relation) =>
    relation.kind === "imports"
      && relation.sourceFileId === "app-file"
      && relation.targetFileId === "auth-file"));
  assert.ok(graph.relations.some((relation) =>
    relation.kind === "calls"
      && relation.sourceFileId === "app-file"
      && relation.targetSymbolId === verify.id));
  assert.equal(graph.dependencyCount, 1);
});

test("repository graph resolves Python package-relative imports", () => {
  const graph = analyzeRepository([
    {
      fileId: "helper-file",
      path: "src/package/helpers.py",
      pathHash: "helper-hash",
      language: "python",
      content: "def verify_token(token):\n    return bool(token)\n",
    },
    {
      fileId: "service-file",
      path: "src/package/service.py",
      pathHash: "service-hash",
      language: "python",
      content: "from .helpers import verify_token\n\ndef login(token):\n    return verify_token(token)\n",
    },
  ]);
  assert.ok(graph.relations.some((relation) =>
    relation.kind === "imports"
      && relation.sourceFileId === "service-file"
      && relation.targetFileId === "helper-file"));
});
