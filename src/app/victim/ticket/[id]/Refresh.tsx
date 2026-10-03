"use client";

import { useRouter } from "next/navigation";

/** Fetches the ticket again, so the latest reply is always the one on screen. */
export function Refresh() {
  const router = useRouter();
  return (
    <button type="button" className="linklike" onClick={() => router.refresh()}>
      Refresh
    </button>
  );
}
