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
  DISCONNECTED: { label: "Disconnected", dot: "bg-zinc-500" },
  CONNECTING: { label: "Connecting", dot: "bg-amber-400 animate-pulse" },
  CONNECTED: { label: "Connected", dot: "bg-emerald-500" },
  STREAMING: { label: "Streaming", dot: "bg-emerald-400 animate-pulse" },
  TOOL_CALL_PENDING: { label: "Tool running", dot: "bg-sky-400 animate-pulse" },
  RECONNECTING: { label: "Reconnecting", dot: "bg-amber-500 animate-pulse" },
  RESUMING: { label: "Resuming", dot: "bg-sky-400 animate-pulse" },
};

const EXAMPLES = ["hello", "analyze the data", "show me the schema"];

function StatusPill({ status }: { status: MachineState["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-300">
      <span className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

// Frozen text keeps its ref, so memo skips it. The open tail shows a caret.
const TextBubble = memo(function TextBubble({ seg }: { seg: TextSegment }) {
  return (
    <p className="whitespace-pre-wrap break-words leading-7 text-zinc-100">
      {seg.text}
      {!seg.frozen && (
        <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-emerald-400 align-middle" />
      )}
    </p>
  );
});

const ToolCard = memo(function ToolCard({ seg }: { seg: ToolSegment }) {
  const resolved = seg.status === "resolved";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            resolved ? "bg-emerald-400" : "bg-sky-400 animate-pulse"
          }`}
        />
        <span className="font-mono font-medium text-zinc-200">{seg.tool_name}</span>
        <span className="ml-auto text-xs text-zinc-500">
          {resolved ? "done" : "running…"}
        </span>
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950/50 p-2 text-xs text-zinc-400">
        {JSON.stringify(seg.args, null, 2)}
      </pre>
      {resolved && seg.result && (
        <pre className="mt-2 overflow-x-auto rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2 text-xs text-emerald-300">
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
  const { status, domFrontier, pendingToolCount, model, trace, sendUserMessage } =
    useAgentConsole();
  const [draft, setDraft] = useState("");
  const canSend = status === "CONNECTED";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    sendUserMessage(draft);
    setDraft("");
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-sm text-emerald-400">
          ◆
        </span>
        <h1 className="text-sm font-semibold tracking-tight">Agent Console</h1>
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          {pendingToolCount > 0 && (
            <span className="rounded-full bg-sky-500/10 px-2 py-1 font-mono text-sky-400">
              {pendingToolCount} tool{pendingToolCount > 1 ? "s" : ""} pending
            </span>
          )}
          <span className="font-mono">seq ≤ {domFrontier}</span>
          <StatusPill status={status} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 p-4">
        {/* chat */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
            {model.segments.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <p className="text-sm text-zinc-500">Send a message to start a turn.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => setDraft(ex)}
                      className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 font-mono text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              model.segments.map((seg) => <SegmentView key={seg.id} seg={seg} />)
            )}
          </div>

          <form onSubmit={onSubmit} className="flex gap-2 border-t border-zinc-800 p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={canSend ? "Message the agent…" : STATUS_META[status].label}
              disabled={!canSend}
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!canSend || draft.trim().length === 0}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </section>

        {/* right rail: live timeline + context inspector */}
        <aside className="hidden w-[400px] shrink-0 flex-col gap-4 lg:flex">
          <TracePanel trace={trace} />
          <ContextPanel context={model.context} previousContext={model.previousContext} />
        </aside>
      </div>
    </div>
  );
}
