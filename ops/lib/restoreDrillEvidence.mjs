// DR health must use completed evidence, never a log's filesystem modification time.
export function completedRestoreDrillAt(text, now = Date.now()) {
  let started = null, completed = null;
  try {
    for (const line of String(text || '').split(/\r?\n/).filter(line => line.trim())) {
      const row = JSON.parse(line);
      if (row.startedAt) { started = Date.parse(row.startedAt); completed = null; }
      if (row.result) {
        const at = Date.parse(row.completedAt);
        completed = row.result === 'pass' && Number.isFinite(started) && Number.isFinite(at)
          && at >= started && at <= now + 60_000 ? row.completedAt : null;
      }
    }
  } catch { return null; }
  return completed;
}

export function validateExternalRestoreProbes(text, {host, startedAt, completedAt, maxGapMs = 60_000} = {}) {
  const start = Date.parse(startedAt), end = Date.parse(completedAt);
  if(!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw Error('invalid restore probe interval');
  let rows;
  try { rows = String(text || '').split(/\r?\n/).filter(s=>s.trim()).map(s=>JSON.parse(s)); }
  catch { throw Error('malformed external restore probe evidence'); }
  if(!rows.length) throw Error('external restore probe evidence is empty');
  const samples=new Map(Array.from({length:8},(_,i)=>[55320+i,[]]));
  for(const row of rows) {
    const at=Date.parse(row.checkedAt);
    if(row.host!==host || !samples.has(row.port) || row.connected!==false || row.ok===true || row.success===true
      || !Number.isFinite(at) || at<start-maxGapMs || at>end+maxGapMs) throw Error('external restore probe is reachable, invalid, or outside the drill interval');
    samples.get(row.port).push(at);
  }
  for(const [port,times] of samples) {
    times.sort((a,b)=>a-b);
    if(!times.length || times[0]>start+maxGapMs || times.at(-1)<end-maxGapMs
      || times.some((at,i)=>i>0 && at-times[i-1]>maxGapMs)) throw Error(`external restore probe coverage incomplete for port ${port}`);
  }
  return {ok:true,ports:samples.size,samples:rows.length};
}
