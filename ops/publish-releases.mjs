#!/usr/bin/env node
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import {
  activateRetainedRelease, adoptLegacyPublishedSite, publisherPauseFile, reconcilePendingActivations, sweepPublishReleaseRetention,
  verifyRetainedRelease,
} from "../shell/server/lib/publishing/atomicPublisher.mjs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const [command = "list", ...args] = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : null; };
const client = serviceClient();

async function list() {
  let query = client.from("publish_releases").select("id,owner,project_id,site_id,artifact_hash,artifact_path,health_state,activation_state,rollback_eligible,created_at,activated_at")
    .order("created_at", { ascending: false }).limit(Number(value("limit") || 50));
  if (value("project")) query = query.eq("project_id", value("project"));
  const { data, error } = await query; if (error) throw error; return data;
}

async function state() {
  const { data, error } = await client.from("publish_activation_intents").select("*")
    .in("state", ["prepared", "pointer_switched", "retrying", "stuck"]).order("created_at");
  if (error) throw error; return data;
}

let result;
if (command === "list") result = await list();
else if (command === "state" || command === "stuck") result = await state();
else if (command === "pause") {
  await mkdir(path.dirname(publisherPauseFile()), { recursive: true });
  await writeFile(publisherPauseFile(), `${new Date().toISOString()} ${process.pid}\n`, { flag: "w", mode: 0o600 });
  result = { paused: true, file: publisherPauseFile() };
} else if (command === "resume") {
  await rm(publisherPauseFile(), { force: true }); result = { paused: false, file: publisherPauseFile() };
}
else if (command === "reconcile") result = await reconcilePendingActivations({ client, limit: Number(value("limit") || 10) });
else if (command === "drain") {
  const rounds = [];
  for (let i = 0; i < 100; i += 1) {
    const round = await reconcilePendingActivations({ client, limit: 25 }); rounds.push(round);
    if (!round.leased) break;
  }
  result = { rounds };
} else if (command === "retention") result = await sweepPublishReleaseRetention({ client });
else if (command === "integrity") {
  if (!value("owner") || !value("release")) throw new Error("--owner and --release required");
  result = await verifyRetainedRelease({ owner: value("owner"), releaseId: value("release"), client });
}
else if (command === "adopt-legacy") {
  if (!value("owner") || !value("project")) throw new Error("--owner and --project required");
  result = await adoptLegacyPublishedSite({ owner: value("owner"), projectId: value("project"), client });
}
else if (command === "activate" || command === "rollback") {
  for (const required of ["owner", "project", "release"]) if (!value(required)) throw new Error(`--${required} required`);
  result = await activateRetainedRelease({ owner: value("owner"), projectId: value("project"),
    releaseId: value("release"), activationDeploymentId: value("deployment"), client });
} else throw new Error(`unknown command ${command}`);

console.log(JSON.stringify(result, null, 2));
