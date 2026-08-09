// Accessible, theme-aware D9 webview renderer. All content is escaped and all actions are
// sent as typed messages to the extension host; no network-capable code runs in the view.

"use strict";

const { renderPreview, previewStyles } = require("./previewView.js");
const { renderDeployments, deploymentStyles } = require("./deploymentView.js");
const { renderSettings, settingsStyles } = require("./settingsView.js");

function renderDesktopProductHtml(state, { nonce, cspSource = "'self'" } = {}) {
  if (!state || state.source !== "fixture") throw new TypeError("D9 view requires fixture-backed desktop state");
  if (!nonce) throw new TypeError("D9 view requires a CSP nonce");
  const current = state.navigation.current;
  const content = current === "home" ? renderHome(state)
    : current === "projects" ? renderProjects(state)
      : current === "conversation" ? renderConversation(state)
        : current === "agents" ? renderAgents(state)
          : current === "usage" ? renderUsage(state)
            : current === "preview" ? renderPreview(state.preview, escapeHtml, escapeAttribute, humanize)
              : current === "deployments" || current === "domains" ? renderDeployments(state.deployment, escapeHtml, escapeAttribute, humanize)
              : ["settings", "database", "integrations"].includes(current) ? renderSettings(state.settings, current, escapeHtml, escapeAttribute, humanize)
              : renderHome(state);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeAttribute(cspSource)} 'unsafe-inline'; script-src 'nonce-${escapeAttribute(nonce)}'; img-src data: ${escapeAttribute(cspSource)}; frame-src 'self' http://127.0.0.1:* http://localhost:*;">
<style>${styles()}${previewStyles()}${deploymentStyles()}${settingsStyles()}</style></head>
<body><a class="skip-link" href="#main">Skip to Thrallo content</a>
<div class="shell">
  <aside class="sidebar" aria-label="Thrallo navigation">
    <div class="brand" aria-label="Thrallo"><span aria-hidden="true">T</span><strong>Thrallo</strong><small>Desktop</small></div>
    ${renderNavigation(state)}
    <div class="mode-note"><strong>Fixture foundation</strong><span>No production mutations</span></div>
  </aside>
  <div class="workspace">
    ${renderTopbar(state)}
    <main id="main" tabindex="-1">${renderNotices(state.notices)}${content}</main>
  </div>
