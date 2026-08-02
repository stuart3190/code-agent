// Browser, OS and device from a user agent string.
//
// Deliberately a small table rather than a dependency: this runs on every page view of every
// published site, the answers only need to be good enough to group by, and a UA parser is a
// surprisingly large amount of code to take on for that.
//
// Nothing here is stored against a person — these become dimension keys on daily rollups.

const BROWSERS = [
  [/\bEdg(?:e|A|iOS)?\//i, "Edge"],
  [/\bOPR\/|\bOpera\b/i, "Opera"],
  [/\bSamsungBrowser\//i, "Samsung Internet"],
  // Chrome must come after the Chromium-based browsers above, all of which also say "Chrome".
  [/\bChrome\/|\bCriOS\//i, "Chrome"],
  [/\bFirefox\/|\bFxiOS\//i, "Firefox"],
  // Safari says "Safari" too, so it is only Safari once everything else has been ruled out.
  [/\bSafari\//i, "Safari"],
];

const SYSTEMS = [
  [/\bWindows NT\b/i, "Windows"],
  [/\b(iPhone|iPad|iPod)\b/i, "iOS"],
  [/\bMac OS X\b/i, "macOS"],
  [/\bAndroid\b/i, "Android"],
  [/\bCrOS\b/i, "ChromeOS"],
  [/\bLinux\b/i, "Linux"],
];

// Bots are excluded from analytics entirely. Counting them would make every number a lie, and the
// owner cannot act on them.
const BOT = /bot|crawler|spider|crawling|slurp|bingpreview|headlesschrome|lighthouse|pingdom|uptimerobot|curl\/|wget\/|python-requests|go-http-client|axios\//i;

export function isBot(userAgent) {
  return BOT.test(String(userAgent || ""));
}

export function parseUserAgent(userAgent) {
  const ua = String(userAgent || "");
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] || "Other";
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] || "Other";
  const tablet = /\biPad\b/i.test(ua) || (/\bAndroid\b/i.test(ua) && !/\bMobile\b/i.test(ua));
  const mobile = /\bMobi|\biPhone\b|\biPod\b/i.test(ua);
  return { browser, os, device: tablet ? "tablet" : mobile ? "mobile" : "desktop" };
}

// Only the host is kept. A full referrer URL can carry search terms, session tokens and private
// paths from the referring site — none of which the owner needs to know where traffic came from.
export function referrerHost(referrer, ownHost) {
  if (!referrer) return "Direct";
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, "");
    if (!host) return "Direct";
    if (ownHost && host === String(ownHost).replace(/^www\./, "")) return null; // internal navigation
    return host;
  } catch {
    return "Direct";
  }
}

// Query strings are dropped: they routinely carry emails, tokens and order references, and a path
// is what "top pages" actually means.
export function normalizePath(rawPath) {
  const path = String(rawPath || "/").split("?")[0].split("#")[0];
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return (trimmed || "/").slice(0, 300);
}
