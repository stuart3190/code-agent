import { assertNoPlatformSecrets as sharedAssertNoPlatformSecrets, PLATFORM_SECRET_MARKERS } from "./secretScrub.mjs";
import { REACT_VITE } from "../../../src/scaffolds/reactVite.mjs";

export const SAFE_ENV_EXAMPLE = `# Supabase project settings for exported Thrallo apps.
# Fill these in only if your app uses auth, persistence, or uploads.
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_APP_ID=
VITE_AUTH_URL=
VITE_PAYMENTS_URL=
VITE_ACTIONS_URL=
VITE_ANALYTICS_URL=
`;

export const SAFE_GITIGNORE = `node_modules/
dist/
.env
.env.*
!.env.example
`;

// Kept as a re-export so `_internal.REQUIRED_SECRET_MARKERS` stays a stable name for the
// existing harness assertions; the values now come from the single shared rule set.
const REQUIRED_SECRET_MARKERS = PLATFORM_SECRET_MARKERS;

function parseJsonObject(raw, fallback = {}) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function packageNameFromProject(name) {
  const stem = String(name || "thrallo-app")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
  return stem || "thrallo-app";
}

export function safeZipFilename(name) {
  return `${packageNameFromProject(name).replace(/[._]+/g, "-")}.zip`;
}

export function normalizePackageJson(existingRaw, projectName) {
  const scaffold = parseJsonObject(REACT_VITE["package.json"], {});
  const existing = parseJsonObject(existingRaw, {});
  const scripts = {
    ...(existing.scripts && typeof existing.scripts === "object" ? existing.scripts : {}),
    ...(scaffold.scripts && typeof scaffold.scripts === "object" ? scaffold.scripts : {})
  };
  const dependencies = {
    ...(existing.dependencies && typeof existing.dependencies === "object" ? existing.dependencies : {}),
    ...(scaffold.dependencies && typeof scaffold.dependencies === "object" ? scaffold.dependencies : {})
  };
  const devDependencies = {
    ...(existing.devDependencies && typeof existing.devDependencies === "object" ? existing.devDependencies : {}),
    ...(scaffold.devDependencies && typeof scaffold.devDependencies === "object" ? scaffold.devDependencies : {})
  };

  const normalized = {
    ...existing,
    name: packageNameFromProject(existing.name || projectName),
    version: typeof existing.version === "string" ? existing.version : scaffold.version || "0.0.0",
    private: true,
    type: "module",
    scripts,
    dependencies,
    devDependencies
  };

  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function promptText(item) {
  if (!item || typeof item !== "object") return "";
  const value = item.prompt || item.message || item.text || "";
  return typeof value === "string" ? value.trim() : "";
}

function historyPrompt(history, fromEnd = false) {
  if (!Array.isArray(history)) return "";
  const entries = fromEnd ? [...history].reverse() : history;
  for (const item of entries) {
    const text = promptText(item);
    if (text) return text;
  }
  return "";
}

function sentence(text, max = 260) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 3).trim()}...` : compact;
}

function usesBackendSdk(files) {
  for (const [path, contents] of Object.entries(files)) {
    if (!path.startsWith("src/") || path.startsWith("src/lib/backend/")) continue;
    if (typeof contents !== "string") continue;
    if (contents.includes("./lib/backend") || contents.includes("../lib/backend")) return true;
  }
  return false;
}

export function renderReadme(project, files) {
  const name = String(project?.name || "Thrallo App").trim() || "Thrallo App";
  const firstPrompt = sentence(historyPrompt(project?.history, false));
  const lastPrompt = sentence(historyPrompt(project?.history, true));
  const backendLine = usesBackendSdk(files)
    ? "This app includes the Supabase helper code used for login, saving data, and uploads. If the app has any of those features, follow the Supabase setup step below before expecting them to work."
    : "This app does not appear to use Supabase yet. You can skip the Supabase step below unless you add login, saving data, or uploads later.";

  const promptBlock = firstPrompt
    ? `\nWHAT THIS APP IS\n----------------\n\nThis project was generated from this description:\n\n    "${firstPrompt}"\n`
    : "";
  const lastPromptBlock = lastPrompt && lastPrompt !== firstPrompt
    ? `\nYour most recent change request was:\n\n    "${lastPrompt}"\n`
    : "";

  // Plain text on purpose (README.txt, not .md): a beginner who double-clicks this file
  // opens it in Notepad / TextEdit and should see clean, readable words -- not markdown
  // symbols like # and backticks. Commands are indented four spaces so they stand out.
  return `${name}
${"=".repeat(Math.max(name.length, 3))}

This is a web app you exported from Thrallo. It is built with Vite, React,
and Tailwind CSS.

