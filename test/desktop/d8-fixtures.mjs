import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const D8_SCENARIOS = Object.freeze([
  "clean-vite-react",
  "dirty-git",
  "non-git",
  "plain-html",
  "missing-package",
  "large-tree",
  "symlink-case",
  "secret-containing",
  "binary-assets",
  "moved-project",
  "missing-workspace",
  "corrupt-metadata",
]);

export function createD8Project(scenario) {
  if (!D8_SCENARIOS.includes(scenario)) throw new Error(`Unknown D8 scenario: ${scenario}`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `thrallo-d8-${scenario}-`));
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  const cleanup = () => fs.rmSync(base, { recursive: true, force: true });

  if (scenario === "clean-vite-react") {
    writeTree(root, viteTree("npm"));
    initGit(root);
    commitAll(root);
  } else if (scenario === "dirty-git") {
    writeTree(root, viteTree("pnpm"));
    initGit(root);
    commitAll(root);
    fs.appendFileSync(path.join(root, "src", "App.jsx"), "\nexport const dirty = true;\n");
    fs.writeFileSync(path.join(root, "staged.js"), "export const staged = true;\n");
    git(root, ["add", "staged.js"]);
    fs.writeFileSync(path.join(root, "untracked.txt"), "local only\n");
  } else if (scenario === "non-git") {
    writeTree(root, { "package.json": packageJson({ scripts: { start: "node index.js" } }), "index.js": "console.log('fixture');\n" });
  } else if (scenario === "plain-html") {
    writeTree(root, { "index.html": "<!doctype html><title>D8 fixture</title>", "style.css": "body { color: navy; }\n", "app.js": "document.body.dataset.ready = 'true';\n" });
  } else if (scenario === "missing-package") {
    writeTree(root, { "README.md": "# Local fixture\n", "src/main.ts": "export const ready = true;\n" });
  } else if (scenario === "large-tree") {
    for (let index = 0; index < 24; index += 1) writeTree(root, { [`src/file-${String(index).padStart(2, "0")}.js`]: `export const value${index} = ${index};\n` });
  } else if (scenario === "symlink-case") {
    writeTree(root, { "index.html": "<!doctype html>", "real-assets/data.txt": "safe target\n" });
    fs.symlinkSync(path.join(root, "real-assets"), path.join(root, "linked-assets"), process.platform === "win32" ? "junction" : "dir");
  } else if (scenario === "secret-containing") {
    writeTree(root, {
      "package.json": packageJson({ scripts: { dev: "vite" }, devDependencies: { vite: "0.0.0-fixture" } }),
      ".env": "FAKE_TEST_TOKEN=not-a-real-secret\n",
      ".env.local": "FAKE_LOCAL_VALUE=fixture-only\n",
      "id_rsa": "-----BEGIN FAKE TEST KEY-----\nnot-real\n-----END FAKE TEST KEY-----\n",
      "certificate.crt": "FAKE TEST CERTIFICATE\n",
      "credentials.json": "{\"fixture\":true}",
      ".aws/credentials": "[fixture]\nkey=not-real\n",
      ".gitignore": "ignored.txt\n",
      "ignored.txt": "ignored fixture\n",
      "src/main.js": "console.log('safe');\n",
      "node_modules/example/index.js": "excluded dependency\n",
      "dist/app.js": "excluded build\n",
      ".DS_Store": "fixture metadata\n",
    });
    initGit(root);
  } else if (scenario === "binary-assets") {
    writeTree(root, { "index.html": "<!doctype html>", "assets/pixel.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), "assets/blob.bin": Buffer.from([1, 0, 2, 3]) });
  } else if (scenario === "moved-project") {
    writeTree(root, viteTree("yarn"));
  } else if (scenario === "missing-workspace") {
    fs.rmSync(root, { recursive: true, force: true });
  } else if (scenario === "corrupt-metadata") {
    writeTree(root, { "README.md": "metadata fixture only\n" });
  }
  return { scenario, base, root, cleanup };
}

function viteTree(manager) {
  return {
    "package.json": packageJson({ packageManager: `${manager}@0.0.0-fixture`, scripts: { dev: "vite", start: "vite preview" }, dependencies: { react: "0.0.0-fixture", "react-dom": "0.0.0-fixture" }, devDependencies: { vite: "0.0.0-fixture" } }),
    ...(manager === "pnpm" ? { "pnpm-lock.yaml": "lockfileVersion: fixture\n" } : manager === "yarn" ? { "yarn.lock": "# fixture lock\n" } : { "package-lock.json": "{\"lockfileVersion\":3}\n" }),
    "vite.config.js": "export default {};\n",
    "index.html": "<!doctype html><div id=\"root\"></div>",
    "src/App.jsx": "export function App() { return <main>D8</main>; }\n",
  };
}

function packageJson(overrides) {
  return JSON.stringify({ name: "thrallo-d8-fixture", private: true, ...overrides }, null, 2);
}

function writeTree(root, tree) {
  for (const [relative, content] of Object.entries(tree)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function initGit(root) {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "fixture.user@example.invalid"]);
  git(root, ["config", "user.name", "D8 Fixture"]);
}

function commitAll(root) {
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture baseline"]);
}

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true });
}