</div>
<div id="announcer" class="sr-only" aria-live="polite"></div>
<script nonce="${escapeAttribute(nonce)}">${clientScript()}</script></body></html>`;
}

function renderNavigation(state) {
  const primary = state.navigation.items.filter((item) => item.kind === "thrallo");
  const code = state.navigation.items.filter((item) => item.kind === "code_oss");
  const future = state.navigation.items.filter((item) => item.kind === "future");
  return `<nav><div class="nav-group" aria-label="Thrallo">
    ${primary.map((item) => navButton(item, state.navigation.current)).join("")}
  </div><div class="nav-label">Code tools</div><div class="nav-group" aria-label="Code OSS tools">
    ${code.map((item) => navButton(item, state.navigation.current)).join("")}
  </div><details class="future"><summary>More tools</summary><div class="nav-group">
    ${future.map((item) => navButton(item, state.navigation.current)).join("")}
  </div></details></nav>`;
}

function navButton(item, current) {
  const stateText = item.enabled ? "" : `, ${humanize(item.state)}`;
  return `<button class="nav-item${current === item.id ? " active" : ""}" type="button" data-nav="${escapeAttribute(item.id)}" aria-current="${current === item.id ? "page" : "false"}"${item.enabled ? "" : " aria-disabled=\"true\""}>
    <span>${escapeHtml(item.label)}</span>${item.enabled ? "" : `<small>${escapeHtml(stateText.slice(2))}</small>`}
  </button>`;
}

function renderTopbar(state) {
  const identity = state.access.account.identity;
  const account = identity?.displayName || identity?.emailLabel || "Signed out";
  const connection = humanize(state.access.account.session.state);
  return `<header class="topbar"><div><strong>${escapeHtml(sectionTitle(state.navigation.current))}</strong><span>${escapeHtml(state.home.fixtureOnly ? "Deterministic foundation" : "")}</span></div>
    <div class="account" aria-label="Current account and connection"><span class="avatar" aria-hidden="true">${escapeHtml(identity?.avatarLabel || "T")}</span><span><strong>${escapeHtml(account)}</strong><small>${escapeHtml(connection)}</small></span></div>
  </header>`;
}

function renderHome(state) {
  const recent = state.projects.items.filter((item) => item.local).slice(0, 4);
  const fixtures = state.projects.items.filter((item) => item.workspaceType === "fixture_thrallo_project").slice(0, 3);
  return `<section class="hero" aria-labelledby="home-title"><div><p class="eyebrow">Thrallo Desktop</p><h1 id="home-title">${escapeHtml(state.home.headline)}</h1><p>${escapeHtml(state.home.detail)}</p></div>
    <div class="primary-actions" aria-label="Start actions">
      <button class="primary" type="button" data-nav="conversation">Create with Thrallo</button>
      <button type="button" data-host-action="openLocalFolder">Open local folder</button>
      <button type="button" data-host-action="openLocalGit">Open local Git repository</button>
      <button type="button" data-host-action="importLocal">Import local project</button>
    </div></section>
  <div class="home-grid">
    <section class="section-block" aria-labelledby="recent-title"><div class="section-heading"><div><p class="eyebrow">On this computer</p><h2 id="recent-title">Recent local workspaces</h2></div><button class="quiet" type="button" data-nav="projects">View all</button></div>
      ${recent.length ? `<div class="project-list compact">${recent.map(renderProjectRow).join("")}</div>` : emptyState("No recent local workspaces", "Open a folder to start locally. Nothing will be uploaded.")}
    </section>
    <section class="section-block" aria-labelledby="fixture-title"><div class="section-heading"><div><p class="eyebrow">Fixture projects</p><h2 id="fixture-title">Continue with Thrallo</h2></div></div>
      <div class="project-list compact">${fixtures.map(renderProjectRow).join("")}</div>
    </section>
  </div>
  <div class="home-grid lower">
    ${renderRunSummary(state)}
    ${renderUsageSummary(state, true)}
  </div>
  ${renderAccountLinks(state)}`;
}

function renderProjects(state) {
  return `<section aria-labelledby="projects-title"><div class="page-heading"><div><p class="eyebrow">Project launcher</p><h1 id="projects-title">Projects</h1><p>Local projects stay on this computer. Fixture Thrallo projects exercise the desktop without creating canonical projects.</p></div>
    <button type="button" class="primary" data-host-action="openLocalFolder">Open local folder</button></div>
    <div class="filter-note" role="note"><strong>Source is always visible.</strong> Local, imported, fixture, and future cloud workspaces never share an ambiguous launch state.</div>
    <div class="project-list">${state.projects.items.map(renderProjectRow).join("")}</div>
  </section>`;
}

function renderProjectRow(project) {
  const git = project.git?.detected ? `${project.git.branch || "Detached HEAD"}${project.dirty ? " - uncommitted changes" : " - clean"}` : "No Git repository detected";
  const meta = project.local ? `${humanize(project.framework || "unknown")} · ${git}` : `${humanize(project.runState)} · deployment ${humanize(project.deploymentState || "none")}${["degraded", "unhealthy"].includes(project.healthState) ? ` · health ${humanize(project.healthState)}` : ""}`;
  const previewHint = project.local && project.previewCommands?.length ? ` · Preview available: ${project.previewCommands.map((item) => item.command).join(", ")} (not started)` : "";
  const disabled = project.workspaceType === "future_cloud_workspace" || project.availability === "missing_folder" || project.availability === "inaccessible_folder";
  return `<article class="project-row" data-workspace-type="${escapeAttribute(project.workspaceType)}">
    <div class="source-mark" aria-hidden="true">${project.local ? "L" : project.workspaceType === "fixture_thrallo_project" ? "T" : "C"}</div>
    <div class="project-copy"><div><h3>${escapeHtml(project.name)}</h3><span class="state-label">${escapeHtml(project.sourceLabel)}</span></div><p>${escapeHtml(meta)}</p>
      <small>${escapeHtml(project.updatedAt ? `Updated ${formatDate(project.updatedAt)}` : humanize(project.availability))}${project.conflict ? " · Conflict requires review" : ""}${escapeHtml(previewHint)}</small></div>
    <div class="row-actions">${project.dirty ? `<span class="warning-text">Dirty</span>` : ""}${["failed", "degraded", "unhealthy"].includes(project.deploymentState) || ["degraded", "unhealthy"].includes(project.healthState) ? `<span class="warning-text">Deployment warning</span>` : ""}<button type="button" data-preview-project="${escapeAttribute(project.id)}"${disabled ? " disabled" : ""}>Preview</button>${project.workspaceType === "fixture_thrallo_project" ? `<button type="button" data-nav="deployments">Deployments</button>` : ""}<button type="button" data-project="${escapeAttribute(project.id)}"${disabled ? " disabled" : ""}>${project.local ? "Resume" : project.workspaceType === "fixture_thrallo_project" ? "Open fixture" : "Unavailable"}</button></div>
  </article>`;
}

function renderConversation(state) {
  return `<div class="conversation-layout"><section class="conversation" aria-labelledby="conversation-title"><div class="section-heading"><div><p class="eyebrow">Builder conversation</p><h1 id="conversation-title">Build with Thrallo</h1></div><div><button class="quiet" type="button" data-nav="preview">Open Preview</button><span class="fixture-pill">Fixture-backed</span></div></div>
    <div class="messages" role="log" aria-label="Thrallo conversation" aria-live="polite">${state.conversation.messages.map(renderMessage).join("")}</div>
    ${renderPlan(state.plan)}
    <form id="message-form" class="composer"><label for="message">Send a fixture instruction</label><div><textarea id="message" name="message" rows="2" maxlength="4000" placeholder="Describe what you want to change"></textarea><button class="primary" type="submit">Send</button></div><small>Chat messages never approve plans. Use the typed plan controls above.</small></form>
  </section><aside class="activity-rail" aria-label="Current project activity">${renderRunSummary(state)}${renderModelSelector(state)}${renderAgentCompact(state)}</aside></div>`;
}

function renderMessage(item) {
  return `<article class="message ${escapeAttribute(item.role)}" data-state="${escapeAttribute(item.state)}"><header><strong>${escapeHtml(item.role === "user" ? "You" : item.role === "assistant" ? "Thrallo" : "Run update")}</strong><span>${escapeHtml(humanize(item.state))}</span></header><p>${escapeHtml(item.text)}</p></article>`;
}

function renderPlan(plan) {
  const actionable = plan.status === "pending";
  return `<article class="plan-card" aria-labelledby="plan-title"><header><div><p class="eyebrow">Typed plan approval</p><h2 id="plan-title">${escapeHtml(plan.title)}</h2></div><span class="state-label" data-state="${escapeAttribute(plan.status)}">${escapeHtml(humanize(plan.status))}</span></header>
    <p>${escapeHtml(plan.summary)}</p><dl class="plan-meta"><div><dt>Complexity</dt><dd>${escapeHtml(humanize(plan.complexity))}</dd></div><div><dt>Usage</dt><dd>${escapeHtml(humanize(plan.usageClass))}</dd></div></dl>
    <div class="capability-chips" aria-label="Affected capabilities">${plan.affectedCapabilities.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
    <ul class="warnings">${plan.warnings.map((warning) => `<li><strong>${escapeHtml(humanize(warning.kind))}:</strong> ${escapeHtml(warning.label)}</li>`).join("")}</ul>
    <label for="plan-comment">Decision note</label><textarea id="plan-comment" rows="2" maxlength="1000"${actionable ? "" : " disabled"}>${escapeHtml(plan.comment || "")}</textarea>
    <div class="plan-actions" role="group" aria-label="Plan decision controls">
      <button class="primary" type="button" data-plan-decision="approve" data-plan-id="${escapeAttribute(plan.id)}"${actionable ? "" : " disabled"}>Approve plan</button>
      <button type="button" data-plan-decision="request_changes" data-plan-id="${escapeAttribute(plan.id)}"${actionable ? "" : " disabled"}>Request changes</button>
      <button class="danger" type="button" data-plan-decision="reject" data-plan-id="${escapeAttribute(plan.id)}"${actionable ? "" : " disabled"}>Reject</button>
    </div><small>Fixture decision only. No durable production approval is created.</small></article>`;
}

function renderAgents(state) {
  return `<section aria-labelledby="agents-title"><div class="page-heading"><div><p class="eyebrow">Activity and control</p><h1 id="agents-title">Agents</h1><p>Inspect deterministic agent work without enabling concurrent production writes.</p></div></div>
    <div class="agent-list">${state.agents.map(renderAgent).join("")}</div></section>`;
}

function renderAgent(agent) {
  return `<article class="agent-row"><div class="agent-main"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(agent.kind === "primary" ? "Primary Thrallo agent" : "Child fixture agent")}</p><h2>${escapeHtml(agent.name)}</h2></div><span class="state-label">${escapeHtml(humanize(agent.status))}</span></div>
    <p>${escapeHtml(agent.task)}</p><dl class="agent-meta"><div><dt>Model</dt><dd>${escapeHtml(agent.model)}</dd></div><div><dt>Current action</dt><dd>${escapeHtml(agent.currentAction)}</dd></div><div><dt>Elapsed</dt><dd>${escapeHtml(formatDuration(agent.elapsedSeconds))}</dd></div><div><dt>Usage</dt><dd>${escapeHtml(agent.usageLabel)}</dd></div></dl>
    <div class="files"><strong>Affected fixture files</strong>${agent.filesAffected.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div></div>
    <div class="agent-controls" aria-label="Controls for ${escapeAttribute(agent.name)}">${agent.controls.map((control) => `<button type="button" data-agent="${escapeAttribute(agent.id)}" data-agent-control="${escapeAttribute(control.id)}"${control.enabled ? "" : " disabled"}>${escapeHtml(control.label)}${control.enabled ? "" : " - unavailable"}</button>`).join("")}</div>
  </article>`;
}

function renderAgentCompact(state) {
  const active = state.agents.filter((agent) => ["running", "waiting_approval", "queued", "recovering"].includes(agent.status));
  return `<section class="rail-block"><div class="section-heading"><h2>Agent activity</h2><button class="quiet" type="button" data-nav="agents">Inspect</button></div>${active.length ? active.map((agent) => `<p><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(humanize(agent.status))}</span></p>`).join("") : `<p>No fixture agents are active.</p>`}</section>`;
}

function renderUsage(state) {
  return `<section aria-labelledby="usage-title"><div class="page-heading"><div><p class="eyebrow">Account and limits</p><h1 id="usage-title">Usage</h1><p>Limits come from D3 fixture models. Unknown values remain unknown.</p></div><button type="button" data-portal="usage">Open usage portal</button></div>
    ${renderUsageSummary(state, false)}
    <div class="usage-grid">${Object.entries(state.access.usage.resources).map(([key, meter]) => renderMeter(key, meter)).join("")}</div>
    ${renderAccountLinks(state)}
  </section>`;
}

function renderUsageSummary(state, compact) {
  const ai = state.access.usage.resources.aiModel;
  const warning = state.access.usage.warnings.find((item) => item.resource === "aiModel") || null;
  const value = ai.percent == null ? "Unavailable" : `${Math.round(ai.percent)}% used`;
  return `<section class="section-block${compact ? " compact-block" : ""}" aria-labelledby="usage-summary-title"><div class="section-heading"><div><p class="eyebrow">Usage and budget</p><h2 id="usage-summary-title">${escapeHtml(value)}</h2></div><span class="state-label">${escapeHtml(humanize(ai.state))}</span></div>
    <div class="meter" role="progressbar" aria-label="AI and model usage" aria-valuemin="0" aria-valuemax="100"${ai.percent == null ? " aria-valuetext=\"Unavailable\"" : ` aria-valuenow=\"${Math.round(ai.percent)}\"`}><span style="width:${ai.percent == null ? 0 : Math.round(ai.percent)}%"></span></div>
    <p>${warning ? `${humanize(warning.state)}. ${warning.hardLimitReached ? "The D3 evaluator blocks managed actions." : "Local work remains available."}` : ai.freshness === "stale" ? "Cached read-only usage. Managed actions fail closed when required." : "Usage is within the fixture allowance."}</p>
    ${compact ? `<button class="quiet" type="button" data-nav="usage">View usage</button>` : ""}</section>`;
}

function renderMeter(key, meter) {
  const value = meter.percent == null ? "Unavailable" : `${Math.round(meter.percent)}% used`;
  return `<article class="usage-item"><div class="section-heading"><h2>${escapeHtml(humanize(key))}</h2><span class="state-label">${escapeHtml(humanize(meter.state))}</span></div><strong>${escapeHtml(value)}</strong><p>${escapeHtml(meter.freshness === "stale" ? "Stale, read-only data" : meter.hardLimitReached ? "Hard limit reached" : meter.unit || "Limit not supplied")}</p></article>`;
}

function renderRunSummary(state) {
  return `<section class="section-block compact-block" aria-labelledby="run-title"><div class="section-heading"><div><p class="eyebrow">Builder run</p><h2 id="run-title">${escapeHtml(state.build.label)}</h2></div><span class="state-label">${escapeHtml(humanize(state.build.state))}</span></div>
    <div class="meter" role="progressbar" aria-label="Fixture builder progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${state.build.progress}"><span style="width:${state.build.progress}%"></span></div>
    <p>${state.build.active ? "Fixture work is in progress." : state.build.state === "capability_unavailable" ? "No live fallback was attempted." : "No production build is running."}</p>
    <button class="quiet" type="button" data-advance-build>Advance fixture state</button></section>`;
}

function renderModelSelector(state) {
  const selected = state.models.items.find((model) => model.id === state.models.selected);
  return `<section class="rail-block"><label for="model-select"><strong>Model selection</strong></label><select id="model-select" aria-describedby="model-detail">${state.models.items.map((model) => `<option value="${escapeAttribute(model.id)}"${model.id === state.models.selected ? " selected" : ""}${model.available ? "" : " disabled"}>${escapeHtml(model.label)}${model.available ? "" : " - unavailable"}</option>`).join("")}</select><p id="model-detail">${escapeHtml(selected?.detail || state.models.fallbackExplanation)}</p><small>${escapeHtml(state.models.fallbackExplanation)}</small></section>`;
}

function renderAccountLinks(state) {
  return `<section class="account-links" aria-labelledby="account-links-title"><div><p class="eyebrow">Account portal</p><h2 id="account-links-title">Manage Thrallo</h2><p>${escapeHtml(`${humanize(state.access.entitlement.state)} entitlement · ${humanize(state.access.entitlement.freshness)} data`)}</p></div><div>${state.access.account.portalActions.map((action) => `<button type="button" data-portal="${escapeAttribute(action.destination)}">${escapeHtml(action.label)}</button>`).join("")}</div></section>`;
}

function renderNotices(notices) {
  return notices.map((notice) => `<div class="notice" role="status" data-state="${escapeAttribute(notice.state)}"><strong>${escapeHtml(notice.title)}</strong><span>${escapeHtml(notice.detail)}</span></div>`).join("");
}

function emptyState(title, detail) { return `<div class="empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>`; }

function sectionTitle(id) { return ({ home: "Home", conversation: "Conversation", projects: "Projects", agents: "Agent activity", usage: "Usage and budget", preview: "Application preview", deployments: "Deployments and releases", domains: "Domains and health", settings: "Settings", database: "Database and Supabase", integrations: "External integrations" })[id] || "Thrallo"; }
function humanize(value) { return String(value ?? "unknown").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : date.toISOString().slice(0, 10); }
function formatDuration(seconds) { const minutes = Math.floor(seconds / 60); return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function escapeAttribute(value) { return escapeHtml(value).replaceAll("`", "&#96;"); }

function clientScript() {
  return `const vscode=acquireVsCodeApi();
const announce=(text)=>{const node=document.getElementById('announcer');node.textContent='';requestAnimationFrame(()=>{node.textContent=text;});};
document.addEventListener('click',(event)=>{const button=event.target.closest('button');if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')return;
 if(button.dataset.nav)vscode.postMessage({type:'navigate',destination:button.dataset.nav});
 else if(button.dataset.hostAction)vscode.postMessage({type:'hostAction',action:button.dataset.hostAction});
 else if(button.dataset.project)vscode.postMessage({type:'selectProject',projectId:button.dataset.project});
 else if(button.dataset.previewProject)vscode.postMessage({type:'openPreview',projectId:button.dataset.previewProject});
 else if(button.dataset.deploymentId)vscode.postMessage({type:'deploymentAction',action:{type:'select_deployment',deploymentId:button.dataset.deploymentId}});
 else if(button.dataset.releaseId)vscode.postMessage({type:'deploymentAction',action:{type:'select_release',releaseId:button.dataset.releaseId}});
 else if(button.dataset.deploymentReview)vscode.postMessage({type:'deploymentAction',action:{type:'review_action',actionId:button.dataset.deploymentReview}});
 else if(button.dataset.deploymentConfirm)vscode.postMessage({type:'deploymentAction',action:{type:'confirm_action',actionId:button.dataset.deploymentConfirm,confirmed:true}});
 else if(button.dataset.deploymentAction)vscode.postMessage({type:'deploymentAction',action:deploymentAction(button.dataset.deploymentAction)});
 else if(button.dataset.deploymentFocus){const ids={deployments:'deployment-history-title',releases:'release-history-title',logs:'deployment-logs-title',domains:'domain-title'};document.getElementById(ids[button.dataset.deploymentFocus])?.scrollIntoView({block:'start'});}
 else if(button.dataset.settingsSection)vscode.postMessage({type:'settingsAction',action:{type:'select_section',section:button.dataset.settingsSection}});
 else if(button.dataset.settingsHandoff)vscode.postMessage({type:'settingsHandoff',destination:button.dataset.settingsHandoff});
 else if(button.dataset.secretDelete)vscode.postMessage({type:'settingsAction',action:{type:'review_secret_delete',name:button.dataset.secretDelete}});
 else if(button.dataset.secretDeleteConfirm)vscode.postMessage({type:'settingsAction',action:{type:'confirm_secret_delete',name:button.dataset.secretDeleteConfirm,confirmed:true}});
 else if(button.dataset.databasePreview)vscode.postMessage({type:'settingsAction',action:{type:'preview_database_change',changeId:button.dataset.databasePreview}});
 else if(button.dataset.integrationInspect)vscode.postMessage({type:'settingsAction',action:{type:'integration_action',integrationId:button.dataset.integrationInspect,actionId:'inspect'}});
 else if(button.dataset.settingsAction)vscode.postMessage({type:'settingsAction',action:{type:button.dataset.settingsAction}});
 else if(button.dataset.planDecision)vscode.postMessage({type:'planDecision',decision:button.dataset.planDecision,planId:button.dataset.planId,comment:document.getElementById('plan-comment')?.value||''});
 else if(button.dataset.agentControl)vscode.postMessage({type:'agentControl',agentId:button.dataset.agent,control:button.dataset.agentControl});
 else if(button.dataset.portal)vscode.postMessage({type:'portal',destination:button.dataset.portal});
 else if(button.dataset.preview){const command=document.getElementById('preview-command')?.value||null;const action=button.dataset.preview;if(action==='custom-viewport')vscode.postMessage({type:'previewAction',action:{type:'set_viewport',width:Number(document.getElementById('viewport-width')?.value),height:Number(document.getElementById('viewport-height')?.value)}});else vscode.postMessage({type:'previewAction',action:previewAction(action,command)});}
 else if(button.hasAttribute('data-advance-build'))vscode.postMessage({type:'advanceFixtureBuild'});
 announce(button.textContent.trim());});
document.getElementById('message-form')?.addEventListener('submit',(event)=>{event.preventDefault();const field=document.getElementById('message');const text=field.value.trim();if(text){vscode.postMessage({type:'sendMessage',text});field.value='';}});
document.getElementById('model-select')?.addEventListener('change',(event)=>vscode.postMessage({type:'selectModel',modelId:event.target.value}));
document.getElementById('preview-path-form')?.addEventListener('submit',(event)=>{event.preventDefault();vscode.postMessage({type:'previewAction',action:{type:'navigate_preview',path:document.getElementById('preview-path')?.value||'/'}});});
document.querySelectorAll('[data-viewport]').forEach((button)=>button.addEventListener('click',()=>vscode.postMessage({type:'previewAction',action:{type:'set_viewport',presetId:button.dataset.viewport}})));
document.getElementById('viewport-zoom')?.addEventListener('change',(event)=>vscode.postMessage({type:'previewAction',action:{type:'set_zoom',zoom:event.target.value==='fit'?'fit':Number(event.target.value)}}));
document.getElementById('diagnostic-filter')?.addEventListener('change',(event)=>vscode.postMessage({type:'previewAction',action:{type:'filter_diagnostics',severity:event.target.value}}));
document.querySelectorAll('[data-source-file]').forEach((button)=>button.addEventListener('click',()=>vscode.postMessage({type:'openDiagnosticSource',file:button.dataset.sourceFile,line:Number(button.dataset.sourceLine),column:Number(button.dataset.sourceColumn)})));
document.getElementById('deployment-log-filter')?.addEventListener('submit',(event)=>{event.preventDefault();const form=new FormData(event.target);vscode.postMessage({type:'deploymentAction',action:{type:'filter_logs',phase:form.get('phase'),severity:form.get('severity'),search:form.get('search')}});});
document.getElementById('log-follow')?.addEventListener('change',(event)=>vscode.postMessage({type:'deploymentAction',action:{type:'toggle_log_follow',follow:event.target.checked}}));
const deploymentDialog=document.querySelector('.deployment-review');if(deploymentDialog){deploymentDialog.close();deploymentDialog.showModal();deploymentDialog.querySelector('button')?.focus();}
const settingsDialog=document.querySelector('.settings-dialog');if(settingsDialog){settingsDialog.close();settingsDialog.showModal();settingsDialog.querySelector('button')?.focus();}
document.getElementById('secret-form')?.addEventListener('submit',(event)=>{event.preventDefault();const form=new FormData(event.target);vscode.postMessage({type:'settingsAction',action:{type:form.get('operation')==='replace'?'replace_secret':'create_secret',name:form.get('name'),secretClass:form.get('secretClass'),value:form.get('value')}});event.target.reset();});
document.getElementById('environment-preview-form')?.addEventListener('submit',(event)=>{event.preventDefault();const form=new FormData(event.target);vscode.postMessage({type:'settingsAction',action:{type:'preview_environment_variable',key:form.get('key'),environment:form.get('environment'),secret:form.get('secret')==='on'}});});
document.querySelectorAll('[data-preference-id]').forEach((input)=>input.addEventListener('change',(event)=>vscode.postMessage({type:'settingsAction',action:{type:'update_preference',preferenceId:event.target.dataset.preferenceId,value:event.target.checked}})));
function previewAction(action,command){return ({start:{type:'start_preview',commandId:command,userInitiated:true},restart:{type:'restart_preview',commandId:command,userInitiated:true},stop:{type:'stop_preview'},reload:{type:'reload_preview'},back:{type:'history_back'},forward:{type:'history_forward'},screenshot:{type:'capture_screenshot'},tests:{type:'run_tests'},'cancel-tests':{type:'cancel_tests'},rotate:{type:'rotate_viewport'},'reset-viewport':{type:'reset_viewport'},'clear-diagnostics':{type:'clear_diagnostics',kind:'all'},'copy-diagnostics':{type:'copy_diagnostics'},external:{type:'open_external'}})[action]||{type:'unsupported'};}
function deploymentAction(action){return ({load_older_logs:{type:'load_older_logs'},cancel_review:{type:'cancel_review'},copy_dns_instructions:{type:'copy_dns_instructions'},export:{type:'export_fixture'}})[action]||{type:'unsupported'};}`;
}

function styles() {
  return `:root{color-scheme:light dark;--surface:var(--vscode-editor-background,#fbfbf8);--surface-2:var(--vscode-sideBar-background,#f3f4ef);--surface-3:var(--vscode-input-background,#fff);--text:var(--vscode-foreground,#25232b);--muted:var(--vscode-descriptionForeground,#686572);--line:var(--vscode-panel-border,#dadbd5);--accent:var(--vscode-button-background,#5f55d9);--accent-text:var(--vscode-button-foreground,#fff);--focus:var(--vscode-focusBorder,#6858e8);--danger:var(--vscode-errorForeground,#b42318);font-family:var(--vscode-font-family,Inter,system-ui,sans-serif);font-size:var(--vscode-font-size,13px)}*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);line-height:1.45}.shell{min-height:100vh;display:grid;grid-template-columns:minmax(176px,210px) 1fr}.sidebar{background:var(--surface-2);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;gap:18px}.brand{display:grid;grid-template-columns:30px 1fr;grid-template-rows:auto auto;align-items:center;column-gap:9px;padding:0 6px}.brand>span{grid-row:1/3;width:30px;height:30px;border-radius:9px;background:var(--accent);color:var(--accent-text);display:grid;place-items:center;font-weight:800}.brand strong{font-size:15px}.brand small,.topbar small{color:var(--muted)}nav{display:flex;flex-direction:column;gap:12px}.nav-group{display:grid;gap:3px}.nav-label{padding:0 9px;color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.nav-item{border:0;background:transparent;color:var(--text);border-radius:7px;padding:7px 9px;text-align:left;display:flex;justify-content:space-between;gap:8px;font:inherit;cursor:pointer}.nav-item:hover,.nav-item.active{background:var(--vscode-list-hoverBackground,rgba(110,100,160,.10))}.nav-item.active{font-weight:700}.nav-item[aria-disabled=true]{cursor:not-allowed;color:var(--muted)}.nav-item small{font-size:10px}.future summary{cursor:pointer;padding:5px 9px;color:var(--muted);font-weight:600}.mode-note{margin-top:auto;padding:10px;border:1px solid var(--line);border-radius:8px;display:grid;gap:2px;font-size:11px}.mode-note span{color:var(--muted)}.workspace{min-width:0}.topbar{height:60px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;padding:0 clamp(18px,3vw,34px);position:sticky;top:0;background:var(--surface);z-index:2}.topbar>div{display:flex;gap:10px;align-items:center}.account{font-size:12px}.account>span:last-child{display:grid}.avatar{width:28px;height:28px;border-radius:50%;background:var(--vscode-badge-background,#ddd9fa);color:var(--vscode-badge-foreground,#332c75);display:grid!important;place-items:center;font-weight:700}main{max-width:1280px;margin:0 auto;padding:clamp(20px,4vw,42px);outline:none}.skip-link{position:fixed;left:10px;top:-50px;background:var(--surface);padding:8px;z-index:10}.skip-link:focus{top:10px}.hero{display:flex;justify-content:space-between;gap:30px;align-items:end;padding:4px 0 28px}.hero h1,.page-heading h1{font-size:clamp(26px,4vw,42px);line-height:1.1;margin:4px 0 10px;letter-spacing:-.025em}.hero p,.page-heading p{max-width:680px;color:var(--muted);margin:0}.eyebrow{font-size:11px!important;font-weight:750;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)!important;margin:0!important}.primary-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:470px}button,select,textarea{font:inherit}button,select{border:1px solid var(--line);border-radius:7px;background:var(--surface-3);color:var(--text);padding:7px 11px;cursor:pointer}button:hover:not(:disabled){border-color:var(--focus)}button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);font-weight:700}button.danger{color:var(--danger)}button.quiet{border-color:transparent;background:transparent;padding:4px 6px}button:disabled{cursor:not-allowed;opacity:.58}button:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.home-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:18px;margin-bottom:18px}.home-grid.lower{grid-template-columns:1fr 1fr}.section-block,.rail-block,.usage-item,.plan-card,.account-links{border:1px solid var(--line);border-radius:10px;background:var(--surface-3);padding:16px}.section-heading,.page-heading{display:flex;justify-content:space-between;gap:18px;align-items:start}.section-heading h2,.section-heading h1,.rail-block h2{font-size:16px;margin:2px 0 10px}.project-list{display:grid;gap:8px;margin-top:16px}.project-row{display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:center;border:1px solid var(--line);border-radius:9px;padding:12px;background:var(--surface-3)}.project-list.compact .project-row{border-width:1px 0 0;border-radius:0;padding:10px 0}.source-mark{width:30px;height:30px;border-radius:8px;background:var(--surface-2);display:grid;place-items:center;font-weight:800}.project-copy>div{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.project-copy h3{font-size:14px;margin:0}.project-copy p,.project-copy small,.section-block p,.rail-block p{margin:3px 0;color:var(--muted)}.row-actions{display:flex;align-items:center;gap:8px}.state-label,.fixture-pill{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:3px 6px;border:1px solid var(--line);border-radius:999px}.warning-text,.warnings{color:var(--danger);font-weight:650}.account-links{margin-top:18px;display:flex;justify-content:space-between;align-items:center;gap:20px}.account-links h2{margin:3px 0}.account-links p{margin:0;color:var(--muted)}.account-links>div:last-child{display:flex;gap:8px;flex-wrap:wrap}.notice{display:flex;gap:8px;border-left:3px solid var(--focus);background:var(--surface-2);padding:8px 12px;margin-bottom:10px}.notice span{color:var(--muted)}.conversation-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,300px);gap:20px}.messages{display:grid;gap:10px;margin:18px 0}.message{max-width:82%;border:1px solid var(--line);border-radius:10px;padding:11px 13px;background:var(--surface-3)}.message.user{margin-left:auto;background:var(--vscode-textBlockQuote-background,var(--surface-2))}.message header{display:flex;justify-content:space-between;gap:10px;font-size:11px}.message header span{color:var(--muted)}.message p{margin:5px 0}.plan-card{margin:18px 0}.plan-card>header{display:flex;justify-content:space-between;gap:16px}.plan-card h2{margin:3px 0}.plan-meta,.agent-meta{display:flex;gap:20px;flex-wrap:wrap}.plan-meta div,.agent-meta div{display:grid}.plan-meta dt,.agent-meta dt{color:var(--muted);font-size:11px}.plan-meta dd,.agent-meta dd{margin:0;font-weight:650}.capability-chips{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.capability-chips span{background:var(--surface-2);border-radius:999px;padding:4px 8px}.warnings{padding-left:20px}.plan-card textarea,.composer textarea{width:100%;resize:vertical;border:1px solid var(--line);border-radius:7px;background:var(--vscode-input-background,var(--surface));color:var(--text);padding:9px}.plan-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.composer{border-top:1px solid var(--line);padding-top:14px}.composer>div{display:flex;gap:8px;align-items:end}.composer label,.plan-card label{display:block;font-weight:650;margin-bottom:5px}.composer small,.plan-card small,.rail-block small{color:var(--muted)}.activity-rail{display:grid;align-content:start;gap:12px}.rail-block select{width:100%;margin:8px 0}.rail-block p{display:flex;justify-content:space-between}.meter{height:7px;background:var(--surface-2);border-radius:999px;overflow:hidden;margin:10px 0}.meter span{display:block;height:100%;background:var(--accent);transition:width .2s ease}.agent-list{display:grid;gap:12px}.agent-row{border:1px solid var(--line);border-radius:10px;background:var(--surface-3);padding:16px;display:grid;grid-template-columns:1fr auto;gap:18px}.agent-main>p{color:var(--muted)}.files{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.files code{background:var(--surface-2);padding:3px 6px;border-radius:5px}.agent-controls{display:flex;flex-direction:column;gap:7px;min-width:110px}.usage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}.usage-item strong{font-size:18px}.usage-item p{color:var(--muted)}.filter-note,.empty{padding:12px 14px;background:var(--surface-2);border-radius:8px;margin:14px 0}.empty p{margin:3px 0;color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}@media(max-width:900px){.home-grid,.home-grid.lower,.conversation-layout{grid-template-columns:1fr}.hero,.page-heading{align-items:start;flex-direction:column}.primary-actions{justify-content:flex-start}.activity-rail{grid-template-columns:repeat(2,minmax(0,1fr))}.usage-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.shell{grid-template-columns:1fr}.sidebar{position:relative;border-right:0;border-bottom:1px solid var(--line)}.nav-group{grid-template-columns:repeat(2,minmax(0,1fr))}.future,.mode-note{display:none}.topbar{position:relative}.account-links,.agent-row{align-items:stretch;flex-direction:column;grid-template-columns:1fr}.usage-grid,.activity-rail{grid-template-columns:1fr}.message{max-width:100%}.project-row{grid-template-columns:32px 1fr}.row-actions{grid-column:2}.composer>div{flex-direction:column;align-items:stretch}}`;
}

module.exports = { renderDesktopProductHtml, escapeHtml };
