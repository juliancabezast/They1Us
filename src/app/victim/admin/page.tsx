import { liveAvailable } from "@/lib/victim/agent";
import AdminConsole from "./AdminConsole";

export const metadata = { title: "Agent console · Demo Helpdesk" };
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <>
      <p className="eyebrow">Internal</p>
      <h1>AI agent console</h1>
      <p className="lead" style={{ maxWidth: 640 }}>
        Triage incoming tickets with the support AI. The agent has SQL access to the support database. Toggle Trifecta Breaker to compare
        the unprotected and protected runs.
      </p>
      <AdminConsole liveAvailable={liveAvailable()} />
    </>
  );
}
