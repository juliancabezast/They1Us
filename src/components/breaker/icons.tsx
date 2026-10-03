// The two marks the shared Icon set does not have. Same stroke language, decorative only.

const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function DatabaseIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg {...stroke} className={className}>
      <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  );
}

export function AgentIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg {...stroke} className={className}>
      <path d="M12 3v4M7 7h10a2 2 0 012 2v8a2 2 0 01-2 2H7a2 2 0 01-2-2V9a2 2 0 012-2zM9.5 12v2M14.5 12v2M2.5 12v3M21.5 12v3" />
    </svg>
  );
}
