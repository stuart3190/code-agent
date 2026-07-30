// Local workspace index for Thrallo completions. Runs entirely inside the editor: files are
// chunked and tokenized locally, queries score by identifier overlap, and only the top few
// bounded excerpts ever leave the machine (as the completion request's localContext).
// No vscode dependency — the editor layer feeds files in and takes excerpts out.

"use strict";

const CHUNK_LINES = 30;
const CHUNK_OVERLAP = 10;
const MAX_EXCERPT_CHARS = 1500;

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

function tokensOf(text) {
  const counts = new Map();
  for (const match of String(text).matchAll(TOKEN_RE)) {
    const token = match[0].toLowerCase();
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

// files: [{ path, content }] — the caller enforces file-count/size bounds and exclusions.
function buildLocalIndex(files) {
  const chunks = [];
  for (const file of files) {
    const lines = String(file.content).split("\n");
    for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
      const end = Math.min(start + CHUNK_LINES, lines.length);
      const content = lines.slice(start, end).join("\n");
      if (!content.trim()) continue;
      chunks.push({
        path: file.path,
        startLine: start + 1,
        endLine: end,
        content: content.slice(0, MAX_EXCERPT_CHARS),
        tokens: tokensOf(content),
      });
      if (end >= lines.length) break;
    }
  }
  return { chunks, builtAt: Date.now(), files: files.length };
}

function queryLocalIndex(index, queryText, { limit = 3, excludePath = null } = {}) {
  if (!index?.chunks?.length) return [];
  const queryTokens = tokensOf(queryText);
  if (!queryTokens.size) return [];
  const scored = [];
  for (const chunk of index.chunks) {
    if (excludePath && chunk.path === excludePath) continue;
    let score = 0;
    for (const [token, weight] of queryTokens) {
      const inChunk = chunk.tokens.get(token);
      if (inChunk) score += Math.min(weight, 3) * Math.min(inChunk, 3);
    }
    if (score > 0) scored.push({ chunk, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ chunk, score }) => ({
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    score,
  }));
}

const DEFAULT_EXCLUDES = /(^|[\\/])(node_modules|\.git|dist|build|out|coverage|\.next|target|vendor)([\\/]|$)/;

function isIndexableFile(relativePath, sizeBytes, { maxFileBytes = 200_000 } = {}) {
  if (DEFAULT_EXCLUDES.test(relativePath)) return false;
  if (sizeBytes > maxFileBytes) return false;
  return !/\.(png|jpe?g|gif|ico|icns|pdf|zip|gz|tar|vsix|woff2?|ttf|eot|mp[34]|webm|lock)$/i.test(relativePath);
}

module.exports = { buildLocalIndex, queryLocalIndex, isIndexableFile };
