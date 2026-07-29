export function createLocalDraft(name = "Untitled app") {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), name, tree: null, prompts: [], previewRef: null, knowledge: "",
    publishedUrl: null, designProfile: null, createdAt: now, updatedAt: now, transient: true,
  };
}
