// Settings → Usage.
//
// What the plan includes, what has been used, what is left, and when it resets — the four things
// someone opens this page to find out, above anything else.
//
// Every number here comes from the server's `budgetOverview`. Nothing is estimated: where Thrallo
// does not meter something, this page says so rather than showing a plausible figure. There is no
// storage meter anywhere in the product, so storage is reported as what the account HOLDS
// (projects, live sites, deployments) and is not dressed up as an allowance with a limit.

import React, { Suspense, lazy, useState } from "react";
import { Meter, formatCompute, formatCount, formatTokens } from "./meters.jsx";
import { formatBillingDate } from "../billing/planState.js";
import { SkeletonRows } from "../manage/shared.jsx";

// Spend guards and per-request accounting: real, and rarely wanted. Split out so opening Settings
// does not download them.
const UsageDetail = lazy(() => import("./UsageDetail.jsx"));

const RETENTION_TEXT = (days) => (days === null ? "kept indefinitely" : `${days} days`);

export default function UsageTab({ data, onUpgrade, onOpenTab, onChanged, showToast }) {
  const [detail, setDetail] = useState(false);
  const { plan, budgets, period, capabilities, counts, unlimited, ownerAccount, pastDue } = data;
  const resets = formatBillingDate(period?.end);
  const anyAtLimit = !unlimited && Object.values(budgets || {}).some((b) => b.remaining <= 0);

  return (
    <div className="st-tab">
      <div className="st-headline">
        <div>
          <div className="st-headline-plan">{plan.name} plan</div>
          <div className="ct-hint">
            {resets ? <>This period ends {resets}, when every allowance below resets.</> : "Allowances reset monthly."}
          </div>
        </div>
        {plan.id === "free" && <button className="ct-btn" onClick={onUpgrade}>See plans</button>}
      </div>

      {pastDue && (
        <div className="st-notice tone-warn">
          <strong>We could not take your last payment.</strong> Your allowances are metered at Free
          limits until it succeeds. Update your card under Billing.
          <button className="ct-linkish" onClick={() => onOpenTab("billing")}>Go to Billing</button>
        </div>
      )}
      {ownerAccount && (
        <div className="st-notice">
          This is an owner account. Usage is recorded exactly as it is for customers, and nothing
          here is ever enforced against you.
        </div>
      )}
      {anyAtLimit && !pastDue && (
        <div className="st-notice tone-bad">
          <strong>An allowance is used up.</strong> New work pauses until {resets || "the period resets"}
          {plan.id === "pro" ? "." : " or the plan changes."}
          {plan.id !== "pro" && <button className="ct-linkish" onClick={onUpgrade}>See plans</button>}
        </div>
      )}

      <div className="st-section">
        <h3>This period</h3>
        <div className="st-meters">
          <Meter label="Builds" used={budgets.runs.used} limit={budgets.runs.limit}
            unlimited={unlimited} format={formatCount}
            hint={`${formatCount(plan.monthly.runs)} included`} />
          <Meter label="Managed AI tokens" used={budgets.managedTokens.used} limit={budgets.managedTokens.limit}
            unlimited={unlimited} format={formatTokens}
            hint="Your own key and Codex do not count" />
          <Meter label="Sandbox compute" used={budgets.computeSeconds.used} limit={budgets.computeSeconds.limit}
            unlimited={unlimited} format={formatCompute}
            hint={`${formatCompute(plan.monthly.computeSeconds)} included`} />
        </div>
        {/* Said once, plainly, rather than being something a customer has to deduce from a token
            meter that stops moving when they connect their own key. */}
        <p className="ct-hint st-note">
          Builds and sandbox compute are metered on every run, because Thrallo pays for the sandbox
          either way. Managed AI tokens are metered only when a run uses Thrallo's models.
        </p>
      </div>

      <div className="st-section">
        <h3>What this account holds</h3>
        {counts ? (
          <div className="st-facts">
            <div className="st-fact"><b>{formatCount(counts.projects)}</b><span>Projects</span></div>
            <div className="st-fact"><b>{formatCount(counts.liveSites)}</b><span>Live sites</span></div>
            <div className="st-fact"><b>{formatCount(counts.deployments)}</b><span>Deployments</span></div>
          </div>
        ) : (
          <div className="ct-hint">These counts are temporarily unavailable.</div>
        )}
        {/* Storage is deliberately absent. Thrallo measures no bytes and limits none, and a number
            here would be read as metered simply for sitting beside three that are. */}
        <p className="ct-hint st-note">
          Projects, sites and deployments are not capped, and Thrallo does not meter storage.
        </p>
      </div>

      <div className="st-section">
        <h3>Included with {plan.name}</h3>
        <ul className="st-includes">
          <li>
            <span>Analytics history</span>
            <b>{RETENTION_TEXT(capabilities.retentionDays)}</b>
          </li>
          <li><span>Error reporting</span><b>{capabilities.errorReporting ? "Included" : "Starter and above"}</b></li>
          <li><span>Build history</span><b>{capabilities.buildHistory ? "Included" : "Starter and above"}</b></li>
          <li><span>Analytics export</span><b>{capabilities.export ? "Included" : "Pro"}</b></li>
          <li><span>Custom domains per project</span><b>{capabilities.multiDomain ? "Several" : "One"}</b></li>
        </ul>
      </div>

      <div className="st-section">
        <button className="st-disclosure" aria-expanded={detail} onClick={() => setDetail((v) => !v)}>
          <span>
            Spend guards and detailed usage
            <span className="ct-hint">Your own caps, per-request AI accounting, raw run records</span>
          </span>
          <span className="ct-hint">{detail ? "Hide" : "Show"}</span>
        </button>
        {detail && (
          <Suspense fallback={<SkeletonRows rows={2} />}>
            <UsageDetail subscription={data.subscription} onChanged={onChanged} showToast={showToast} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
