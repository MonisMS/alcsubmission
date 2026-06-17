"use client";

// The render layer. Reads a clean view-model from useAgentConsole and knows
// nothing about sockets, seq, or reconnection. Segment components are memoized
// and keyed by their stable `id`; since frozen segments keep a stable object
// reference, memo short-circuits them and only the growing tail repaints.

import { memo, useState, type FormEvent } from "react";
import { useAgentConsole } from "../hooks/useAgentConsole";
import { ContextPanel } from "./ContextInspector/ContextPanel";
import { TracePanel } from "./Timeline/TracePanel";
import type {
  Segment,
  TextSegment,
  ToolSegment,
} from "../lib/machine/streamModel";
import type { MachineState } from "../lib/machine/connectionMachine";

// status -> label + colour for the indicator pill
const STATUS_META: Record<MachineState["status"], { label: string; dot: string }> = {
  DISCONNECTED: { label: "Disconnected", dot: "bg-zinc-400" },
  CONNECTING: { label: "Connecting…", dot: "bg-amber-400 animate-pulse" },
  CONNECTED: { label: "Connected", dot: "bg-emerald-500" },
  STREAMING: { label: "Streaming", dot: "bg-emerald-500 animate-pulse" },
  TOOL_CALL_PENDING: { label: "Tool running…", dot: "bg-sky-500 animate-pulse" },
  RECONNECTING: { label: "Reconnecting…", dot: "bg-amber-500 animate-pulse" },
  RESUMING: { label: "Resuming…", dot: "bg-sky-400 animate-pulse" },
};

function ConnectionIndicator({
  status,
  domFrontier,
}: {
  status: MachineState["status"];
  domFrontier: number;
}) {
  const meta = STATUS_META[status];
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${meta.dot}`} />
      <span className="font-medium">{meta.label}</span>
      <span className="ml-auto font-mono text-xs text-zinc-400">
        seq ≤ {domFrontier}
      </span>
    </div>
  );
}

// Frozen text keeps its ref, so memo skips it. The open tail shows a caret.
const TextBubble = memo(function TextBubble({ seg }: { seg: TextSegment }) {
  return (
    <p className="whitespace-pre-wrap break-words leading-7 text-zinc-800 dark:text-zinc-100">
      {seg.text}
      {!seg.frozen && (
        <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-emerald-500" />
      )}
    </p>
  );
});

const ToolCard = memo(function ToolCard({ seg }: { seg: ToolSegment }) {
  const resolved = seg.status === "resolved";
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            resolved ? "bg-emerald-500" : "bg-sky-500 animate-pulse"
          }`}
        />
        <span className="font-mono font-medium text-zinc-700 dark:text-zinc-200">
          {seg.tool_name}
        </span>
        <span className="text-xs text-zinc-400">
          {resolved ? "done" : "running…"}
        </span>
      </div>
      <pre className="mt-2 overflow-x-auto text-xs text-zinc-500">
        {JSON.stringify(seg.args, null, 2)}
      </pre>
      {resolved && seg.result && (
        <pre className="mt-1 overflow-x-auto border-t border-zinc-200 pt-1 text-xs text-emerald-700 dark:border-zinc-700 dark:text-emerald-400">
          {JSON.stringify(seg.result, null, 2)}
        </pre>
      )}
    </div>
  );
});

function SegmentView({ seg }: { seg: Segment }) {
  return seg.kind === "text" ? <TextBubble seg={seg} /> : <ToolCard seg={seg} />;
}

export function Console() {
  const { status, domFrontier, model, trace, sendUserMessage } = useAgentConsole();
  const [draft, setDraft] = useState("");
  const canSend = status === "CONNECTED";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    sendUserMessage(draft);
    setDraft("");
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-5xl gap-4 p-4">
      {/* chat column */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="border-b border-zinc-200 pb-3 dark:border-zinc-800">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Agent Console
          </h1>
          <div className="mt-1">
            <ConnectionIndicator status={status} domFrontier={domFrontier} />
          </div>
        </header>

        <main className="flex flex-1 flex-col gap-3 overflow-y-auto">
          {model.segments.length === 0 ? (
            <p className="text-sm text-zinc-400">
              Send a message to start a turn. Try <code>hello</code>,{" "}
              <code>analyze the data</code>, or <code>show me the schema</code>.
            </p>
          ) : (
            model.segments.map((seg) => <SegmentView key={seg.id} seg={seg} />)
          )}
          <ContextPanel context={model.context} previousContext={model.previousContext} />
        </main>

        <form onSubmit={onSubmit} className="flex gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={canSend ? "Message the agent…" : `${STATUS_META[status].label}`}
            disabled={!canSend}
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={!canSend || draft.trim().length === 0}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>

      {/* right rail: live timeline */}
      <aside className="hidden w-80 shrink-0 flex-col lg:flex">
        <TracePanel trace={trace} />
      </aside>
    </div>
  );
}
