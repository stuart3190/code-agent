// The run overlay — the rich summoned view for a single run: live timeline, artifacts,
// findings, and the full approval machine. Opened from conversation cards or the
// repositories view; closing returns to the conversation untouched ("conversation is
// never a bottleneck").

import React, { useEffect, useRef, useState } from "react";
import { cancelRun, getRun, publishRun, resumeRun, retryRun, runArtifacts, streamRunEvents } from "../lib/codeAgentApi.js";
import { RunSummary, TimelineEvent, ArtifactCard, terminalStates } from "./shared.jsx";

export default function RunOverlay({ runId: initialRunId, onClose }) {
  const [runId, setRunId] = useState(initialRunId);
  useEffect(() => setRunId(initialRunId), [initialRunId]);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  useEffect(() => {
    setRun(null); setEvents([]); setArtifacts([]); setError("");
    if (!runId) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    const hydrate = async () => {
      try {
        const result = await getRun(runId);
        if (cancelled) return;
        setRun(result.run);
        setArtifacts((await runArtifacts(runId)).artifacts || []);
      } catch (err) { if (!cancelled) setError(err.message); }
    };
    hydrate();

    (async () => {
      let after = 0;
      while (!controller.signal.aborted) {
        try {
          after = await streamRunEvents(runId, (event) => {
            after = Math.max(after, Number(event.sequence || 0));
            setEvents((current) => [...current, event]);
            if (event.type?.startsWith("run.") && terminalStates.has(event.type.slice(4))) hydrate();
          }, { signal: controller.signal, after });
        } catch { if (controller.signal.aborted) return; }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        hydrate();
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [runId]);

  const refresh = async () => {
    try {
      const result = await getRun(runId);
      setRun(result.run);
      setArtifacts((await runArtifacts(runId)).artifacts || []);
    } catch (err) { setError(err.message); }
  };

  const act = (task) => async () => {
    setBusy(true); setError("");
    try {
      const result = await task();
      if (result?.run?.id && result.run.id !== runId) setRunId(result.run.id); // retry/resume start a new run
      else await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className={`mg-panel ${runId ? "show" : ""}`} role="dialog" aria-label="Run detail">
      <div className="mg-body">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3>{run ? String(run.prompt || "Run").slice(0, 90) : "Run"}</h3>
          <button className="ct-btn-quiet" onClick={onClose}>Done</button>
        </div>
        <p className="mg-sub">{run ? `${run.state}${run.model ? ` · ${run.model}` : ""}` : "Loading…"}</p>
        {error && <div className="mg-error">{error}</div>}

        {run && (
          <RunSummary run={run} busy={busy}
            onPublish={act(() => publishRun(runId))}
            onDecline={act(() => cancelRun(runId))}
            onRetry={act(() => retryRun(runId))}
            onResume={act(() => resumeRun(runId))} />
        )}

        {events.length > 0 && (
          <>
            <div className="mg-label">Timeline</div>
            <div className="mg-card">
              <div className="mg-timeline">
                {events.slice(-200).map((event, i) => <TimelineEvent key={i} event={event} />)}
              </div>
            </div>
          </>
        )}

        {artifacts.length > 0 && (
          <>
            <div className="mg-label">Artifacts</div>
            {artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={{ ...artifact, runId }} />)}
          </>
        )}
      </div>
    </div>
  );
}
