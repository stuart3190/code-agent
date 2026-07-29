// POST /api/android { projectId, tree } -> application/zip (signed APK + AAB + keystore + README)
//
// Wraps the project's PUBLISHED PWA into a signed Android app (TWA) via the buildr-android Docker
// image. Precondition: the project must already be published (needs a live https origin + slug),
// which also makes this implicitly paid-tier-only. Long single POST — Caddy has no proxy timeout
// on the shell route (flush_interval -1); publish already proves multi-minute POSTs survive.

import { serviceClient } from "../lib/supabase.mjs";
import { publishedSlug } from "./publish.mjs";
import { buildAndroid } from "../lib/android.mjs";

function safeContentDisposition(filename) {
  const fallback = "buildr101-android.zip";
  const safe = String(filename || fallback).replace(/[^a-zA-Z0-9._-]/g, "-") || fallback;
  return `attachment; filename="${safe}"`;
}

export async function handleAndroid(req, res, body, owner) {
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const tree = body?.tree;
  if (!projectId || !tree || typeof tree !== "object") {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId and tree are required" }));
  }
  try {
    // Ownership + must-be-published precondition (also gives the origin slug).
    const { data: proj } = await serviceClient()
      .from("projects").select("name, owner").eq("id", projectId).maybeSingle();
    if (!proj || proj.owner !== owner.id) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "project not found" }));
    }
    const slug = await publishedSlug(projectId);
    if (!slug) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Publish your app first — the Android app wraps your live site.", code: "not_published" }));
    }

    const { zip, filename } = await buildAndroid({
      owner, projectId, slug, tree, appName: proj.name, log: console.log,
    });

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": safeContentDisposition(filename),
      "Cache-Control": "no-store",
    });
    res.end(zip);
  } catch (e) {
    const status = e.code === "upgrade_required" ? 402 : e.code === "build_failed" ? 422 : 500;
    console.error(`[android] ${e?.stack || e}`); // never the keystore password
    res.writeHead(status, { "Content-Type": "application/json" });
    const message = e.code === "build_failed" ? "Android build failed — try again."
      : status === 402 ? e.message : "Android export failed. Please try again.";
    res.end(JSON.stringify({ error: message }));
  }
}
