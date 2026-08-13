import { buildBudgetApprovals } from "../lib/builderV2/buildBudgetApprovals.mjs";
import { startAppBuildV2 } from "../lib/builderV2/entry.mjs";
import { conversationStore } from "../lib/conversationStore.mjs";
import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function handleBuildBudgetApprovalGet(_req, res, { owner, approvalId }) {
  const approval = await buildBudgetApprovals().get(owner.id, approvalId);
  if (!approval) throw new CodeAgentInputError("Build budget approval not found", 404, "approval_not_found");
  const { requestPayload, ...publicResult } = approval;
  void requestPayload;
  return sendJson(res, 200, { approval: publicResult });
}

export async function handleBuildBudgetApprovalResolve(_req, res, { owner, approvalId, action }) {
  const approvals = buildBudgetApprovals();
  const approval = await approvals.resolve(owner.id, approvalId, action);
  if (!approval) throw new CodeAgentInputError("Build budget approval not found", 404, "approval_not_found");
  const store = conversationStore();
  const conversation = await store.getConversation(owner.id, approval.conversationId);
  if (!conversation) throw new CodeAgentInputError("Project conversation not found", 404, "conversation_not_found");
  await store.appendEvent(conversation, "budget_approval_resolved", {
    approvalId: approval.approvalId,
    status: approval.status,
    ceilingCredits: approval.ceilingCredits,
  });
  if (action === "approve" && approval.status === "approved") {
    const ctx = {
      owner: owner.id,
      conversation,
      conversations: store,
      emit: (type, payload) => store.appendEvent(conversation, type, payload),
    };
    const accepted = await startAppBuildV2(ctx, approval.requestPayload, {
      approvalId: approval.approvalId,
      deps: { approvalStore: approvals },
    });
    const { requestPayload, ...publicApproval } = approval;
    void requestPayload;
    return sendJson(res, 202, { approval: { ...publicApproval, status: "consumed" }, build: accepted.result });
  }
  const { requestPayload, ...publicApproval } = approval;
  void requestPayload;
  return sendJson(res, 200, { approval: publicApproval });
}
