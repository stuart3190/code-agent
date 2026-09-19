import crypto from "node:crypto";
import { serviceClient } from "../supabase.mjs";
import { customerCredits } from "../customerCredits.mjs";

export function buildRequestHash(input) {
  return crypto.createHash("sha256").update(JSON.stringify({
    description: String(input?.description || ""),
    productName: input?.productName == null ? null : String(input.productName),
  })).digest("hex");
}

function publicApproval(row, credits = null) {
  return {
    approvalId: row.id,
    conversationId: row.conversation_id,
    requestSummary: row.request_summary,
    complexity: row.complexity,
    ceilingCredits: Number(row.ceiling_credits),
    availableCredits: credits ? {
      included: Number(credits.includedRemaining ?? credits.included ?? credits.bundle ?? 0),
      purchased: Number(credits.purchasedRemaining ?? credits.purchased ?? credits.topup ?? 0),
      total: Number(credits.totalAvailable ?? credits.total ?? 0),
    } : undefined,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function publicBuild(row) {
  if (!row) return null;
  return {
    jobId: row.id,
    projectId: row.project_id,
    status: row.status,
    phase: row.phase,
    error: row.error || null,
    stopReason: row.stop_reason || null,
    pipelineVersion: row.pipeline_version,
    workJobId: row.work_job_id || null,
  };
}

export function buildBudgetApprovals({
  client = serviceClient(),
  balanceResolver = (owner) => customerCredits(owner, { client }),
  now = () => new Date(),
} = {}) {
  const assert = (result, action) => {
    if (result.error) throw Object.assign(new Error(`${action}: ${result.error.message}`), { code: result.error.code });
    return result.data;
  };
  const expireIfNeeded = async (row) => {
    if (["pending", "approved"].includes(row?.status) && new Date(row.expires_at).getTime() <= now().getTime()) {
      const data = assert(await client.from("bv2_build_budget_approvals")
        .update({ status: "expired", resolved_at: now().toISOString() })
        .eq("id", row.id).eq("owner", row.owner).in("status", ["pending", "approved"])
        .select("*").maybeSingle(), "expire build budget approval");
      return data || { ...row, status: "expired" };
    }
    return row;
  };
  return {
    async create(owner, conversationId, input, { ceilingCredits }) {
      const requestHash = buildRequestHash(input);
      const existing = assert(await client.from("bv2_build_budget_approvals").select("*")
        .eq("owner", owner).eq("conversation_id", conversationId).eq("request_hash", requestHash)
        .eq("status", "pending").maybeSingle(), "read build budget approval");
      const current = await expireIfNeeded(existing);
      let row = current?.status === "pending" ? current : null;
      if (!row) {
        const expiresAt = new Date(now().getTime() + 24 * 60 * 60_000).toISOString();
        const created = await client.from("bv2_build_budget_approvals").insert({
          owner,
          conversation_id: conversationId,
          request_hash: requestHash,
          request_summary: String(input.description).trim().slice(0, 500),
          request_payload: { description: String(input.description), productName: input.productName || null },
          complexity: "advanced",
          ceiling_credits: ceilingCredits,
          expires_at: expiresAt,
        }).select("*").single();
        if (created.error?.code === "23505") {
          row = assert(await client.from("bv2_build_budget_approvals").select("*")
            .eq("owner", owner).eq("conversation_id", conversationId).eq("request_hash", requestHash)
            .eq("status", "pending").maybeSingle(), "read concurrent build budget approval");
        } else {
          row = assert(created, "create build budget approval");
        }
      }
      return publicApproval(row, await balanceResolver(owner));
    },
    async get(owner, id) {
      let row = assert(await client.from("bv2_build_budget_approvals").select("*")
        .eq("owner", owner).eq("id", id).maybeSingle(), "read build budget approval");
      row = await expireIfNeeded(row);
      return row ? { ...publicApproval(row, await balanceResolver(owner)), requestPayload: row.request_payload } : null;
    },
    async resolve(owner, id, action) {
      if (!['approve', 'decline'].includes(action)) throw new Error("invalid build budget approval action");
      const current = await this.get(owner, id);
      if (!current) return null;
      if (current.status !== "pending") return { ...current, decisionChanged: false };
      const row = assert(await client.from("bv2_build_budget_approvals").update({
        status: action === "approve" ? "approved" : "declined",
        approved_by: action === "approve" ? owner : null,
        resolved_at: now().toISOString(),
      }).eq("owner", owner).eq("id", id).eq("status", "pending").select("*").maybeSingle(),
      "resolve build budget approval");
      if (!row) return { ...(await this.get(owner, id)), decisionChanged: false };
      return {
        ...publicApproval(row, await balanceResolver(owner)), requestPayload: row.request_payload,
        decisionChanged: true,
      };
    },
    async consume(owner, id, { conversationId, input }) {
      const row = assert(await client.from("bv2_build_budget_approvals").update({
        status: "consumed", consumed_at: now().toISOString(),
      }).eq("owner", owner).eq("id", id).eq("conversation_id", conversationId)
        .eq("request_hash", buildRequestHash(input)).eq("status", "approved")
        .gt("expires_at", now().toISOString()).select("*").maybeSingle(), "consume build budget approval");
      if (!row) throw Object.assign(new Error("This large-build approval is unavailable, expired, or does not match the request."), {
        code: "build_budget_approval_required", status: 409,
      });
      return publicApproval(row, await balanceResolver(owner));
    },
    async reopen(owner, id) {
      const row = assert(await client.from("bv2_build_budget_approvals").update({
        status: "approved", consumed_at: null,
      }).eq("owner", owner).eq("id", id).eq("status", "consumed")
        .select("*").maybeSingle(), "reopen build budget approval");
      if (!row) throw Object.assign(new Error("Consumed build budget approval could not be reopened."), {
        code: "build_budget_approval_reopen_failed",
      });
      return { ...publicApproval(row, await balanceResolver(owner)), requestPayload: row.request_payload };
    },
    async attachDispatch(owner, id, { projectId, jobId }) {
      const row = assert(await client.from("bv2_build_budget_approvals").update({
        dispatch_project_id: projectId,
        dispatch_job_id: jobId,
      }).eq("owner", owner).eq("id", id).eq("status", "consumed")
        .is("dispatch_job_id", null).select("*").maybeSingle(), "attach build budget approval dispatch");
      if (row) return publicApproval(row, await balanceResolver(owner));
      const current = assert(await client.from("bv2_build_budget_approvals").select("*")
        .eq("owner", owner).eq("id", id).maybeSingle(), "read attached build budget approval");
      if (current?.status === "consumed" && String(current.dispatch_project_id) === String(projectId)
          && String(current.dispatch_job_id) === String(jobId)) {
        return publicApproval(current, await balanceResolver(owner));
      }
      throw Object.assign(new Error("Consumed build approval could not be attached to its durable job."), {
        code: "build_budget_approval_attach_failed",
      });
    },
    async getDispatch(owner, id) {
      const approval = await this.get(owner, id);
      if (!approval) return null;
      const job = assert(await client.from("build_jobs")
        .select("id,project_id,status,phase,error,stop_reason,pipeline_version,work_job_id,created_at")
        .eq("owner", owner).eq("budget_approval_id", id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      "read approved build dispatch");
      return { approval, build: publicBuild(job) };
    },
  };
}

export async function reconcileConsumedBuildBudgetApprovals({
  client = serviceClient(), now = Date.now(), graceMs = 10 * 60_000,
} = {}) {
  const { data, error } = await client.rpc("reconcile_bv2_build_budget_approvals", {
    p_older_than: new Date(now - Math.max(graceMs, 60_000)).toISOString(),
  });
  if (error) throw new Error(`reconcile consumed build budget approvals: ${error.message}`);
  return data || [];
}

let reconcileTimer = null;
export function startBuildBudgetApprovalReconciler() {
  if (reconcileTimer || process.env.CODE_AGENT_STORE !== "supabase") return;
  const tick = () => reconcileConsumedBuildBudgetApprovals()
    .then((rows) => { if (rows.length) console.warn(`[build-approvals] reopened ${rows.length} orphaned approvals`); })
    .catch((error) => console.error(`[build-approvals] reconciliation failed: ${error.message}`));
  reconcileTimer = setInterval(tick, 5 * 60_000);
  reconcileTimer.unref?.();
  tick();
}

export function stopBuildBudgetApprovalReconciler() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}
