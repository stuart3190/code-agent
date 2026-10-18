import {redactDiagnosticText} from '../appBuild/buildDiagnostics.mjs';
const bounded = (value, limit) => typeof value === 'string' ? redactDiagnosticText(value).slice(0,limit) : null;
const rows = findings => (Array.isArray(findings) ? findings : []).slice(0,20).map(row=>({
  code:bounded(row?.code,100),file:bounded(row?.file || row?.module,300),
  line:Number.isInteger(row?.line) && row.line>0 ? row.line : null,
  message:bounded(row?.message || row?.reason,1000),
}));

// Candidate findings are diagnostics, not new durable build progress. They must not extend a
// stalled build's deadline or erase its candidate when the diagnostic insert is unavailable.
export function createCandidateFindingsRecorder({telemetry,emit}) {
  return async ({owner,buildId,step,attempt,snapshotId,blocking=[],advisory=[]}) => {
    const details={step,attempt,snapshotId,blockingCount:blocking.length,advisoryCount:advisory.length,
      blocking:rows(blocking),advisory:rows(advisory)};
    if(!details.blockingCount && !details.advisoryCount)return null;
    let stored=null;
    try {stored=await telemetry({owner,buildId,kind:'candidate_findings',details});}
    catch {details.persistenceUnavailable=true;}
    emit('progress',{kind:'candidate_findings',...details});
    return stored;
  };
}
