import { decideApproval } from "@/lib/gateway";
import { requireOperator } from "@/lib/operator";
import { REASONS } from "@/lib/policy";
import { resumeWorkflow } from "@/lib/runs";

export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const operator = requireOperator(request);
  if (operator instanceof Response) return operator;
  const { id } = await params;
  const { action } = await request.json().catch(() => ({}));
  if (action !== "approve" && action !== "reject") return Response.json({ error: "action must be approve or reject" }, { status: 400 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Unknown approval." }, { status: 404 });

  const decided = await decideApproval(operator, id, action);
  if (!decided.ok) return Response.json({ error: REASONS[decided.reason] }, { status: 409 });
  // Once approved, the agent retries the same publish. It still goes through the gateway.
  const published = action === "approve" ? await resumeWorkflow(id) : null;
  return Response.json({ status: decided.status, published: published?.executionResult ?? null });
}
