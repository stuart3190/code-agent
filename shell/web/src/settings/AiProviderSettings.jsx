import { useEffect, useMemo, useState } from "react";
import {
  aiConnections,
  aiEvaluations,
  cancelCodexLogin,
  codexLoginStatus,
  connectAiKey,
  disconnectAiProvider,
  runAiEvaluation,
  selectAiProvider,
  startCodexLogin,
  updateAiRouting,
} from "../lib/codeAgentApi.js";

const providers = {
  codex: {
    name: "Codex",
    eyebrow: "ChatGPT account",
    description: "Use your existing ChatGPT plan and Codex limits. No API key required.",
    accent: "from-emerald-400/15 to-cyan-400/[0.04]",
  },
  openai: {
    name: "OpenAI API",
    eyebrow: "Bring your own key",
    description: "Use your own OpenAI API balance for agent runs.",
    placeholder: "sk-...",
    accent: "from-blue-400/15 to-indigo-400/[0.04]",
  },
  anthropic: {
    name: "Anthropic API",
    eyebrow: "Bring your own key",
    description: "Use your own Anthropic API balance for agent runs.",
    placeholder: "sk-ant-...",
    accent: "from-orange-400/15 to-amber-400/[0.04]",
  },
  gemini: {
    name: "Gemini API",
    eyebrow: "Bring your own key",
    description: "Use your Google AI Studio balance for agent runs.",
    placeholder: "AIza...",
    accent: "from-cyan-400/15 to-blue-400/[0.04]",
  },
};

