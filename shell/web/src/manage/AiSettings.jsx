// AI connection — a Settings drill-in, not a dashboard. Secrets are technically required
// to live here (keys and login flows must never enter the conversation or model context).
// Full parity with the old provider management: managed / BYOK keys / Codex device flow,
// smart routing, provider health, and the paid model comparison.

import React, { useEffect, useMemo, useState } from "react";
import {
  aiConnections, aiEvaluations, cancelCodexLogin, codexLoginStatus, connectAiKey,
  disconnectAiProvider, runAiEvaluation, selectAiProvider, startCodexLogin, updateAiRouting,
  saveByokSafety,
} from "../lib/codeAgentApi.js";
import { SkeletonRows, useCopy } from "./shared.jsx";

const PROVIDERS = {
  codex: { name: "ChatGPT Codex", hint: "Your ChatGPT plan and Codex limits — no API key." },
  openai: { name: "OpenAI API", hint: "Your own OpenAI balance.", placeholder: "sk-…" },
  anthropic: { name: "Anthropic API", hint: "Your own Anthropic balance.", placeholder: "sk-ant-…" },
  gemini: { name: "Gemini API", hint: "Your Google AI Studio balance.", placeholder: "AIza…" },
  xai: { name: "xAI Grok API", hint: "Your own xAI balance — Grok 4.5 and coding models.", placeholder: "xai-…" },
};

