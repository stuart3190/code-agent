// Analytics export.
//
// The `export` capability flag has existed since analytics shipped and nothing consumed it — Pro
// was sold a feature that had no implementation behind it.
//
// What leaves the building is the AGGREGATE, never the raw events. Visitor and session hashes,
// salts, IP addresses and internal row ids are not in the daily table at all, so this cannot leak
// them even by accident; the only judgement calls are which columns to name and how to label a
// period the plan shortened.

import { serviceClient } from "../supabase.mjs";
import { overview } from "./reports.mjs";

// Named for a person reading a spreadsheet, not for the database.
const DAILY_COLUMNS = [
  ["day", "Date"],
  ["pageviews", "Page views"],
  ["visitors", "Unique visitors"],
  ["sessions", "Sessions"],
  ["errors", "Errors"],
];

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  // Quote everything: page paths and error signatures routinely contain commas and quotes, and a
  // CSV that breaks on the first one is worse than no export.
  return `"${text.replace(/"/g, '""')}"`;
}

function csvSection(title, header, rows) {
  return [`# ${title}`, header.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
}

/**
 * The whole visible dataset for the selected range — not the page on screen.
 *
 * Built from the same `overview()` the UI reads, so an export can never disagree with what the
 * customer was looking at when they pressed the button.
 */
export async function buildAnalyticsExport(owner, projectId, {
  days = 30, format = "json", client = serviceClient(), store = null, now = new Date(),
} = {}) {
  const report = await overview(owner, projectId, { days, client, store, now });
  if (report.unavailable === "not_published") {
    const error = new Error("This project isn't published yet, so there is no analytics data to export.");
    error.status = 409;
    error.code = "not_published";
    throw error;
  }
  if (!report.capabilities.export) {
    const error = new Error("Analytics export is included on Pro.");
    error.status = 402;
    error.code = "plan_required";
    throw error;
  }

  const stamp = now.toISOString();
  const meta = {
    exportedAt: stamp,
    project: String(projectId),
    // The range ACTUALLY covered, plus what was asked for, so a plan-shortened window is visible in
    // the file rather than only in the UI that produced it.
    range: { from: report.window.from, days: report.window.days, requestedDays: Number(days) || 30, shortenedByPlan: report.window.clamped },
    plan: report.capabilities.plan,
    retentionDays: report.capabilities.retentionDays,
    privacy: "Aggregates only. No IP addresses, visitor identifiers, session identifiers, query strings or full referrer URLs are collected or exported.",
    sameDayReturningNote: report.sameDayReturning.note,
    countries: "Unavailable — geolocation is not configured. Country is never inferred from language or timezone.",
  };

  if (format === "json") {
    return {
      filename: `thrallo-analytics-${String(projectId).slice(0, 8)}-${stamp.slice(0, 10)}.json`,
      contentType: "application/json",
      body: JSON.stringify({
        meta,
        totals: report.totals,
        previousPeriod: report.previous,
        changePercent: report.change,
        daily: report.series,
        sameDayReturning: report.sameDayReturning,
        topPages: report.topPages,
        referrers: report.referrers,
        browsers: report.browsers,
        operatingSystems: report.operatingSystems,
        devices: report.devices,
        coreWebVitals: report.vitals,
        errors: report.errors,
      }, null, 2),
    };
  }

  // CSV is several labelled sections in one file rather than one wide sparse table: a spreadsheet
  // of daily totals and a spreadsheet of top pages have different shapes, and forcing them into
  // one grid makes both unreadable.
  const sections = [
    `# Thrallo Analytics export`,
    `# Exported: ${stamp}`,
    `# Range: ${report.window.from} onwards (${report.window.days} days)${report.window.clamped ? ` — shortened from ${days} by the ${report.capabilities.plan} plan` : ""}`,
    `# Privacy: ${meta.privacy}`,
    "",
    csvSection("Daily totals", DAILY_COLUMNS.map(([, label]) => label),
      report.series.map((d) => DAILY_COLUMNS.map(([key]) => d[key]))),
    "",
    csvSection("Top pages", ["Path", "Page views", "Unique visitors"],
      report.topPages.map((r) => [r.key, r.pageviews, r.visitors])),
    "",
    csvSection("Referrers (host only)", ["Referrer host", "Page views", "Unique visitors"],
      report.referrers.map((r) => [r.key, r.pageviews, r.visitors])),
  ];

  if (report.capabilities.fullAnalytics) {
    sections.push(
      "",
      csvSection("Browsers", ["Browser", "Page views", "Unique visitors"],
        report.browsers.map((r) => [r.key, r.pageviews, r.visitors])),
      "",
      csvSection("Operating systems", ["Operating system", "Page views", "Unique visitors"],
        report.operatingSystems.map((r) => [r.key, r.pageviews, r.visitors])),
      "",
      csvSection("Devices", ["Device", "Page views", "Unique visitors"],
        report.devices.map((r) => [r.key, r.pageviews, r.visitors])),
    );
  }

  if (report.errors) {
    sections.push("", csvSection("Errors", ["Error", "Occurrences", "Visitors affected"],
      report.errors.map((r) => [r.key, r.errors, r.visitors])));
  }

  if (report.vitals) {
    sections.push("", csvSection("Core Web Vitals (real visits)",
      ["Metric", "Value", "Samples"], [
        ["LCP (ms)", report.vitals.lcpMs, report.vitals.samples],
        ["FCP (ms)", report.vitals.fcpMs, report.vitals.samples],
        ["INP (ms)", report.vitals.inpMs, report.vitals.samples],
        ["TTFB (ms)", report.vitals.ttfbMs, report.vitals.samples],
        ["CLS", report.vitals.cls, report.vitals.samples],
      ]));
  }

  sections.push("", csvSection("Same-day returning", ["Measure", "Value"], [
    ["Visitors with more than one session that day", report.sameDayReturning.visitors],
    ["Note", report.sameDayReturning.note],
  ]));

  return {
    filename: `thrallo-analytics-${String(projectId).slice(0, 8)}-${stamp.slice(0, 10)}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: sections.join("\n"),
  };
}
