import { useEffect, useState } from "react";
import { createApiToken, listApiTokens, revokeApiToken } from "../lib/codeAgentApi.js";

export default function ApiTokens() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listApiTokens().then((result) => setTokens(result.tokens)).catch((err) => setError(err.message));
  }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true); setError(""); setFresh(null);
    try {
      const result = await createApiToken(name.trim());
      setTokens(result.tokens);
      setFresh(result.token);
      setName("");
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function revoke(id) {
    setBusy(true); setError("");
    try {
      setTokens((await revokeApiToken(id)).tokens);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const active = tokens.filter((token) => !token.revokedAt);
  return (
    <div className="mt-10 rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
      <div className="text-sm font-semibold text-white">API tokens</div>
      <p className="mt-1 text-xs text-slate-500">
        Personal access tokens authenticate the VS Code extension and future CLI against your account.
        Tokens are shown once and can be revoked at any time.
      </p>
      {error && <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/[0.05] p-2.5 text-xs text-red-300">{error}</div>}
      {fresh && (
        <div className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] p-3">
          <div className="text-[11px] text-emerald-300">Copy this token now — it will not be shown again.</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-emerald-200">{fresh}</code>
            <button onClick={() => navigator.clipboard?.writeText(fresh)}
              className="rounded border border-white/[0.1] px-2 py-1.5 text-[11px] text-slate-300 hover:bg-white/[0.05]">Copy</button>
          </div>
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          placeholder="Token name, e.g. vscode-laptop"
          className="flex-1 rounded-lg border border-white/[0.08] bg-transparent px-3 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-blue-400/40" />
        <button onClick={create} disabled={busy || !name.trim()}
          className="rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-35">
          Create token
        </button>
      </div>
      <div className="mt-4 space-y-2">
        {active.map((token) => (
          <div key={token.id} className="flex items-center gap-3 rounded-lg border border-white/[0.06] px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-slate-300">{token.name}</div>
              <div className="font-mono text-[10px] text-slate-600">
                {token.prefix}… · {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "never used"}
              </div>
            </div>
            <button onClick={() => revoke(token.id)} disabled={busy}
              className="rounded border border-red-400/20 px-2 py-1 text-[10px] text-red-300 hover:bg-red-400/[0.06] disabled:opacity-40">
              Revoke
            </button>
          </div>
        ))}
        {!active.length && <div className="rounded-lg border border-dashed border-white/[0.08] p-4 text-center text-xs text-slate-600">No active tokens.</div>}
      </div>
    </div>
  );
}