export default function AiSettings() {
  const [data, setData] = useState(null);
  const [keys, setKeys] = useState({ openai: "", anthropic: "", gemini: "", xai: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState(null);
  const [routing, setRouting] = useState({ routingMode: "balanced", preferredModel: "", allowFallback: true });
  const [evaluations, setEvaluations] = useState({ health: [], evaluations: [] });
  const [comparing, setComparing] = useState(false);
  const [codeCopied, copyCode] = useCopy();
  const [evaluationPrompt, setEvaluationPrompt] = useState(
    "Review this JavaScript and explain the bug, then provide a corrected version: const total = items.reduce((sum, item) => sum + item.price);",
  );

  const connections = useMemo(
    () => Object.fromEntries((data?.connections || []).map((item) => [item.provider, item])),
    [data],
  );

  useEffect(() => {
    Promise.all([aiConnections(), aiEvaluations()])
      .then(([c, e]) => { setData(c); setEvaluations(e); })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!data?.routing) return;
    setRouting({
      routingMode: data.routing.routingMode || "balanced",
      preferredModel: data.routing.preferredModel || "",
      allowFallback: data.routing.allowFallback !== false,
    });
  }, [data?.routing]);

  // Codex device-flow polling — verbatim lifecycle from the proven implementation.
  useEffect(() => {
    if (!login?.sessionId || login.status !== "pending") return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await codexLoginStatus(login.sessionId);
        if (stopped) return;
        if (result.status === "connected") {
          setLogin(null);
          setNotice("Codex is connected and selected for new runs.");
          setData(await aiConnections());
          return;
        }
      } catch (err) {
        if (!stopped) { setLogin(null); setError(err.message); }
        return;
      }
      if (!stopped) window.setTimeout(poll, 2_000);
    };
    const timer = window.setTimeout(poll, 1_500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [login?.sessionId, login?.status]);

  async function run(action, task) {
    setBusy(action); setError(""); setNotice("");
    try { await task(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  const select = (provider) => run(`select-${provider}`, async () => {
    setData(await selectAiProvider(provider));
    setNotice(provider === "managed" ? "Thrallo managed AI is selected." : `${PROVIDERS[provider].name} is selected.`);
  });
  const disconnect = (provider) => run(`disconnect-${provider}`, async () => {
    setData(await disconnectAiProvider(provider));
    setNotice(`${PROVIDERS[provider].name} was disconnected.`);
  });
  const connectKey = (provider) => run(`connect-${provider}`, async () => {
    const result = await connectAiKey(provider, keys[provider]);
    setData(result);
    setKeys((c) => ({ ...c, [provider]: "" }));
    setNotice(`${PROVIDERS[provider].name} is connected and selected.`);
  });

  if (!data && !error) {
    return (
      <div>
        <h3>AI connection</h3>
        <p className="mg-sub">Choose how your team thinks. Keys are encrypted server-side and never shown again.</p>
        <div className="mg-card"><SkeletonRows rows={4} /></div>
      </div>
    );
  }

  const active = data?.activeProvider || "managed";

  return (
    <div>
      <h3>AI connection</h3>
      <p className="mg-sub">Choose how your team thinks. Keys are encrypted server-side and never shown again.</p>
      {!data?.configured && <div className="mg-error">Encrypted credential storage is not enabled on the server yet.</div>}
      {error && <div className="mg-error">{error}</div>}
      {notice && <div className="mg-ok">{notice}</div>}

      <div className="mg-card">
        <div className="mg-row">
          <div>Thrallo managed<div className="ct-hint">Metered against your plan — nothing to configure.</div></div>
          {active === "managed"
            ? <span className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />Active</span>
            : <button className="ct-btn-quiet" disabled={!!busy} onClick={() => select("managed")}>Use</button>}
        </div>

        <div className="mg-row">
          <div>
            {PROVIDERS.codex.name}
            <div className="ct-hint">{connections.codex?.hint || connections.codex?.metadata?.planType
              ? `${connections.codex?.hint || "Connected"}${connections.codex?.metadata?.planType ? ` · ${connections.codex.metadata.planType} plan` : ""}`
              : PROVIDERS.codex.hint}</div>
          </div>
          {active === "codex" ? <span className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />Active</span>
            : connections.codex ? (
              <span style={{ display: "flex", gap: 6 }}>
                <button className="ct-btn-quiet" disabled={!!busy} onClick={() => select("codex")}>Use</button>
                <button className="ct-btn-quiet" disabled={!!busy} onClick={() => disconnect("codex")}>Disconnect</button>
              </span>
            ) : !login ? (
              <button className="ct-btn-quiet" disabled={!data?.configured || !!busy}
                onClick={() => run("codex-login", async () => setLogin(await startCodexLogin()))}>
                {busy === "codex-login" ? "Starting…" : "Sign in"}
              </button>
            ) : null}
        </div>
        {login && (
          <div className="mg-card" style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Finish signing in with OpenAI</div>
            <p className="ct-hint" style={{ margin: "4px 0 10px" }}>Open the sign-in page and enter this one-time code:</p>
            <button className="mg-mono" style={{ width: "100%", padding: "10px 0", fontSize: 18, letterSpacing: "0.25em", textAlign: "center", border: "1px dashed var(--accent)", background: "var(--accent-soft)", borderRadius: 12, cursor: "pointer" }}
              title="Copy code" onClick={() => copyCode(login.userCode)}>{codeCopied ? "Copied ✓" : login.userCode}</button>
            <div className="ct-actions">
              <a className="ct-btn" style={{ textDecoration: "none" }} href={login.verificationUrl} target="_blank" rel="noreferrer">Open OpenAI sign-in</a>
              <button className="ct-btn-quiet" onClick={() => run("codex-cancel", async () => { await cancelCodexLogin(login.sessionId); setLogin(null); })}>Cancel</button>
            </div>
            <div className="ct-hint" style={{ marginTop: 8 }}>Waiting for confirmation…</div>
          </div>
        )}

        {["openai", "anthropic", "gemini", "xai"].map((provider) => (
          <div className="mg-row" key={provider}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {PROVIDERS[provider].name}
              <div className="ct-hint">{connections[provider]?.hint || PROVIDERS[provider].hint}</div>
              {!connections[provider] && (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input className="mg-input" type="password" autoComplete="off" placeholder={PROVIDERS[provider].placeholder}
                    value={keys[provider]} onChange={(e) => setKeys((c) => ({ ...c, [provider]: e.target.value }))} />
                  <button className="ct-btn" disabled={!data?.configured || !keys[provider].trim() || !!busy}
                    onClick={() => connectKey(provider)}>
                    {busy === `connect-${provider}` ? "Checking…" : "Connect"}
                  </button>
                </div>
              )}
            </div>
            {active === provider ? <span className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />Active</span>
              : connections[provider] ? (
                <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button className="ct-btn-quiet" disabled={!!busy} onClick={() => select(provider)}>Use</button>
                  <button className="ct-btn-quiet" disabled={!!busy} onClick={() => disconnect(provider)}>Disconnect</button>
                </span>
              ) : null}
          </div>
        ))}
        {["openai", "anthropic", "gemini", "xai"].filter((p) => connections[p]).map((provider) => (
          <Safeguards key={`safe-${provider}`} provider={provider} label={PROVIDERS[provider].name}
            document={data?.byokSafety} busy={!!busy}
            onSave={(next) => run(`safeguards-${provider}`, async () => {
              setData(await saveByokSafety(next));
              setNotice("Spending safeguards saved.");
            })} />
        ))}
      </div>

      <div className="mg-label">Smart routing</div>
      <div className="mg-card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select className="mg-select" style={{ width: 170 }} value={routing.routingMode}
            onChange={(e) => setRouting((c) => ({ ...c, routingMode: e.target.value }))}>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality</option>
            <option value="fast">Fast</option>
            <option value="economy">Economy</option>
            <option value="manual">Manual model</option>
          </select>
          {routing.routingMode === "manual" ? (
            <select className="mg-select" style={{ width: 240 }} value={routing.preferredModel}
              onChange={(e) => setRouting((c) => ({ ...c, preferredModel: e.target.value }))}>
              <option value="">Choose a model</option>
              {(data?.models || [])
                .filter((m) => (active === "managed" ? m.configured : m.provider === active))
                .map((m) => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.provider} / {m.id}</option>)}
            </select>
          ) : (
            <label className="ct-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={routing.allowFallback}
                onChange={(e) => setRouting((c) => ({ ...c, allowFallback: e.target.checked }))} />
              Automatic fallback
            </label>
          )}
          <button className="ct-btn" disabled={!!busy || (routing.routingMode === "manual" && !routing.preferredModel)}
            onClick={() => run("routing", async () => { setData(await updateAiRouting(routing)); setNotice("Routing saved."); })}>
            {busy === "routing" ? "Saving…" : "Save"}
          </button>
        </div>
        {!!evaluations.health?.length && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {evaluations.health.slice(0, 6).map((h) => (
              <span key={`${h.provider}:${h.model}`} className="mg-pill">{h.provider} · {h.successRate}% · {h.averageLatencyMs}ms</span>
            ))}
          </div>
        )}
      </div>

      <div className="mg-label">Compare models</div>
      <div className="mg-card">
        {!comparing && !evaluations.evaluations?.length ? (
          <div className="mg-row">
            <div className="ct-hint">One short paid request to up to three configured models — answer, latency, tokens.</div>
            <button className="ct-btn-quiet" onClick={() => setComparing(true)}>Compare</button>
          </div>
        ) : (
          <>
            <textarea className="mg-input" style={{ minHeight: 90, resize: "vertical" }} maxLength={2000}
              value={evaluationPrompt} onChange={(e) => setEvaluationPrompt(e.target.value)} />
            <div className="ct-actions">
              <button className="ct-btn" disabled={!!busy || !evaluationPrompt.trim()}
                onClick={() => run("evaluation", async () => {
                  setEvaluations(await runAiEvaluation({
                    prompt: evaluationPrompt,
                    routingMode: routing.routingMode === "manual" ? "balanced" : routing.routingMode,
                  }));
                  setNotice("Comparison completed.");
                })}>
                {busy === "evaluation" ? "Running…" : "Run comparison"}
              </button>
            </div>
            {(evaluations.evaluations?.[0]?.results || []).map((r) => (
              <div key={r.id} className="mg-card" style={{ marginTop: 8 }}>
                <div style={{ display: "flex", gap: 8, fontSize: 12.5, alignItems: "baseline" }}>
                  <strong>{r.provider}</strong><span className="ct-hint">{r.model}</span>
                  <span className="ct-hint" style={{ marginLeft: "auto" }}>{r.latencyMs}ms · {r.totalTokens} tokens</span>
                </div>
                {r.output
                  ? <p className="ct-hint" style={{ whiteSpace: "pre-wrap", marginTop: 6, color: "var(--ink-2)" }}>{r.output}</p>
                  : <div className="mg-error">{r.error || "Evaluation failed"}</div>}
              </div>
            ))}
          </>
        )}
      </div>
      <p className="ct-hint">Keys and Codex login state are encrypted server-side, decrypted only inside an isolated run, and never returned to this page.</p>
    </div>
  );
}

// Optional spending safeguards for a BYOK connection.
//
// Thrallo does NOT cap usage on a key the user owns — their provider bills them directly.
// Every control here is off until they switch it on, and the copy says so plainly rather
// than implying a limit exists. Values are per-provider and fall back to the user's global
// default, so capping one connection leaves the others untouched.
const CONTROLS = [
  { key: "maxCostPerBuild", label: "Maximum cost per build", hint: "Pause a build once one lifecycle passes this much.", step: "0.5" },
  { key: "maxDailySpend", label: "Maximum daily API spend", hint: "Pause once today's total on this provider passes this much.", step: "1" },
  { key: "warnThreshold", label: "Warning threshold", hint: "Tell me once spending passes this — but keep going.", step: "0.5" },
  { key: "approvalThreshold", label: "Approval threshold", hint: "Ask before an automatic repair projected above this.", step: "0.5" },
  { key: "maxRepairJobs", label: "Maximum automatic repair jobs", hint: "Cap automatic repairs per build.", step: "1", integer: true },
];

export function Safeguards({ provider, label, document: doc, busy, onSave }) {
  const stored = useMemo(() => {
    const global = doc?.global || {};
    const scoped = doc?.providers?.[provider] || {};
    return Object.fromEntries(CONTROLS.map(({ key }) => [
      key,
      Object.prototype.hasOwnProperty.call(scoped, key) ? scoped[key] : (global[key] ?? null),
    ]));
  }, [doc, provider]);

  const [draft, setDraft] = useState(stored);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState("");
  useEffect(() => { setDraft(stored); }, [stored]);

  const enabledCount = CONTROLS.filter(({ key }) => draft[key] != null && draft[key] !== "").length;
  const dirty = CONTROLS.some(({ key }) => String(draft[key] ?? "") !== String(stored[key] ?? ""));

  const setValue = (key, raw, integer) => {
    setInvalid("");
    if (raw === "") { setDraft((d) => ({ ...d, [key]: null })); return; }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) { setInvalid(`${key}: enter a number above zero, or leave it empty to turn it off.`); }
    else if (integer && value !== Math.floor(value)) { setInvalid(`${key}: whole numbers only.`); }
    setDraft((d) => ({ ...d, [key]: raw }));
  };

  const save = () => {
    const providers = { ...(doc?.providers || {}) };
    providers[provider] = Object.fromEntries(CONTROLS.map(({ key }) => [
      key, draft[key] === "" || draft[key] == null ? null : Number(draft[key]),
    ]));
    onSave({ global: doc?.global || {}, providers, timezone: doc?.timezone || null });
  };

  const clearAll = () => {
    const providers = { ...(doc?.providers || {}) };
    providers[provider] = Object.fromEntries(CONTROLS.map(({ key }) => [key, null]));
    onSave({ global: doc?.global || {}, providers, timezone: doc?.timezone || null });
  };

  return (
    <div className="mg-safeguards" style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
      <button className="ct-btn-quiet" style={{ textAlign: "left" }} aria-expanded={open}
        data-testid={`safeguards-toggle-${provider}`} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Optional spending safeguards — {label}
        {enabledCount > 0 && <span className="mg-pill" style={{ marginLeft: 8 }} data-testid={`safeguards-count-${provider}`}>{enabledCount} on</span>}
      </button>
      {open && (
        <div style={{ display: "grid", gap: 10 }}>
          <p className="ct-hint" data-testid={`safeguards-explainer-${provider}`}>
            Thrallo does not cap usage on your own {label} key — your provider bills you directly and normal
            use stays unrestricted. These safeguards are optional and off unless you set one.
          </p>
          {CONTROLS.map(({ key, label: name, hint, step, integer }) => (
            <label key={key} style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {name}
                <div className="ct-hint">{hint}</div>
              </span>
              <input className="mg-input" type="number" min="0" step={step}
                style={{ width: 120, flexShrink: 0 }}
                data-testid={`safeguard-${provider}-${key}`}
                placeholder="Off"
                value={draft[key] ?? ""}
                onChange={(e) => setValue(key, e.target.value, integer)} />
            </label>
          ))}
          <p className="ct-hint" data-testid={`safeguards-currency-${provider}`}>
            Amounts are in Thrallo credits. Costs are estimated from the tokens each request actually
            used at your provider's published per-token prices, and the daily total covers the current
            UTC day{doc?.timezone ? ` in ${doc.timezone}` : ""}.
          </p>
          {invalid && <div className="mg-error" data-testid={`safeguards-error-${provider}`}>{invalid}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ct-btn" disabled={busy || !dirty || !!invalid}
              data-testid={`safeguards-save-${provider}`} onClick={save}>Save safeguards</button>
            {enabledCount > 0 && (
              <button className="ct-btn-quiet" disabled={busy}
                data-testid={`safeguards-clear-${provider}`} onClick={clearAll}>Remove all limits</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
