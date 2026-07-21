import { requireFeature } from "./features.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

export function summarizeAnalytics(events = [], days = 14) {
  const now = new Date();
  const daily = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)).toISOString().slice(0, 10);
    daily.push({ date, events: 0, sessions: new Set(), pageViews: 0, errors: 0 });
  }
  const byDay = new Map(daily.map((row) => [row.date, row]));
  const eventCounts = {};
  const pageCounts = {};
  const allSessions = new Set();
  const errors = [];
  for (const event of events) {
    const day = byDay.get(String(event.created_at).slice(0, 10));
    if (day) {
      day.events += 1; day.sessions.add(event.session_id);
      if (event.name === "page_view") day.pageViews += 1;
      if (event.name === "client_error") day.errors += 1;
    }
    allSessions.add(event.session_id);
    eventCounts[event.name] = (eventCounts[event.name] || 0) + 1;
    if (event.name === "page_view") pageCounts[event.path] = (pageCounts[event.path] || 0) + 1;
    if (event.name === "client_error" && errors.length < 50) errors.push(event);
  }
  return {
    totals: { events: events.length, sessions: allSessions.size, pageViews: eventCounts.page_view || 0, errors: eventCounts.client_error || 0 },
    daily: daily.map((row) => ({ ...row, sessions: row.sessions.size })),
    events: Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    pages: Object.entries(pageCounts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([path, count]) => ({ path, count })),
    errors,
  };
}

export async function analyticsOverview(owner, projectId, days = 14, client = serviceClient()) {
  await requireFeature(owner, "analytics");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const safeDays = Math.max(1, Math.min(90, Number(days) || 14));
  const since = new Date(Date.now() - safeDays * 86400e3).toISOString();
  const { data, error } = await client.from("app_analytics_events")
    .select("id,app_user_id,session_id,name,path,properties,created_at")
    .eq("owner", owner.id).eq("app_id", projectId).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(10_000);
  if (error) throw new Error(`analytics: ${error.message}`);
  return { ...summarizeAnalytics(data || [], safeDays), days: safeDays, truncated: (data || []).length === 10_000 };
}
