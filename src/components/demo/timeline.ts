import type { EventRow, TicketRow } from "@/lib/types";
import type { HopState } from "../tour/Stage";

/** What POST /api/demo/run answers, once per mode. */
export interface Replay {
  contextId: string;
  events: EventRow[];
  ticket: TicketRow;
}
export interface Replays {
  off: Replay;
  on: Replay;
}

export const CHAPTERS = ["Ticket", "Leak", "Breaker", "Contained"] as const;

export interface Beat {
  chapter: number;
  /** The one line the narrator says while this beat is on screen. */
  line: string;
  /** Which of the two runs is on screen, and how many of its operations have been revealed. */
  run: "off" | "on" | null;
  ops: number;
}

// The whole demo is this list. Everything on screen is derived from the index into it,
// so Back, Next and the chapter chips land on exactly the same picture every time.
export const BEATS: Beat[] = [
  { chapter: 0, run: null, ops: 0, line: "A stranger files a support ticket. Anyone can." },
  { chapter: 0, run: null, ops: 0, line: "Hidden inside the ticket: instructions aimed at the agent, not at a human." },
  { chapter: 1, run: "off", ops: 1, line: "The agent reads the tickets. The hidden instruction comes along." },
  { chapter: 1, run: "off", ops: 2, line: "It obeys: it reads the integration token." },
  { chapter: 1, run: "off", ops: 3, line: "It writes the token into the reply. The attacker just reads their own ticket." },
  { chapter: 1, run: "off", ops: 3, line: "Nothing was hacked. The agent was simply allowed to hold both things at once." },
  { chapter: 2, run: "on", ops: 0, line: "Same ticket, same agent, same three operations. This time through the Breaker." },
  { chapter: 2, run: "on", ops: 1, line: "The read is allowed, and the context is now marked: it holds untrusted content." },
  { chapter: 2, run: "on", ops: 2, line: "Blocked. A context that holds untrusted content cannot read a secret." },
  { chapter: 2, run: "on", ops: 3, line: "The reply waits for a human to approve the exact text. Nothing leaves." },
  { chapter: 3, run: "on", ops: 3, line: "The injection still happened. The leak did not." },
];

export const LAST = BEATS.length - 1;
/** Beats 1 and 2 only need the ticket; from here on the two replays must be in memory. */
export const FIRST_DATA_BEAT = BEATS.findIndex((b) => b.run !== null);
export const INJECTION_BEAT = 1;
export const LEAK_BEAT = 5;
export const BREAKER_BEAT = 6;

export const chapterStart = (chapter: number) => BEATS.findIndex((b) => b.chapter === chapter);

/** Reading time: a base to look at the diagram, plus time per character, within sane limits. */
export const holdMs = (line: string) => Math.min(9000, Math.max(4500, 2400 + 55 * line.length));

export const TOTAL_SECONDS = Math.round(BEATS.reduce((sum, b) => sum + holdMs(b.line), 0) / 1000);

const hopOf = (e: EventRow | undefined): HopState =>
  !e ? "idle" : e.decision === "DENIED" ? "denied" : e.decision === "APPROVAL_REQUIRED" ? "held" : "open";

export interface Scene {
  beat: Beat;
  /** The three operations of the run on screen (empty until the replays arrive). */
  events: EventRow[];
  hops: HopState[];
  submitted: boolean;
  /** The token is on the attacker's screen. */
  leaked: boolean;
  token: string | null;
  contained: boolean;
  breakerOn: boolean;
}

/** The picture of one beat. Pure: the same index and the same replays always give the same scene. */
export function sceneAt(index: number, started: boolean, data: Replays | null): Scene {
  const beat = BEATS[index];
  const run = beat.run && data ? data[beat.run] : null;
  const events = run ? run.events.slice(0, 3) : [];
  const reply = beat.run === "off" && beat.ops >= 3 ? (run?.ticket.reply ?? null) : null;
  return {
    beat,
    events,
    hops: [0, 1, 2].map((i) => (i < beat.ops ? hopOf(events[i]) : "idle")),
    submitted: started,
    leaked: Boolean(reply),
    token: index >= LEAK_BEAT ? reply : null,
    contained: index === LAST && run !== null,
    breakerOn: index >= BREAKER_BEAT,
  };
}

/** Never trust the shape of a response just because the status was 200. */
export function isReplays(body: unknown): body is Replays {
  const ok = (r: unknown) => {
    const replay = r as Partial<Replay> | null;
    return Boolean(replay && Array.isArray(replay.events) && replay.events.length >= 3 && replay.ticket);
  };
  const b = body as Partial<Replays> | null;
  return Boolean(b && ok(b.off) && ok(b.on));
}