You do NOT need Thrallo to run it. Everything you need is inside this folder.
This guide walks you through it one step at a time. Take it slowly -- you do not
need to understand every word, just follow the steps in order.
${promptBlock}${lastPromptBlock}
WHAT IS IN THIS FOLDER
----------------------

    src/                 the app's source code
    package.json         the list of tools the app needs
    index.html           the page that opens in the browser
    vite.config.js       build tool settings
    tailwind.config.js   styling settings
    postcss.config.js    styling settings
    .env.example         a safe template for secret settings
    README.txt           this guide


STEP 1 - INSTALL NODE.JS (ONE TIME ONLY)
----------------------------------------

Node.js is the free program that runs this app. It comes with a helper called
"npm" that installs and starts everything for you. You only have to do this once
per computer.

    1. Go to https://nodejs.org/
    2. Download the version labelled "LTS" (it means Long Term Support).
    3. Install it, clicking Next / Continue and accepting the defaults.
    4. VERY IMPORTANT: close every terminal window you have open, then open a
       fresh one. The installer only takes effect in new windows.

To check it worked, open a terminal and type these two lines, pressing Enter
after each:

    node -v
    npm -v

If each line prints a version number (something like v20.11.0), you are ready.
If instead you see "not recognized" or "command not found", Node.js is not
installed yet, or you did not open a fresh terminal -- see COMMON PROBLEMS below.


STEP 2 - RUN THE APP ON YOUR COMPUTER
-------------------------------------

Before You Start: make sure you have unzipped this project. If you are reading
this from inside the ZIP file, extract it first, then open the extracted folder.
You should see this README.txt file and package.json next to each other.

2a. Open a terminal INSIDE this folder.

    On Windows:
        - Open the extracted folder in File Explorer.
        - Click the white address bar at the very top of the window.
        - Type the word:  cmd
        - Press Enter. A black terminal window opens in this folder.

    On a Mac:
        - Open the Terminal app (find it with Spotlight: Cmd + Space, type
          "Terminal").
        - Type "cd" followed by a single space (do not press Enter yet).
        - Drag the extracted project folder onto the Terminal window.
        - Press Enter.

2b. Install the app's parts. In the terminal, type:

    npm install

Press Enter and wait. This can take a minute or two. It creates a folder called
"node_modules". That folder is normal, it can be large, and you never need to
open or edit it by hand.

2c. Start the app. Type:

    npm run dev

2d. Open the app in your browser. After "npm run dev" runs, the terminal shows a
local web address. It is almost always:

    http://localhost:5173/

Copy that address into your web browser (Chrome, Edge, Safari, Firefox) and
press Enter. Your app is now running.

2e. To stop the app later, click back on the terminal window and press:

    Ctrl + C

(Hold the Ctrl key and tap the C key. On a Mac it is still Ctrl + C, not
Command.)


STEP 3 - SUPABASE SETUP (ONLY IF YOUR APP SAVES DATA OR HAS LOGINS)
-------------------------------------------------------------------

${backendLine}

Supabase is a free service that stores your app's data and handles logins. If
your app does not have those features, skip this whole step.

If it does, set it up like this:

    1. Create a free account and project at https://supabase.com/
    2. Open your new project's dashboard.
    3. Click "Project Settings", then "API".
    4. Copy the "Project URL".
    5. Copy the "anon public" key.
       Do NOT copy the "service_role" key -- that one is secret and must never
       go into this app.

Now make your own settings file:

    On Windows, in the terminal, type:
        copy .env.example .env

    On a Mac or Linux, type:
        cp .env.example .env

Then open the new ".env" file in a plain text editor (Notepad works) and paste
your two values in:

    VITE_SUPABASE_URL=your_project_url_here
    VITE_SUPABASE_ANON_KEY=your_anon_public_key_here

A few safety rules:

    - Only ever use the "anon public" key in this app.
    - Never put the Supabase service_role key in this project.
    - Never put Stripe secret keys or other passwords in this project.
    - After changing the .env file, stop the app (Ctrl + C) and run
      "npm run dev" again so it picks up the new settings.


STEP 4 - PUT YOUR APP ONLINE (OPTIONAL)
---------------------------------------

When the app works on your computer, you can build a shareable version:

    npm run build

This creates a "dist" folder containing your finished website. To preview that
finished version on your computer:

    npm run preview