export default function AiProviderSettings() {
  const [data, setData] = useState(null);
  const [keys, setKeys] = useState({ openai: "", anthropic: "", gemini: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState(null);
  const [routing, setRouting] = useState({
    routingMode: "balanced", preferredModel: "", allowFallback: true,
  });
  const [evaluations, setEvaluations] = useState({ health: [], evaluations: [] });
  const [evaluationPrompt, setEvaluationPrompt] = useState(
    "Review this JavaScript and explain the bug, then provide a corrected version: const total = items.reduce((sum, item) => sum + item.price);",
  );

  const connections = useMemo(
    () => Object.fromEntries((data?.connections || []).map((item) => [item.provider, item])),
    [data],
  );

  useEffect(() => {
    Promise.all([aiConnections(), aiEvaluations()])
      .then(([connectionsData, evaluationData]) => {
        setData(connectionsData);
        setEvaluations(evaluationData);
      })
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

  useEffect(() => {
    if (!login?.sessionId || login.status !== "pending") return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await codexLoginStatus(login.sessionId);
        if (stopped) return;
        if (result.status === "connected") {
          setLogin(null);
          setNotice("Codex is connected and selected for new agent runs.");
          setData(await aiConnections());
          return;
        }
      } catch (err) {
        if (!stopped) {
          setLogin(null);
          setError(err.message);
        }
        return;
      }
      if (!stopped) window.setTimeout(poll, 2_000);
    };
    const timer = window.setTimeout(poll, 1_500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [login?.sessionId, login?.status]);

  async function run(action, task) {
    setBusy(action); setError(""); setNotice("");
    try { await task(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  async function beginCodexLogin() {
    await run("codex-login", async () => {
      const result = await startCodexLogin();
      setLogin(result);
    });
  }

  async function connectKey(provider) {
    await run(`connect-${provider}`, async () => {
      const result = await connectAiKey(provider, keys[provider]);
      setData(result);
      setKeys((current) => ({ ...current, [provider]: "" }));
      setNotice(`${providers[provider].name} is connected and selected.`);
    });
  }

  async function select(provider) {
    await run(`select-${provider}`, async () => {
      setData(await selectAiProvider(provider));
      setNotice(provider === "managed"
        ? "Thrallo managed AI is selected."
        : `${providers[provider].name} is selected.`);
    });
  }

  async function disconnect(provider) {
    await run(`disconnect-${provider}`, async () => {
      setData(await disconnectAiProvider(provider));
      setNotice(`${providers[provider].name} was disconnected.`);
    });
  }

  async function cancelLogin() {
    if (!login?.sessionId) return;
    await run("codex-cancel", async () => {
      await cancelCodexLogin(login.sessionId);
      setLogin(null);
    });
  }

  async function saveRouting() {
    await run("routing", async () => {
      setData(await updateAiRouting(routing));
      setNotice("Model routing settings were saved.");
    });
  }

  async function evaluateModels() {
    await run("evaluation", async () => {
      const result = await runAiEvaluation({
        prompt: evaluationPrompt,
        routingMode: routing.routingMode === "manual" ? "balanced" : routing.routingMode,
      });
      setEvaluations(result);
      setNotice("Provider comparison completed.");
    });
  }

  if (!data && !error) {
    return <div className="grid min-h-[calc(100vh-4rem)] place-items-center text-sm text-slate-600">Loading AI connections…</div>;
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="max-w-2xl">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-400">Agent intelligence</div>
        <h1 className="mt-2 text-3xl font-semibold text-white">Choose how Thrallo uses AI</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Connect Codex with your ChatGPT account, bring an API key, or use Thrallo&apos;s managed allowance.
          Your selection applies to new runs.
        </p>
      </div>

      {!data?.configured && (
        <div className="mt-6 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-4 text-sm text-amber-200/80">
          Encrypted credential storage needs to be enabled on the Thrallo server first.
        </div>
      )}
      {error && <div className="mt-6 rounded-xl border border-red-400/20 bg-red-400/[0.06] p-4 text-sm text-red-300">{error}</div>}
      {notice && <div className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4 text-sm text-emerald-300">{notice}</div>}

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <ProviderCard provider="codex" connection={connections.codex} active={data?.activeProvider === "codex"}
          busy={busy} onSelect={select} onDisconnect={disconnect}>
          {!connections.codex && !login && (
            <button onClick={beginCodexLogin} disabled={!data?.configured || !!busy}
              className="mt-5 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-40">
              {busy === "codex-login" ? "Starting sign-in…" : "Continue with Codex"}
            </button>
          )}
          {login && (
            <div className="mt-5 rounded-xl border border-white/[0.09] bg-black/20 p-4">
              <div className="text-xs font-medium text-white">Finish signing in with OpenAI</div>
              <p className="mt-1 text-[11px] leading-5 text-slate-500">Open the sign-in page and enter this one-time code:</p>
              <button onClick={() => navigator.clipboard?.writeText(login.userCode)}
                className="mt-3 w-full rounded-lg border border-dashed border-emerald-400/30 bg-emerald-400/[0.05] py-3 font-mono text-xl tracking-[0.25em] text-emerald-300">
                {login.userCode}
              </button>
              <div className="mt-3 flex gap-2">
                <a href={login.verificationUrl} target="_blank" rel="noreferrer"
                  className="flex-1 rounded-lg bg-white px-3 py-2 text-center text-xs font-semibold text-black">
                  Open OpenAI sign-in
                </a>
                <button onClick={cancelLogin} className="rounded-lg border border-white/[0.1] px-3 py-2 text-xs text-slate-400">Cancel</button>
              </div>
              <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Waiting for confirmation
              </div>
            </div>
          )}
        </ProviderCard>

        {["openai", "anthropic", "gemini"].map((provider) => (
          <ProviderCard key={provider} provider={provider} connection={connections[provider]}
            active={data?.activeProvider === provider} busy={busy} onSelect={select} onDisconnect={disconnect}>
            {!connections[provider] && (
              <div className="mt-5">
                <input type="password" autoComplete="off" className="field" value={keys[provider]}
                  placeholder={providers[provider].placeholder}
                  onChange={(event) => setKeys((current) => ({ ...current, [provider]: event.target.value }))} />
                <button onClick={() => connectKey(provider)}
                  disabled={!data?.configured || !keys[provider].trim() || !!busy}
                  className="mt-2 w-full rounded-lg border border-white/[0.12] bg-white/[0.06] px-4 py-2 text-xs font-medium text-white hover:bg-white/[0.1] disabled:opacity-40">
                  {busy === `connect-${provider}` ? "Checking key…" : `Connect ${providers[provider].name}`}
                </button>
              </div>
            )}
          </ProviderCard>
        ))}

        <div className={`rounded-2xl border p-5 ${data?.activeProvider === "managed" ? "border-violet-400/35 bg-violet-400/[0.06]" : "border-white/[0.08] bg-[#0e1117]"}`}>
          <div className="flex items-start">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-300">Thrallo allowance</div>
              <h2 className="mt-1 text-lg font-semibold text-white">Managed AI</h2>
            </div>
            {data?.activeProvider === "managed" && <ActiveBadge />}
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">Use Thrallo&apos;s managed model provider and platform credits.</p>
          {data?.activeProvider !== "managed" && (
            <button onClick={() => select("managed")} disabled={!!busy}
              className="mt-5 rounded-lg border border-white/[0.1] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.05] disabled:opacity-40">
              Use managed AI
            </button>
          )}
        </div>
      </div>

      <div className="mt-8 rounded-2xl border border-white/[0.08] bg-[#0e1117] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-300">Smart routing</div>
            <h2 className="mt-1 text-lg font-semibold text-white">Match each task to the right model</h2>
            <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-500">
              Balanced adapts to the task. Quality prioritizes deeper reasoning. Fast and economy favor lower latency.
              Temporary provider failures can automatically fall back to another connected managed provider.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[180px_240px_auto]">
            <select className="field" value={routing.routingMode}
              onChange={(event) => setRouting((current) => ({ ...current, routingMode: event.target.value }))}>
              <option value="balanced">Balanced</option>
              <option value="quality">Quality</option>
              <option value="fast">Fast</option>
              <option value="economy">Economy</option>
              <option value="manual">Manual model</option>
            </select>
            {routing.routingMode === "manual" ? (
              <select className="field" value={routing.preferredModel}
                onChange={(event) => setRouting((current) => ({ ...current, preferredModel: event.target.value }))}>
                <option value="">Choose a model</option>
                {(data?.models || [])
                  .filter((item) => data?.activeProvider === "managed"
                    ? item.configured
                    : item.provider === data?.activeProvider)
                  .map((item) => (
                  <option key={`${item.provider}:${item.id}`} value={`${item.provider}:${item.id}`}>
                    {item.provider} / {item.id}
                  </option>
                  ))}
              </select>
            ) : (
              <label className="flex items-center gap-2 rounded-lg border border-white/[0.08] px-3 text-xs text-slate-400">
                <input type="checkbox" checked={routing.allowFallback}
                  onChange={(event) => setRouting((current) => ({ ...current, allowFallback: event.target.checked }))} />
                Automatic fallback
              </label>
            )}
            <button onClick={saveRouting}
              disabled={!!busy || (routing.routingMode === "manual" && !routing.preferredModel)}
              className="rounded-lg bg-white px-4 py-2.5 text-xs font-semibold text-black disabled:opacity-40">
              {busy === "routing" ? "Saving..." : "Save routing"}
            </button>
          </div>
        </div>
        {!!evaluations.health?.length && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-white/[0.06] pt-4">
            <span className="py-1 text-[10px] uppercase tracking-wide text-slate-600">Recent health</span>
            {evaluations.health.slice(0, 6).map((item) => (
              <span key={`${item.provider}:${item.model}`}
                className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] text-slate-400">
                {item.provider} · {item.successRate}% · {item.averageLatencyMs} ms
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-white/[0.08] bg-[#0e1117] p-5">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">Provider evaluation</div>
            <h2 className="mt-1 text-lg font-semibold text-white">Compare configured models</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              This sends one short paid request to up to three available models and compares their answer,
              latency, and token use. It never gives models repository tools.
            </p>
            <textarea className="field mt-4 min-h-32 resize-y" maxLength={2000}
              value={evaluationPrompt} onChange={(event) => setEvaluationPrompt(event.target.value)} />
            <button onClick={evaluateModels} disabled={!!busy || !evaluationPrompt.trim()}
              className="mt-2 rounded-lg border border-cyan-300/25 bg-cyan-300/[0.08] px-4 py-2.5 text-xs font-semibold text-cyan-100 disabled:opacity-40">
              {busy === "evaluation" ? "Running comparison..." : "Run comparison"}
            </button>
          </div>
          <EvaluationResults data={evaluations} />
        </div>
      </div>

      <p className="mt-6 max-w-3xl text-[11px] leading-5 text-slate-600">
        API keys and Codex login state are encrypted server-side. They are decrypted only for an isolated agent run,
        never returned to this page, and removed from the workspace when the run ends.
      </p>
    </div>
  );
}

function ProviderCard({ provider, connection, active, busy, onSelect, onDisconnect, children }) {
  const config = providers[provider];
  return (
    <div className={`rounded-2xl border bg-gradient-to-br p-5 ${config.accent} ${active ? "border-emerald-400/35" : "border-white/[0.08]"}`}>
      <div className="flex items-start">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{config.eyebrow}</div>
          <h2 className="mt-1 text-lg font-semibold text-white">{config.name}</h2>
        </div>
        {active ? <ActiveBadge /> : connection && (
          <span className="ml-auto rounded-full border border-white/[0.1] px-2 py-1 text-[9px] uppercase tracking-wide text-slate-500">Connected</span>
        )}
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">{config.description}</p>
      {connection && (
        <div className="mt-4 rounded-lg border border-white/[0.07] bg-black/15 px-3 py-2">
          <div className="truncate text-xs text-slate-300">{connection.hint || "Connected account"}</div>
          {connection.metadata?.planType && <div className="mt-1 text-[10px] capitalize text-slate-600">{connection.metadata.planType} plan</div>}
        </div>
      )}
      {connection && (
        <div className="mt-4 flex gap-2">
          {!active && <button onClick={() => onSelect(provider)} disabled={!!busy}
            className="rounded-lg border border-white/[0.1] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.05] disabled:opacity-40">Use for runs</button>}
          <button onClick={() => onDisconnect(provider)} disabled={!!busy}
            className="ml-auto px-2 py-2 text-xs text-slate-600 hover:text-red-300 disabled:opacity-40">Disconnect</button>
        </div>
      )}
      {children}
    </div>
  );
}

function ActiveBadge() {
  return <span className="ml-auto rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] px-2 py-1 text-[9px] uppercase tracking-wide text-emerald-300">Active</span>;
}

function EvaluationResults({ data }) {
  const latest = data?.evaluations?.[0];
  if (!latest) {
    return <div className="grid min-h-48 place-items-center rounded-xl border border-dashed border-white/[0.08] text-xs text-slate-600">No comparisons yet</div>;
  }
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium text-white">{latest.label}</div>
        <span className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[9px] uppercase text-slate-500">{latest.status}</span>
      </div>
      <div className="mt-3 grid gap-3">
        {latest.results.map((result) => (
          <div key={result.id} className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="font-semibold uppercase tracking-wide text-cyan-300">{result.provider}</span>
              <span className="text-slate-500">{result.model}</span>
              <span className="ml-auto text-slate-600">{result.latencyMs} ms · {result.totalTokens} tokens</span>
            </div>
            {result.output
              ? <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-slate-300">{result.output}</p>
              : <p className="mt-3 text-xs text-red-300">{result.error || "Evaluation failed"}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
