import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const MAX_ROUTES = 12;
const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\./,
];

export function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase();
  if (value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  return PRIVATE_V4.some((pattern) => pattern.test(value));
}

export async function safeBrowserUrl(rawUrl, previewOrigin, cache = new Map()) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.origin === previewOrigin) return true;
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  if (!cache.has(host)) {
    cache.set(host, lookup(host, { all: true }).then((rows) => rows.length > 0 && rows.every((row) => !isPrivateAddress(row.address))).catch(() => false));
  }
  return cache.get(host);
}

function uniqueIssue(issues, issue) {
  const key = `${issue.viewport}:${issue.url}:${issue.type}:${issue.message}`;
  if (!issues.some((item) => item.key === key)) issues.push({ key, ...issue });
}

function fixPrompt(issues) {
  if (!issues.length) return null;
  const lines = issues.slice(0, 40).map((issue) =>
    `- [${issue.viewport}] ${issue.url}: ${issue.type} — ${issue.message}`);
  return `Automated browser testing found the following user-facing issues. Fix their root causes while preserving working behavior and design. Re-run the build and ensure desktop and mobile still work.\n\n${lines.join("\n")}`;
}

export async function runQaBrowser({ previewUrl, runId, artifactRoot = process.env.QA_ARTIFACT_DIR || path.join(os.homedir(), "buildr-qa") }) {
  const preview = new URL(previewUrl);
  if (!['http:', 'https:'].includes(preview.protocol)) throw new Error("Unsupported preview URL.");
  const artifactDir = path.join(artifactRoot, runId);
  await mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const issues = [];
  const checks = [];
  const screenshots = [];
  const discovered = new Set([new URL("/", preview).href]);
  const dnsCache = new Map();

  try {
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, ignoreHTTPSErrors: false });
      await context.route("**/*", async (route) => {
        const allowed = await safeBrowserUrl(route.request().url(), preview.origin, dnsCache);
        return allowed ? route.continue() : route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") uniqueIssue(issues, {
          viewport: viewport.name, url: page.url(), type: "console_error", severity: "error", message: message.text().slice(0, 500),
        });
      });
      page.on("pageerror", (error) => uniqueIssue(issues, {
        viewport: viewport.name, url: page.url(), type: "runtime_error", severity: "error", message: String(error.message || error).slice(0, 500),
      }));
      page.on("response", (response) => {
        if (response.status() >= 400 && response.url().startsWith(preview.origin)) uniqueIssue(issues, {
          viewport: viewport.name, url: page.url(), type: "failed_request", severity: "error",
          message: `${response.status()} ${new URL(response.url()).pathname}`,
        });
      });

      const routes = viewport.name === "desktop" ? discovered : new Set(discovered);
      for (const routeUrl of routes) {
        if (checks.filter((check) => check.viewport === viewport.name).length >= MAX_ROUTES) break;
        try {
          const response = await page.goto(routeUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.waitForTimeout(500);
          const audit = await page.evaluate(() => ({
            title: document.title,
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
            brokenImages: [...document.images].filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.currentSrc || img.src).slice(0, 10),
            largeAbsolutePanels: [...document.querySelectorAll("body *")].filter((el) => {
              const style = getComputedStyle(el);
              if (style.position !== "absolute" || style.display === "none" || style.visibility === "hidden") return false;
              const rect = el.getBoundingClientRect();
              const meaningfulContent = String(el.textContent || "").trim().length >= 12 || !!el.querySelector("button,input,select,textarea,a[href]");
              return meaningfulContent && rect.width > window.innerWidth * 0.65 && rect.height > window.innerHeight * 0.25;
            }).map((el) => ({
              tag: el.tagName.toLowerCase(),
              text: String(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
            })).slice(0, 5),
            unlabeledControls: [...document.querySelectorAll("button,input,select,textarea,a[href]")]
              .filter((el) => {
                if (el.matches('input[type="hidden"]')) return false;
                const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent?.trim() || el.getAttribute("placeholder") || el.getAttribute("alt");
                return !label;
              }).length,
            links: [...document.querySelectorAll("a[href]")].map((a) => a.href),
          }));
          const pathname = new URL(routeUrl).pathname;
          checks.push({ viewport: viewport.name, url: pathname, ok: true, status: response?.status() || null, title: audit.title });
          if (audit.horizontalOverflow) uniqueIssue(issues, { viewport: viewport.name, url: pathname, type: "horizontal_overflow", severity: "warning", message: "Page is wider than the viewport." });
          if (viewport.name === "mobile" && audit.largeAbsolutePanels.length) {
            uniqueIssue(issues, {
              viewport: viewport.name, url: pathname, type: "mobile_content_overlap", severity: "warning",
              message: `${audit.largeAbsolutePanels.length} large panel(s) remain absolutely positioned at phone width and can collide with nearby content. Return them to normal document flow below the responsive breakpoint.`,
            });
          }
          for (const image of audit.brokenImages) uniqueIssue(issues, { viewport: viewport.name, url: pathname, type: "broken_image", severity: "warning", message: image.slice(0, 500) });
          if (audit.unlabeledControls) uniqueIssue(issues, { viewport: viewport.name, url: pathname, type: "accessibility", severity: "warning", message: `${audit.unlabeledControls} interactive control(s) have no accessible name.` });

          if (viewport.name === "desktop") {
            for (const link of audit.links) {
              try {
                const next = new URL(link);
                next.hash = "";
                if (next.origin === preview.origin && discovered.size < MAX_ROUTES) discovered.add(next.href);
              } catch {}
            }
          }
          const screenshotName = `${viewport.name}-${String(checks.length).padStart(2, "0")}.jpg`;
          await page.screenshot({ path: path.join(artifactDir, screenshotName), type: "jpeg", quality: 65, fullPage: true });
          screenshots.push({ viewport: viewport.name, url: pathname, file: screenshotName });
        } catch (error) {
          const pathname = (() => { try { return new URL(routeUrl).pathname; } catch { return routeUrl; } })();
          checks.push({ viewport: viewport.name, url: pathname, ok: false });
          uniqueIssue(issues, { viewport: viewport.name, url: pathname, type: "navigation_failure", severity: "error", message: String(error.message || error).slice(0, 500) });
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const cleanIssues = issues.map(({ key, ...issue }) => issue);
  return {
    checks,
    issues: cleanIssues,
    screenshots,
    passedCount: checks.filter((check) => check.ok).length,
    issueCount: cleanIssues.length,
    fixPrompt: fixPrompt(cleanIssues),
  };
}
