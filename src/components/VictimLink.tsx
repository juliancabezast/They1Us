import Link from "next/link";
import { Icon } from "./ui";

/** The way into the Demo Helpdesk, the deliberately vulnerable app the Breaker is demonstrated against. */
export function VictimLink() {
  return (
    <Link
      href="/victim"
      title="Open the Demo Helpdesk, the deliberately vulnerable app the attack targets"
      className="flex items-center gap-1.5 rounded-lg border border-deny/50 bg-deny/10 px-3 py-2 text-sm font-semibold text-deny transition-colors hover:bg-deny/20"
    >
      <Icon name="alert" className="h-4 w-4" />
      Victim
    </Link>
  );
}
