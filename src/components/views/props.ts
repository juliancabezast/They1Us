import type { DashboardState } from "@/lib/types";

export interface ViewProps {
  state: DashboardState;
  live: boolean;
  busy: string | null;
  onDecide: (id: string, action: "approve" | "reject") => void;
  onRunAttack: () => void;
  onRunWorkflow: () => void;
}
