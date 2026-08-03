// The script injected into every published site.
//
// Constraints it must never violate, because it runs on someone else's app in front of their
// customers: it must not block rendering, must not throw into their page, must not retain
// anything on the device, and must not slow the site down measurably. Everything below follows
// from that — no dependencies, no cookies, no localStorage, sendBeacon over fetch, and every
// listener wrapped so a failure here can never surface as a failure of their app.
//
// Served from Thrallo and injected at publish time, so a site's analytics cannot silently rot
// against a newer ingest format.

export const ANALYTICS_SCRIPT_PATH = "/_thrallo/a.js";

export function analyticsScript({ endpoint, appId }) {
  // Written as one small IIFE. Kept readable rather than minified by hand: it gzips to well under
  // a kilobyte, and a script nobody can read is a script nobody can audit.
  return `(function(){
"use strict";
var E=${JSON.stringify(endpoint)},A=${JSON.stringify(appId)};
// text/plain, deliberately: it is a CORS-safelisted content type, so this cross-origin beacon
// makes no preflight request. With application/json every beacon would trigger an OPTIONS the
// browser then blocks, and analytics would silently record nothing. The server parses the body
// as JSON regardless of the declared type.
function send(d){try{d.appId=A;d.path=location.pathname;d.host=location.hostname;
var b=JSON.stringify(d);
if(navigator.sendBeacon){navigator.sendBeacon(E,new Blob([b],{type:"text/plain;charset=UTF-8"}));return;}
fetch(E,{method:"POST",body:b,headers:{"Content-Type":"text/plain;charset=UTF-8"},keepalive:true,mode:"no-cors"}).catch(function(){});}catch(e){}}

// Page view, including single-page-app navigations: a router change is a page view to the person
// looking at it, and most published Thrallo apps are SPAs.
var last="";
function view(){try{if(location.pathname===last)return;last=location.pathname;
var t=0;try{var n=performance.getEntriesByType("navigation")[0];if(n&&n.duration)t=Math.round(n.duration);}catch(e){}
send({kind:"pageview",referrer:document.referrer,loadMs:t});}catch(e){}}
if(document.readyState==="complete")view();else addEventListener("load",view,{once:true});
["pushState","replaceState"].forEach(function(m){var o=history[m];if(!o)return;history[m]=function(){var r=o.apply(this,arguments);setTimeout(view,0);return r;};});
addEventListener("popstate",function(){setTimeout(view,0);});

// Core Web Vitals. Reported once, on the way out, so nothing is measured twice and the beacon
// never competes with the page for bandwidth while it is loading.
var V={},seen=false;
function obs(type,fn){try{var o=new PerformanceObserver(function(l){l.getEntries().forEach(fn);});o.observe({type:type,buffered:true});return o;}catch(e){return null;}}
obs("largest-contentful-paint",function(e){V.lcp=Math.round(e.startTime);});
obs("paint",function(e){if(e.name==="first-contentful-paint")V.fcp=Math.round(e.startTime);});
obs("layout-shift",function(e){if(!e.hadRecentInput)V.cls=(V.cls||0)+e.value;});
obs("event",function(e){if(e.interactionId){var d=Math.round(e.duration);if(!V.inp||d>V.inp)V.inp=d;}});
try{var nav=performance.getEntriesByType("navigation")[0];if(nav)V.ttfb=Math.round(nav.responseStart);}catch(e){}
function flush(){if(seen)return;seen=true;
if(V.lcp||V.fcp||V.inp||V.ttfb||V.cls)send({kind:"vitals",lcp:V.lcp,fcp:V.fcp,inp:V.inp,ttfb:V.ttfb,cls:V.cls});}
addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")flush();});
addEventListener("pagehide",flush);

// Errors. Reported, never swallowed — the site's own handlers still run.
addEventListener("error",function(e){try{
if(e.target&&e.target!==window&&(e.target.src||e.target.href)){
send({kind:"error",message:"Failed to load resource",source:String(e.target.src||e.target.href).slice(0,300)});return;}
send({kind:"error",message:(e.message||"Error"),source:(e.filename||"")+":"+(e.lineno||0),stack:e.error&&e.error.stack?String(e.error.stack):null});}catch(x){}},true);
addEventListener("unhandledrejection",function(e){try{
var r=e.reason;send({kind:"error",message:(r&&r.message?r.message:String(r)).slice(0,500),stack:r&&r.stack?String(r.stack):null});}catch(x){}});

// Failed API requests. Wrapped rather than replaced: the original is always called and its result
// always returned unchanged, so a site behaves identically whether or not this is present. Only
// the app's own requests are reported — beaconing about third-party calls would leak where the
// site talks to, and would report failures its owner cannot fix.
try{var of=window.fetch;if(of){window.fetch=function(){var a=arguments,u="";
try{u=String(a[0]&&a[0].url?a[0].url:a[0]||"");}catch(e){}
var m="GET";try{m=(a[1]&&a[1].method)||(a[0]&&a[0].method)||"GET";}catch(e){}
return of.apply(this,a).then(function(r){try{
if(r&&r.status>=400&&u&&new URL(u,location.href).origin===location.origin)
send({kind:"error",message:"Request failed",requestUrl:new URL(u,location.href).pathname,requestMethod:String(m).toUpperCase(),status:r.status});}catch(e){}
return r;},function(err){try{
if(u&&new URL(u,location.href).origin===location.origin)
send({kind:"error",message:"Request failed",requestUrl:new URL(u,location.href).pathname,requestMethod:String(m).toUpperCase()});}catch(e){}
throw err;});};}}catch(e){}
})();`;
}

// The tag placed in the published HTML. `defer` rather than `async` so it never competes with the
// page's own resources, and it carries no inline code so a strict Content-Security-Policy on the
// published site does not need to allow inline scripts.
export function analyticsTag() {
  return `<script defer src="${ANALYTICS_SCRIPT_PATH}"></script>`;
}

// Injected before </head>, or before </body> if there is no head. Idempotent: republishing a tree
// that already carries the tag must not accumulate copies.
export function injectAnalytics(html, tag = analyticsTag()) {
  if (typeof html !== "string" || html.includes(ANALYTICS_SCRIPT_PATH)) return html;
  if (html.includes("</head>")) return html.replace("</head>", `  ${tag}\n</head>`);
  if (html.includes("</body>")) return html.replace("</body>", `  ${tag}\n</body>`);
  return html;
}
