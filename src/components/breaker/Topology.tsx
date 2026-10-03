// Redrawn in English from the Victim_Web project's docs/architecture.svg, on the dashboard's theme colours.

type Owner = "company" | "breaker" | "external";

const COLOR: Record<Owner, string> = {
  company: "var(--secret)",
  breaker: "var(--brand)",
  external: "var(--muted)",
};

const wash = (owner: Owner) => `color-mix(in srgb, ${COLOR[owner]} 14%, transparent)`;

const TEXT = { fill: "var(--text)" };
const MUTED = { fill: "var(--muted)" };

interface Node {
  owner: Owner;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** One entry per line. */
  sub: string[];
  /** The original draws the company database with a heavier outline. */
  strong?: boolean;
}

const NODES: Node[] = [
  { owner: "external", x: 40, y: 40, w: 170, h: 48, title: "Customer / attacker", sub: ["External user"] },
  { owner: "company", x: 40, y: 150, w: 180, h: 66, title: "Helpdesk app", sub: ["Next.js: ticket form", "and ticket page"] },
  { owner: "company", x: 40, y: 262, w: 180, h: 56, title: "AI agent", sub: ["execute_sql tool"] },
  { owner: "breaker", x: 460, y: 205, w: 185, h: 52, title: "Breaker DB", sub: ["Sessions and decision log"] },
  { owner: "breaker", x: 460, y: 320, w: 185, h: 56, title: "Breaker service", sub: ["Vercel: checkpoint (proxy)"] },
  { owner: "company", x: 250, y: 400, w: 200, h: 58, title: "Company DB", sub: ["Supabase, owned by the company"], strong: true },
];

const ZONES: { owner: Owner; x: number; y: number; w: number; h: number; label: string }[] = [
  { owner: "company", x: 22, y: 120, w: 218, h: 216, label: "Service company" },
  { owner: "breaker", x: 444, y: 180, w: 212, h: 216, label: "Trifecta Breaker" },
];

/** Each arrow stops just short of the box it points at, so nothing shows through the translucent fills. */
const FLOWS: { d: string; x: number; y: number; label: string }[] = [
  { d: "M170,88 L170,148", x: 186, y: 106, label: "Ticket submitted" },
  { d: "M205,216 L304,398", x: 96, y: 370, label: "Tickets read and written" },
  { d: "M220,290 L458,347.5", x: 266, y: 286, label: "SQL request (/execute)" },
  { d: "M490,376 L490,429 L453,429", x: 508, y: 412, label: "Only allowed SQL runs" },
  { d: "M490,320 L490,260", x: 508, y: 290, label: "Stamps recorded" },
];

const LEGEND: { owner: Owner; label: string }[] = [
  { owner: "company", label: "Owned by the service company" },
  { owner: "breaker", label: "Owned by Trifecta Breaker" },
  { owner: "external", label: "External user" },
];

/** Who owns what, and the five steps a ticket takes, with the Breaker connected. */
export function Topology() {
  return (
    <svg
      viewBox="0 0 680 492"
      width="100%"
      role="img"
      aria-labelledby="topology-title topology-desc"
      style={{ display: "block", height: "auto" }}
    >
      <title id="topology-title">Architecture: Breaker connected (ON)</title>
      <desc id="topology-desc">
        A customer or attacker submits a ticket to the service company&apos;s helpdesk app, which reads and writes tickets in the company
        database. The company&apos;s AI agent sends its SQL requests to the Breaker service, which runs only the allowed SQL on the company
        database and records stamps in the Breaker&apos;s own database. The Breaker does not own or copy the company database.
      </desc>
      <defs>
        <marker id="topology-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--muted)" }} />
        </marker>
      </defs>

      <text x="30" y="26" fontSize="16" fontWeight="600" style={TEXT}>
        Architecture: Breaker connected (ON)
      </text>

      {ZONES.map((z) => (
        <g key={z.label}>
          <rect x={z.x} y={z.y} width={z.w} height={z.h} rx="12" fill="none" strokeWidth="1" strokeDasharray="5 4" style={{ stroke: COLOR[z.owner] }} />
          <text x={z.x + 10} y={z.y + 18} fontSize="12" style={TEXT}>
            {z.label}
          </text>
        </g>
      ))}

      {LEGEND.map((l, i) => (
        <g key={l.label}>
          <rect x="470" y={46 + i * 24} width="14" height="14" rx="3" strokeWidth="1" style={{ fill: wash(l.owner), stroke: COLOR[l.owner] }} />
          <text x="490" y={57 + i * 24} fontSize="11.5" style={TEXT}>
            {l.label}
          </text>
        </g>
      ))}

      {FLOWS.map((f, i) => (
        <g key={f.label}>
          <path d={f.d} fill="none" strokeWidth="1.5" markerEnd="url(#topology-arrow)" style={{ stroke: "var(--muted)" }} />
          <circle cx={f.x} cy={f.y} r="8" style={MUTED} />
          <text x={f.x} y={f.y + 3.5} fontSize="10" fontWeight="600" textAnchor="middle" style={{ fill: "var(--panel)" }}>
            {i + 1}
          </text>
          <text x={f.x + 13} y={f.y + 4} fontSize="12" style={MUTED}>
            {f.label}
          </text>
        </g>
      ))}

      {NODES.map((n) => {
        const cx = n.x + n.w / 2;
        // The title's baseline sits on the middle of the box, moved up for every extra subtitle line.
        const titleY = n.y + (n.h - (n.sub.length - 1) * 14) / 2;
        return (
          <g key={n.title}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="10" strokeWidth={n.strong ? 1.5 : 1} style={{ fill: wash(n.owner), stroke: COLOR[n.owner] }} />
            <text x={cx} y={titleY} fontSize="14" fontWeight="600" textAnchor="middle" style={TEXT}>
              {n.title}
            </text>
            {n.sub.map((line, i) => (
              <text key={line} x={cx} y={titleY + 17 + i * 14} fontSize="11.5" textAnchor="middle" style={MUTED}>
                {line}
              </text>
            ))}
          </g>
        );
      })}

      <text x="350" y="478" fontSize="11.5" textAnchor="middle" style={MUTED}>
        The Breaker does not own or copy this database. It only connects to it.
      </text>
    </svg>
  );
}
