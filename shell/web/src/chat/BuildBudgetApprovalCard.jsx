import React, { useEffect, useState } from "react";
import {
  approveBuildBudget,
  declineBuildBudget,
  getBuildBudgetApproval,
} from "../lib/codeAgentApi.js";

const TERMINAL = new Set(["declined", "expired", "consumed", "cancelled"]);

const credits = (value) => {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

const statusCopy = (status) => ({
  approved: "Approved — the build is ready to start.",
  consumed: "Approved — the build has started.",
  declined: "Declined — no build or model work was started.",
  expired: "This approval expired. No build or model work was started.",
  cancelled: "This request was cancelled.",
})[status] || null;

function unwrap(result, fallbackStatus = null) {
  const value = result?.approval || result || {};
  const merged = {
    ...value,
    ...(Object.hasOwn(result || {}, "build") ? { build: result.build } : {}),
    ...(Object.hasOwn(result || {}, "resuming") ? { resuming: !!result.resuming } : {}),
  };
  return fallbackStatus && !merged.status ? { ...merged, status: fallbackStatus } : merged;
}

export default function BuildBudgetApprovalCard({ approval, onBuildAccepted = null }) {
  const [current, setCurrent] = useState(approval || {});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { setCurrent(approval || {}); }, [approval]);

  // The durable resolved event is the replay authority. This read closes the small race where the
  // browser reconnects after the database decision but before that event reaches this stream. A
  // consumed approval with no attached job is a concurrent dispatch in progress, so poll that
  // narrow state until its durable build appears or reconciliation reopens the approval.
  useEffect(() => {
    const id = current?.approvalId;
    const currentStatus = String(current?.status || "pending").toLowerCase();
    if (!id || (TERMINAL.has(currentStatus) && !current?.resuming)) return undefined;
    let live = true;
    let timer = null;
    const refresh = async () => {
      try {
        const result = await getBuildBudgetApproval(id);
        if (!live) return;
        const next = unwrap(result);
        setCurrent((value) => ({ ...value, ...next }));
        if (next.build?.jobId) onBuildAccepted?.(next.build);
        if (next.resuming) timer = setTimeout(refresh, 1_500);
      } catch {
        // The SSE replay remains authoritative; a read interruption is not a decision failure.
      }
    };
    void refresh();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [current?.approvalId, current?.status, current?.resuming, onBuildAccepted]);

  const decide = async (decision) => {
    if (!current.approvalId || busy) return;
    setBusy(decision); setError("");
    try {
      const result = decision === "approve"
        ? await approveBuildBudget(current.approvalId)
        : await declineBuildBudget(current.approvalId);
      setCurrent((value) => ({
        ...value,
        ...unwrap(result, decision === "approve" ? "approved" : "declined"),
        resumeError: null,
        resumeErrorCode: null,
      }));
      if (result?.build?.jobId) onBuildAccepted?.(result.build);
    } catch (requestError) {
      setError(requestError?.message || "That decision did not go through. Nothing was started.");
    } finally {
      setBusy("");
    }
  };

  const status = String(current.status || "pending").toLowerCase();
  const pending = status === "pending";
  const retryStart = status === "approved" && !current.resuming && !current.build;
  const available = current.availableCredits || {};
  const expires = current.expiresAt ? new Date(current.expiresAt) : null;
  const expiry = expires && Number.isFinite(expires.getTime())
    ? expires.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;

  return (
    <div className="ct-msg lead">
      <section className="ct-card ct-budget-approval" aria-label="Large build approval">
        <div className="ct-kicker">
          <span className="ct-kdot" style={{ background: "var(--warn)" }} />Large build approval
        </div>
        <h3>{current.requestSummary || current.summary || "This request needs a larger build budget"}</h3>
        <p className="ct-hint">
          Thrallo classified this as {String(current.complexity || "advanced").toLowerCase()} work.
          Approving sets a ceiling, not an automatic charge; unused reserved credits are released.
        </p>
        <div className="ct-budget-facts">
          <div><b>{credits(current.ceilingCredits)}</b><span>Maximum credits</span></div>
          <div><b>{credits(available.included)}</b><span>Included available</span></div>
          <div><b>{credits(available.purchased)}</b><span>Additional available</span></div>
        </div>
        {expiry && (pending || retryStart) && <div className="ct-hint">Approval expires {expiry}.</div>}
        {current.resuming
          ? <div className="ct-budget-result" role="status">Approved — starting the build…</div>
          : statusCopy(status) && <div className="ct-budget-result" role="status">{statusCopy(status)}</div>}
        {current.resumeError && <div className="mg-error" role="alert">{current.resumeError}</div>}
        {error && !current.resumeError && <div className="mg-error" role="alert">{error}</div>}
        {(pending || retryStart) && (
          <div className="ct-actions ct-budget-actions">
            <button className="ct-btn" disabled={!!busy || !current.approvalId}
              onClick={() => decide("approve")}>
              {busy === "approve" ? (retryStart ? "Starting…" : "Approving…")
                : retryStart ? "Retry starting approved build"
                  : `Approve up to ${credits(current.ceilingCredits)} credits`}
            </button>
            {pending && (
              <button className="ct-btn-quiet" disabled={!!busy || !current.approvalId}
                onClick={() => decide("decline")}>
                {busy === "decline" ? "Declining…" : "Decline"}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
