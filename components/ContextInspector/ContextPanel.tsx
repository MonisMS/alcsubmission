"use client";

// Context inspector. Renders the latest CONTEXT_SNAPSHOT as a tree and
// highlights what changed since the previous snapshot via the diff engine.
// The tree is lazy: unchanged container subtrees stay collapsed (and aren't
// rendered until expanded) while the path to each change auto-expands, so a
// half-megabyte snapshot only builds DOM for the deltas you're looking at.

import { memo, useState } from "react";
import { diffJson, type DiffNode } from "../../lib/protocol/diff";
import type { ContextSnapshot } from "../../lib/machine/streamModel";

const KIND_STYLE: Record<DiffNode["kind"], string> = {
  added: "text-emerald-400",
  removed: "text-rose-400 line-through",
  changed: "text-amber-400",
  unchanged: "text-zinc-400",
};

function preview(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[ ${value.length} ]`;
  return `{ ${Object.keys(value as object).length} }`;
}

const DiffRow = memo(function DiffRow({
  label,
  node,
  depth,
}: {
  label: string;
  node: DiffNode;
  depth: number;
}) {
  const hasChildren = node.children !== undefined;
  // Auto-expand the path to changes; keep unchanged subtrees collapsed.
  const [open, setOpen] = useState(node.kind === "changed" || node.kind === "added");
  const indent = { paddingLeft: `${depth * 14}px` };

  if (!hasChildren) {
    // Leaf: show the value, and before -> after when it changed.
    return (
      <div style={indent} className="font-mono text-xs leading-6">
        <span className="text-zinc-500">{label}: </span>
        {node.kind === "changed" ? (
          <span>
            <span className={KIND_STYLE.removed}>{preview(node.before)}</span>
            <span className="text-zinc-600"> → </span>
            <span className={KIND_STYLE.added}>{preview(node.after)}</span>
          </span>
        ) : (
          <span className={KIND_STYLE[node.kind]}>
            {preview(node.kind === "removed" ? node.before : node.after)}
          </span>
        )}
      </div>
    );
  }

  const childKeys = Object.keys(node.children!);
  return (
    <div className="font-mono text-xs leading-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={indent}
        className="flex w-full items-center gap-1 text-left hover:bg-zinc-800/60"
      >
        <span className="w-3 text-zinc-500">{open ? "▾" : "▸"}</span>
        <span className={KIND_STYLE[node.kind]}>{label}</span>
        <span className="text-zinc-600">{open ? "" : ` ${childKeys.length} keys`}</span>
      </button>
      {open &&
        childKeys.map((k) => (
          <DiffRow key={k} label={k} node={node.children![k]} depth={depth + 1} />
        ))}
    </div>
  );
});

export function ContextPanel({
  context,
  previousContext,
}: {
  context: ContextSnapshot | null;
  previousContext: ContextSnapshot | null;
}) {
  // Baseline against {} on the first snapshot, so everything reads as "added".
  const tree = context ? diffJson(previousContext?.data ?? {}, context.data) : null;
  const approxKB = context
    ? Math.round(JSON.stringify(context.data).length / 1024)
    : 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-sm">
        <span className="font-medium text-zinc-200">Context</span>
        {context && (
          <span className="truncate font-mono text-xs text-zinc-500">{context.context_id}</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-zinc-500">
          {context
            ? `~${approxKB}KB${previousContext ? " · diff" : " · initial"}`
            : "waiting"}
        </span>
      </header>
      <div className="flex-1 overflow-auto p-2">
        {tree ? (
          <DiffRow label="(root)" node={tree} depth={0} />
        ) : (
          <p className="px-2 py-2 text-xs text-zinc-500">No snapshot yet.</p>
        )}
      </div>
    </section>
  );
}