To share it with the world, upload the project to a free host. Two that are
easy for beginners are Vercel and Netlify.

    Vercel (https://vercel.com/):
        1. Create a free account.
        2. Create a new project and import this folder.
        3. Set the Build Command to:  npm run build
        4. Set the Output Directory to:  dist
        5. If you use Supabase, add VITE_SUPABASE_URL and
           VITE_SUPABASE_ANON_KEY in the project's Environment Variables.

    Netlify (https://netlify.com/):
        1. Create a free account.
        2. Add a new site and import this folder.
        3. Set the Build Command to:  npm run build
        4. Set the Publish Directory to:  dist
        5. If you use Supabase, add VITE_SUPABASE_URL and
           VITE_SUPABASE_ANON_KEY in the site's Environment Variables.


COMMON PROBLEMS
---------------

"npm is not recognized" / "command not found: npm"
    Node.js is not installed, or you opened your terminal before installing it.
    Install Node.js from https://nodejs.org/, then close and reopen the terminal
    and try again.

The page is blank / white.
    Look at the terminal running "npm run dev" for red error text. You can also
    open the browser's developer console to see errors:
        - Windows / Linux: press F12
        - Mac: press Option + Command + I

Supabase features (login, saved data) do not work.
    Check that a ".env" file exists next to package.json and that it contains
    real values for VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Then stop the
    app with Ctrl + C and run "npm run dev" again.

You changed a file but the browser did not update.
    Refresh the browser page. If that does not help, stop the app with Ctrl + C
    and run "npm run dev" again.


QUICK COMMAND REFERENCE
-----------------------

    npm install      install the app's parts (run this first)
    npm run dev      run the app on your computer
    npm run build    build the shareable version
    npm run preview  preview the shareable version
`;
}

function normalizeArchivePath(path) {
  if (typeof path !== "string") return null;
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

export function isSafeArchivePath(path) {
  const normalized = normalizeArchivePath(path);
  if (!normalized) return false;
  const parts = normalized.split("/");
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => part === ".git" || part === "node_modules" || part === "dist")) return false;
  if (["shell", "server", "provisiond", "harness", "baseline", "supabase"].includes(lowerParts[0])) return false;

  const file = lowerParts[lowerParts.length - 1];
  if (file === ".env") return false;
  if (file.startsWith(".env.") && file !== ".env.example") return false;
  if (file.endsWith(".key") || file.endsWith(".pem") || file.endsWith(".p12") || file.endsWith(".crt")) return false;
  return true;
}

function stringFileEntries(tree) {
  const entries = {};
  for (const [path, contents] of Object.entries(tree || {})) {
    const normalized = normalizeArchivePath(path);
    if (!normalized || !isSafeArchivePath(normalized)) continue;
    if (typeof contents !== "string") continue;
    entries[normalized] = contents;
  }
  return entries;
}

export function assembleExportTree(project) {
  const projectTree = project?.tree && typeof project.tree === "object" && !Array.isArray(project.tree)
    ? project.tree
    : null;
  if (!projectTree) {
    throw new Error("Project has no generated app tree to export.");
  }

  const completeTree = {
    ...REACT_VITE,
    ...projectTree
  };

  completeTree["package.json"] = normalizePackageJson(completeTree["package.json"], project?.name);
  completeTree[".env.example"] = SAFE_ENV_EXAMPLE;
  completeTree[".gitignore"] = SAFE_GITIGNORE;

  const files = stringFileEntries(completeTree);
  files["README.txt"] = renderReadme(project, files);

  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return {
    files: sorted,
    filename: safeZipFilename(project?.name)
  };
}

let crcTable;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let j = 0; j < 8; j += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

export function createStoredZip(files, date = new Date()) {
  const localParts = [];
  const centralParts = [];
  const { time, date: dosDate } = dosDateTime(date);
  let offset = 0;
  let count = 0;

  for (const [name, contents] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
    count += 1;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readStoredZip(zipBuffer) {
  const buffer = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory record not found.");

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = {};

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP central directory.");
    const method = buffer.readUInt16LE(cursor + 10);
    if (method !== 0) throw new Error("Only stored ZIP entries are supported.");
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local header.");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries[name] = buffer.slice(dataStart, dataStart + compressedSize).toString("utf8");

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function buildProjectZip(project) {
  const { files, filename } = assembleExportTree(project);
  return {
    files,
    filename,
    zip: createStoredZip(files)
  };
}

// Delegates to the shared rule set in lib/secretScrub.mjs. Thrallo had two independent secret
// filters with different rules (this one, and scrubTree for repair checkpoints); a marker added
// to one silently did not protect the other. The behaviour here is unchanged — export still
// THROWS rather than redacting — only the rules are now shared.
export function assertNoPlatformSecrets(files) {
  return sharedAssertNoPlatformSecrets(files);
}

export const _internal = {
  crc32,
  normalizeArchivePath,
  REQUIRED_SECRET_MARKERS
};
