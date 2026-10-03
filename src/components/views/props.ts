import type { DashboardState } from "@/lib/types";

/** How the page and the Live demo on Overview talk to each other. State lives in the page. */
export interface DemoLink {
  /** The floating button on another view asked for a run. */
  pending: boolean;
  onTaken: () => void;
  /** Focus mode: the rest of the page is dimmed while the demo plays. */
  focus: boolean;
  onFocus: (on: boolean) => void;
  /** The run cleared and rewrote the demo data: reload the dashboard state. */
  onData: () => void;
}

export interface ViewProps {
  state: DashboardState;
  live: boolean;
  busy: string | null;
  onDecide: (id: string, action: "approve" | "reject") => void;
  onRunAttack: () => void;
  onRunWorkflow: () => void;
  demo: DemoLink;
}
