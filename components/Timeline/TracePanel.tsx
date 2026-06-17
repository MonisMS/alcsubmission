"use client";

// Trace panel — a live, ordered log of everything the console did: inbound
// frames (after ordering + dedupe), outbound protocol, and connection-state
// transitions. Reads the trace the hook records, so it doubles as a debugging
// tool in chaos mode: you can watch a drop -> reconnect -> RESUME -> replay.

import { memo } from "react";
import type { TraceEntry, TraceTone } from "../../hooks/useAgentConsole";

const TONE_STYLE: Record<TraceTone, string> = {
  in: "text-sky-600 dark:text-sky-400",
  out: "text-emerald-600 dark:text-emerald-400",
  life: "text-amber-600 dark:text-amber-400",
};

const TraceRow = memo(function TraceRow({ entry }: { entry: TraceEntry }) {
  return (
    <div className="flex gap-2 px-2 py-0.5 font-mono text-xs leading-5">
      <span className={`w-32 shrink-0 ${TONE_STYLE[entry.tone]}`}>{entry.label}</span>
      <span className="truncate text-zinc-500">{entry.detail}</span>
    </div>
  );
});

export function TracePanel({ trace }: { trace: TraceEntry[] }) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-zinc-200 dark:border-zinc-800">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">Timeline</span>
        <span className="ml-auto font-mono text-xs text-zinc-400">{trace.length} events</span>
      </header>
      <div className="flex-1 overflow-auto py-1">
        {trace.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-400">No events yet.</p>
        ) : (
          // newest first so the latest activity stays visible
          trace.slice().reverse().map((e) => <TraceRow key={e.id} entry={e} />)
        )}
      </div>
    </section>
  );
}
