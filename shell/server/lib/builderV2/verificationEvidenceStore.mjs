import { serviceClient } from "../supabase.mjs";

export function memoryVerificationEvidenceStore() {
  const defects = [];
  const strategies = [];
  return {
    async recordDefects(input) {
      const rows = Array.isArray(input) ? input : input?.records || [];
      defects.push(...rows);
      return rows;
    },
    async startStrategy(row) {
      const value = { id: `strategy-${strategies.length + 1}`, outcome: "started", ...row };
      strategies.push(value); return value;
    },
    async finishStrategy(id, patch) {
      const row = strategies.find((candidate) => candidate.id === id);
      if (!row) throw new Error("repair strategy not found");
      Object.assign(row, patch); return { ...row };
    },
    defects: () => defects.map((row) => ({ ...row })),
    strategies: () => strategies.map((row) => ({ ...row })),
  };
}

export function supabaseVerificationEvidenceStore(client = serviceClient()) {
  const unwrap = ({ data, error }, action) => {
    if (error) throw new Error(`${action}: ${error.message}`);
    return data;
  };
  return {
    async recordDefects({ owner, projectId, buildId, records }) {
      if (!records?.length) return [];
      const rows = records.map((record) => ({
        owner, project_id: projectId, build_id: buildId,
        defect_id: record.defectId, version: record.version,
        classification: record.classification, journey_id: record.journeyId,
        step_id: record.stepId, source_tree_hash: record.sourceTreeHash,
        candidate_snapshot_id: record.candidateSnapshotId, defect: record,
      }));
      const result = await client.from("bv2_verification_defects").upsert(rows, {
        onConflict: "owner,build_id,defect_id,version,source_tree_hash",
        ignoreDuplicates: true,
      }).select("*");
      return unwrap(result, "record Builder V2 verification defects") || [];
    },
    async startStrategy(row) {
      return unwrap(await client.from("bv2_repair_strategies").insert({
        owner: row.owner, project_id: row.projectId, build_id: row.buildId,
        strategy_id: row.strategyId, sequence: row.sequence,
        targeted_owners: row.targetedOwners || [], targeted_files: row.targetedFiles || [],
        pre_tree_hash: row.preTreeHash, pre_binding_hash: row.preBindingHash || null,
        defect_signature_before: row.defectSignatureBefore,
        settled_recovery_cost: Number(row.settledRecoveryCost || 0),
        outcome: "started", reason: row.reason || null,
      }).select("*").single(), "start Builder V2 repair strategy");
    },
    async finishStrategy(id, patch) {
      return unwrap(await client.from("bv2_repair_strategies").update({
        post_tree_hash: patch.postTreeHash || null,
        post_binding_hash: patch.postBindingHash || null,
        defect_signature_after: patch.defectSignatureAfter || null,
        settled_recovery_cost: Number(patch.settledRecoveryCost || 0),
        outcome: patch.outcome, reason: patch.reason || null,
        completed_at: new Date().toISOString(),
      }).eq("id", id).select("*").single(), "finish Builder V2 repair strategy");
    },
  };
}
