// App identity — a generated display NAME + icon GLYPH per project, used for the PWA manifest,
// the phone install icon and the Android app. Generated ONCE (a single Codex call, free on the
// ChatGPT sub) from the app's first build prompt, then stored on the project and reused on every
// republish. Fail-soft everywhere: any error falls back to the caller's name + the default glyph,
// so a publish is never blocked on it.

import { serviceClient } from "./supabase.mjs";
import { createCodexProvider } from "../../../src/providers/codexProvider.mjs";
import { GLYPH_SLUGS, DEFAULT_GLYPH } from "./iconGlyphs.mjs";

function firstPromptOf(history) {
  if (!Array.isArray(history)) return "";
  for (const turn of history) {
    const p = typeof turn?.prompt === "string" ? turn.prompt : "";
    if (p.trim()) return p.trim();
  }
  return "";
}

function cleanName(raw, fallback) {
  let n = String(raw || "").replace(/[\r\n"]/g, " ").replace(/\s+/g, " ").trim();
  if (n.length > 24) n = n.slice(0, 24).trim();
  return n || fallback;
}

export async function ensureAppIdentity({ projectId, fallbackName, log = () => {} }) {
  const svc = serviceClient();
  const { data: proj } = await svc
    .from("projects").select("name, history, app_name, app_icon").eq("id", projectId).maybeSingle();

  // Cached — generate once per project.
  if (proj?.app_name && proj?.app_icon) {
    return { name: proj.app_name, icon: proj.app_icon };
  }

  const fb = cleanName(fallbackName, "My App");
  try {
    const brief = firstPromptOf(proj?.history) || proj?.name || fallbackName || "a web app";
    const { text } = await createCodexProvider().runTurn({
      systemPrompt:
        `You name apps and choose an icon. Given a short app description, reply with ONLY JSON:\n` +
        `{"name":"<short real app name>","icon":"<one slug>"}\n` +
        `- name: a natural, brandable app name, max 24 chars, Title Case, no quotes, avoid a bare ` +
        `"App" suffix unless it reads naturally.\n` +
        `- icon: EXACTLY ONE slug from this list (closest match): ${GLYPH_SLUGS.join(", ")}.\n` +
        `  If nothing fits, use "${DEFAULT_GLYPH}".`,
      messages: [{ role: "user", content: `App: ${brief}` }],
      tools: [],
    });
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    const name = cleanName(parsed.name, fb);
    const icon = GLYPH_SLUGS.includes(parsed.icon) ? parsed.icon : DEFAULT_GLYPH;
    await svc.from("projects").update({ app_name: name, app_icon: icon }).eq("id", projectId);
    log(`identity: "${name}" / ${icon}`);
    return { name, icon };
  } catch (e) {
    log(`identity: fell back (${String(e.message || e).slice(0, 100)})`);
    return { name: fb, icon: DEFAULT_GLYPH };
  }
}
