// The helpdesk form and the agent console are public in the demo. Each visitor gets a small budget of
// their own, and a ceiling over all visitors stays as the backstop: one client that spends its budget
// is refused without taking anything from the others.

export interface VisitorLimiter {
  /** true and counted when both this visitor and the site are under their limits; false and not counted otherwise. */
  take(visitor: string, now?: number): boolean;
}

export function createVisitorLimiter(perVisitor: number, total: number, windowMs = 60_000): VisitorLimiter {
  const all: number[] = [];
  const byVisitor = new Map<string, number[]>();
  const prune = (taken: number[], now: number) => {
    while (taken.length && taken[0] <= now - windowMs) taken.shift();
  };
  return {
    take(visitor, now = Date.now()) {
      prune(all, now);
      // At most `total` visitors are counted in a window: forget the idle ones before the map grows.
      if (byVisitor.size > total * 2) {
        for (const [key, taken] of byVisitor) {
          prune(taken, now);
          if (!taken.length) byVisitor.delete(key);
        }
      }
      const mine = byVisitor.get(visitor) ?? [];
      prune(mine, now);
      if (mine.length >= perVisitor || all.length >= total) return false;
      mine.push(now);
      all.push(now);
      byVisitor.set(visitor, mine);
      return true;
    },
  };
}

/**
 * Who is asking, for the limits only: the client address the hosting platform puts in x-forwarded-for
 * (Vercel overwrites the header, so a visitor cannot choose it). Without a proxy every request is one visitor.
 */
export function visitorKey(headers: Headers): string {
  const address = headers.get("x-forwarded-for")?.split(",")[0].trim() || headers.get("x-real-ip")?.trim() || "direct";
  return address.slice(0, 64);
}

// On globalThis, like the pools: hot reload must not hand out a fresh budget.
const globals = globalThis as unknown as { victimRunBudget?: VisitorLimiter; victimTicketBudget?: VisitorLimiter };

/** Agent runs per minute: 6 per visitor, 20 in all. */
export const runBudget = globals.victimRunBudget ?? (globals.victimRunBudget = createVisitorLimiter(6, 20));

/** Tickets filed per minute: 5 per visitor, 30 in all. */
export const ticketBudget = globals.victimTicketBudget ?? (globals.victimTicketBudget = createVisitorLimiter(5, 30));
