import { requireOperator } from "@/lib/operator";
import { startWorkflow } from "@/lib/runs";

export const maxDuration = 60;

export async function POST(request: Request) {
  const operator = requireOperator(request);
  if (operator instanceof Response) return operator;
  return Response.json(await startWorkflow(operator));
}
