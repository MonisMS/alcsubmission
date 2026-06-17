"use client";

// Trace panel — a live, ordered log of everything the console did: inbound
// frames (after ordering + dedupe), outbound protocol, and connection-state
// transitions. Reads the trace the hook records, so it doubles as a debugging
// tool in chaos mode: you can watch a drop -> reconnect -> RESUME -> replay.
//
// Consecutive tokens arrive as one grouped row ("Streamed N tokens") that
// expands to the full text, rather than one row per token.

import { memo, useState } from "react";
import type {
  TraceEntry,
  TraceTone,
  TokenGroupEntry,
  EventEntry,
} from "../../hooks/useAgentConsole";

const TONE_STYLE: Record<TraceTone, string> = {
  in: "text-sky-400",
  out: "text-emerald-400",
  life: "text-amber-400",
};

const EventRow = memo(function EventRow({ entry }: { entry: EventEntry }) {
  return (
    <div className="flex gap-2 px-3 py-1 font-mono text-xs leading-5">
      <span className={`w-32 shrink-0 ${TONE_STYLE[entry.tone]}`}>{entry.label}</span>
      <span className="truncate text-zinc-500">{entry.detail}</span>
    </div>
  );
});

const TokenRow = memo(function TokenRow({ entry }: { entry: TokenGroupEntry }) {
  const [open, setOpen] = useState(false);
  const secs = ((entry.endMs - entry.startMs) / 1000).toFixed(1);
  return (
    <div className="font-mono text-xs leading-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-zinc-800/50"
      >
        <span className="w-3 shrink-0 text-zinc-500">{open ? "▾" : "▸"}</span>
        <span className="w-[7.5rem] shrink-0 text-sky-400">↓ tokens</span>
        <span className="text-zinc-400">
          Streamed {entry.count} {entry.count === 1 ? "token" : "tokens"} ({secs}s)
        </span>
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words px-3 pb-2 pl-12 text-zinc-400">
          {entry.text}
        </pre>
      )}
    </div>
  );
});

function TraceRow({ entry }: { entry: TraceEntry }) {
  return entry.kind === "tokens" ? (
    <TokenRow entry={entry} />
  ) : (
    <EventRow entry={entry} />
  );
}

export function TracePanel({ trace }: { trace: TraceEntry[] }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-sm">
        <span className="font-medium text-zinc-200">Timeline</span>
        <span className="ml-auto font-mono text-xs text-zinc-500">{trace.length} events</span>
      </header>
      <div className="flex-1 overflow-auto py-1">
        {trace.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500">No events yet.</p>
        ) : (
          // newest first so the latest activity stays visible
          trace.slice().reverse().map((e) => <TraceRow key={e.id} entry={e} />)
        )}
      </div>
    </section>
  );
}
