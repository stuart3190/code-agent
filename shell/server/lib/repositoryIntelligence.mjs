import crypto from "node:crypto";
import path from "node:path";

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]{1,79}/g;
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "sizeof",
  "new", "super", "this", "await", "yield", "print",
]);

export function analyzeRepository(files) {
  const normalizedFiles = (files || []).map((file) => ({
    ...file,
    path: normalizePath(file.path),
    lines: String(file.content || "").split(/\r?\n/),
  }));
  const pathMap = new Map(normalizedFiles.map((file) => [file.path.toLowerCase(), file]));
  const symbols = [];
  const imports = [];

  for (const file of normalizedFiles) {
    const extracted = extractFileIntelligence(file);
    inferSymbolRanges(extracted.symbols, file.lines.length);
    symbols.push(...extracted.symbols);
    imports.push(...extracted.imports);
  }

  const definitionsByName = new Map();
  for (const symbol of symbols) {
    const name = normalizeIdentifier(symbol.name);
    if (!definitionsByName.has(name)) definitionsByName.set(name, []);
    definitionsByName.get(name).push(symbol);
  }

  const relations = [];
  for (const item of imports) {
    const sourceFile = pathMap.get(item.sourcePath.toLowerCase());
    if (!sourceFile) continue;
    const targetFile = resolveImportPath(sourceFile.path, item.specifier, pathMap, sourceFile.language);
    relations.push({
      id: crypto.randomUUID(),
      kind: "imports",
      line: item.line,
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: enclosingSymbol(symbols, sourceFile.fileId, item.line)?.id || null,
      targetFileId: targetFile?.fileId || null,
      targetPath: targetFile?.path || null,
      externalSpecifier: targetFile ? null : item.specifier,
      targetSymbolId: null,
      targetName: item.importedName || null,
    });
  }

  for (const file of normalizedFiles) {
    const seen = new Set();
    let relationCount = 0;
    for (let lineIndex = 0; lineIndex < file.lines.length && relationCount < 800; lineIndex += 1) {
      const lineNumber = lineIndex + 1;
      const line = stripComments(file.lines[lineIndex], file.language);
      for (const match of line.matchAll(IDENTIFIER)) {
        const name = normalizeIdentifier(match[0]);
        const definitions = definitionsByName.get(name);
        if (!definitions?.length || isDeclarationOccurrence(symbols, file.fileId, lineNumber, name)) continue;
        const kind = referenceKind(line, match.index, match[0]);
        const target = chooseDefinition(definitions, file.fileId);
        const key = `${lineNumber}:${name}:${kind}:${target?.id || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({
          id: crypto.randomUUID(),
          kind,
          line: lineNumber,
          sourceFileId: file.fileId,
          sourceSymbolId: enclosingSymbol(symbols, file.fileId, lineNumber)?.id || null,
          targetFileId: target?.fileId || null,
          targetPath: target?.path || null,
          targetSymbolId: definitions.length === 1 ? target.id : null,
          targetName: match[0],
          externalSpecifier: null,
        });
        relationCount += 1;
        if (relationCount >= 800) break;
      }
    }
  }

  return {
    symbols,
    relations: deduplicateRelations(relations),
    dependencyCount: new Set(relations
      .filter((relation) => relation.kind === "imports")
      .map((relation) => `${relation.sourceFileId}:${relation.targetFileId || relation.externalSpecifier}`)).size,
  };
}

export function extractFileIntelligence(file) {
  const symbols = [];
  const imports = [];
  const language = String(file.language || "text").toLowerCase();
  const lines = file.lines || String(file.content || "").split(/\r?\n/);

  const addSymbol = (name, kind, line, exported = false, signature = null) => {
    if (!name || symbols.length >= 300) return;
    symbols.push({
      id: crypto.randomUUID(),
      fileId: file.fileId,
      path: file.path,
      pathHash: file.pathHash,
      name,
      qualifiedName: `${file.path}#${name}`,
      kind,
      language,
      startLine: line,
      endLine: line,
      signature: String(signature || lines[line - 1] || "").trim().slice(0, 500),
      exported: !!exported,
    });
  };
  const addImport = (specifier, line, importedName = null) => {
    if (!specifier || imports.length >= 300) return;
    imports.push({ sourcePath: file.path, specifier, line, importedName });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    let match;
    if (["javascript", "typescript", "jsx", "tsx"].includes(language)) {
      match = raw.match(/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (match) addSymbol(match[2], "function", line, !!match[1], raw);
      match = raw.match(/^\s*(export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
      if (match) addSymbol(match[2], "class", line, !!match[1], raw);
      match = raw.match(/^\s*(export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
      if (match) addSymbol(match[2], /\binterface\b/.test(raw) ? "interface" : /\benum\b/.test(raw) ? "enum" : "type", line, !!match[1], raw);
      match = raw.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      if (match) addSymbol(match[2], "function", line, !!match[1], raw);
      match = raw.match(/^\s*(export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/);
      if (match) addSymbol(match[2], "constant", line, !!match[1], raw);
      for (const importMatch of raw.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g)) addImport(importMatch[1], line);
      for (const importMatch of raw.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) addImport(importMatch[1] || importMatch[2], line);
      match = raw.match(/^\s*import\s*["']([^"']+)["']/);
      if (match) addImport(match[1], line);
    } else if (language === "python") {
      match = raw.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/);
      if (match) addSymbol(match[1], /^\s+/.test(raw) ? "method" : "function", line, !match[1].startsWith("_"), raw);
      match = raw.match(/^\s*class\s+([A-Za-z_]\w*)/);
      if (match) addSymbol(match[1], "class", line, !match[1].startsWith("_"), raw);
      match = raw.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)/);
      if (match) addImport(match[1], line, match[2].split(",")[0].trim());
      match = raw.match(/^\s*import\s+([.\w]+)/);
      if (match) addImport(match[1], line);
    } else if (language === "go") {
      match = raw.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/);
      if (match) addSymbol(match[1], raw.includes(")") && raw.indexOf(")") < raw.indexOf(match[1]) ? "method" : "function", line, /^[A-Z]/.test(match[1]), raw);
      match = raw.match(/^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/);
      if (match) addSymbol(match[1], match[2], line, /^[A-Z]/.test(match[1]), raw);
      for (const importMatch of raw.matchAll(/"([^"]+)"/g)) {
        if (/^\s*(?:import\b|\(|[A-Za-z_.]*\s*")/.test(raw)) addImport(importMatch[1], line);
      }
    } else if (language === "rust") {
      match = raw.match(/^\s*(pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
      if (match) addSymbol(match[2], "function", line, !!match[1], raw);
      match = raw.match(/^\s*(pub\s+)?(struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/);
      if (match) addSymbol(match[3], match[2] === "mod" ? "module" : match[2], line, !!match[1], raw);
      match = raw.match(/^\s*use\s+([^;]+)/);
      if (match) addImport(match[1].trim(), line);
      match = raw.match(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)/);
      if (match) addImport(match[1], line);
    } else if (["java", "csharp", "cpp", "swift", "kotlin", "kt", "kts"].includes(language)) {
      match = raw.match(/\b(class|interface|enum|struct)\s+([A-Za-z_]\w*)/);
      if (match) addSymbol(match[2], match[1], line, /\bpublic\b/.test(raw), raw);
      match = raw.match(/^\s*(?:public|private|protected|internal|static|virtual|override|async|final|synchronized|\s)+\s*[\w<>,.?\[\]]+\s+([A-Za-z_]\w*)\s*\(/);
      if (match && !CALL_KEYWORDS.has(match[1])) addSymbol(match[1], "method", line, /\bpublic\b/.test(raw), raw);
      match = raw.match(/^\s*(?:import|using)\s+([^;]+)/);
      if (match) addImport(match[1].trim(), line);
    } else if (language === "ruby") {
      match = raw.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/);
      if (match) addSymbol(match[1], "method", line, !match[1].startsWith("_"), raw);
      match = raw.match(/^\s*(class|module)\s+([A-Za-z_:]\w*)/);
      if (match) addSymbol(match[2], match[1] === "module" ? "module" : "class", line, true, raw);
      match = raw.match(/^\s*require(?:_relative)?\s+["']([^"']+)["']/);
      if (match) addImport(match[1], line);
    } else if (language === "php") {
      match = raw.match(/\bfunction\s+([A-Za-z_]\w*)/);
      if (match) addSymbol(match[1], "function", line, /\bpublic\b/.test(raw), raw);
      match = raw.match(/\b(class|interface|trait|enum)\s+([A-Za-z_]\w*)/);
      if (match) addSymbol(match[2], match[1], line, true, raw);
      match = raw.match(/^\s*(?:require|require_once|include|include_once)\s*\(?["']([^"']+)/);
      if (match) addImport(match[1], line);
    } else if (language === "sql") {
      match = raw.match(/^\s*create\s+(?:or\s+replace\s+)?(function|table|view)\s+(?:[\w"]+\.)?["]?([A-Za-z_]\w*)/i);
      if (match) addSymbol(match[2], match[1].toLowerCase(), line, true, raw);
    }
  }

  return { symbols: deduplicateSymbols(symbols), imports };
}

function inferSymbolRanges(symbols, lineCount) {
  symbols.sort((a, b) => a.startLine - b.startLine);
  for (let index = 0; index < symbols.length; index += 1) {
    const next = symbols[index + 1];
    symbols[index].endLine = Math.max(symbols[index].startLine, Math.min(
      next ? next.startLine - 1 : lineCount,
      symbols[index].startLine + 500,
    ));
  }
}

function resolveImportPath(sourcePath, specifierValue, pathMap, language) {
  const specifier = String(specifierValue || "").replaceAll("\\", "/");
  const candidates = [];
  const sourceDir = path.posix.dirname(sourcePath);
  if (language === "python" && specifier.startsWith(".")) {
    const leadingDots = specifier.match(/^\.+/)?.[0].length || 1;
    let baseDir = sourceDir;
    for (let level = 1; level < leadingDots; level += 1) {
      baseDir = path.posix.dirname(baseDir);
    }
    const modulePath = specifier.slice(leadingDots).replaceAll(".", "/");
    const base = path.posix.normalize(path.posix.join(baseDir, modulePath));
    candidates.push(`${base}.py`, `${base}/__init__.py`);
  } else if (specifier.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(sourceDir, specifier));
    candidates.push(base, ...extensionCandidates(base), ...indexCandidates(base));
  } else if (language === "python") {
    const modulePath = specifier.replaceAll(".", "/");
    const base = path.posix.normalize(modulePath);
    candidates.push(`${base}.py`, `${base}/__init__.py`);
  } else if (language === "rust") {
    const modulePath = specifier.replace(/^(?:crate|self|super)::/, "").split("::")[0];
    const base = path.posix.normalize(path.posix.join(sourceDir, modulePath));
    candidates.push(`${base}.rs`, `${base}/mod.rs`);
  } else {
    const suffix = `/${specifier.replaceAll(".", "/")}`;
    for (const [candidatePath] of pathMap) {
      if (candidatePath.endsWith(suffix.toLowerCase()) || candidatePath.includes(`${suffix.toLowerCase()}/`)) {
        return pathMap.get(candidatePath);
      }
    }
  }
  for (const candidate of candidates) {
    const found = pathMap.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}

function extensionCandidates(base) {
  return [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".rs", ".go", ".php"]
    .map((extension) => `${base}${extension}`);
}

function indexCandidates(base) {
  return [".js", ".mjs", ".jsx", ".ts", ".tsx", ".py"]
    .map((extension) => `${base}/index${extension}`);
}

function enclosingSymbol(symbols, fileId, line) {
  let best = null;
  for (const symbol of symbols) {
    if (symbol.fileId !== fileId || symbol.startLine > line || symbol.endLine < line) continue;
    if (!best || symbol.startLine >= best.startLine) best = symbol;
  }
  return best;
}

function isDeclarationOccurrence(symbols, fileId, line, name) {
  return symbols.some((symbol) =>
    symbol.fileId === fileId && symbol.startLine === line && normalizeIdentifier(symbol.name) === name);
}

function chooseDefinition(definitions, sourceFileId) {
  return definitions.find((symbol) => symbol.fileId === sourceFileId) || definitions[0];
}

function referenceKind(line, offset, identifier) {
  const before = line.slice(0, offset);
  const after = line.slice(offset + identifier.length);
  if (/\bextends\s*$/i.test(before)) return "extends";
  if (/\bimplements\s*$/i.test(before)) return "implements";
  if (/^\s*(?:\?\.)?\s*\(/.test(after) && !CALL_KEYWORDS.has(identifier.toLowerCase())) return "calls";
  return "references";
}

function stripComments(line, language) {
  if (language === "python" || language === "ruby" || language === "shell") return line.replace(/#.*$/, "");
  return line.replace(/\/\/.*$/, "");
}

function deduplicateSymbols(symbols) {
  const seen = new Set();
  return symbols.filter((symbol) => {
    const key = `${symbol.fileId}:${symbol.startLine}:${symbol.kind}:${normalizeIdentifier(symbol.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateRelations(relations) {
  const seen = new Set();
  return relations.filter((relation) => {
    const key = [
      relation.sourceFileId, relation.sourceSymbolId, relation.targetFileId,
      relation.targetSymbolId, normalizeIdentifier(relation.targetName),
      relation.externalSpecifier, relation.kind, relation.line,
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeIdentifier(value) {
  return String(value || "").toLowerCase();
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}
