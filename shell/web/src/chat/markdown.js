// Minimal, dependency-free markdown for Lead Agent replies: paragraphs, bold, italics,
// inline/fenced code, links, and simple lists. Input is escaped before any markup is
// applied, so model output can never inject HTML.

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>');
}

export function renderMarkdown(raw) {
  const src = escapeHtml(String(raw || ""));
  const blocks = src.split(/```/);
  let html = "";
  for (let i = 0; i < blocks.length; i += 1) {
    if (i % 2 === 1) { // fenced code block
      const body = blocks[i].replace(/^[a-z]*\n/, "");
      html += `<pre><code>${body}</code></pre>`;
      continue;
    }
    for (const para of blocks[i].split(/\n{2,}/)) {
      const lines = para.split("\n").filter((l) => l.trim() !== "");
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        html += `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        html += `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      } else {
        html += `<p>${lines.map(inline).join("<br/>")}</p>`;
      }
    }
  }
  return html;
}
