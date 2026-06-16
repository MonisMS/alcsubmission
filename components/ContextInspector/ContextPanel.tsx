"use client";

// ─────────────────────────────────────────────────────────────
// Context Inspector (Task 3). Renders the latest CONTEXT_SNAPSHOT as a tree
// and highlights what changed since the previous snapshot using the pure
// diff engine (lib/protocol/diff.ts).
//
// Scale strategy for ~500KB payloads: the tree is LAZY. Unchanged container
// subtrees are collapsed by default (and not rendered until expanded), while
// the path to every change auto-expands — so a mostly-unchanged snapshot shows
// only its deltas, and we never build DOM for the parts nobody is looking at.
// ─────────────────────────────────────────────────────────────

import { memo, useState } from "react";
import { diffJson, type DiffNode } from "../../lib/protocol/diff";
import type { ContextSnapshot } from "../../lib/machine/streamModel";

const KIND_STYLE: Record<DiffNode["kind"], string> = {
  added: "text-emerald-600 dark:text-emerald-400",
  removed: "text-rose-600 line-through dark:text-rose-400",
  changed: "text-amber-600 dark:text-amber-400",
  unchanged: "text-zinc-500 dark:text-zinc-400",
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
  // auto-expand the path to changes; hide unchanged subtrees by default
  const [open, setOpen] = useState(node.kind === "changed" || node.kind === "added");
  const indent = { paddingLeft: `${depth * 14}px` };

  if (!hasChildren) {
    // leaf: show value, and before→after when it changed
    return (
      <div style={indent} className="font-mono text-xs leading-6">
        <span className="text-zinc-400">{label}: </span>
        {node.kind === "changed" ? (
          <span>
            <span className={KIND_STYLE.removed}>{preview(node.before)}</span>
            <span className="text-zinc-400"> → </span>
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
        className="flex w-full items-center gap-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span className="w-3 text-zinc-400">{open ? "▾" : "▸"}</span>
        <span className={KIND_STYLE[node.kind]}>{label}</span>
        <span className="text-zinc-400">{open ? "" : ` ${childKeys.length} keys`}</span>
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
  if (!context) return null;
  // baseline {} on the first snapshot ⇒ everything reads as "added"
  const tree = diffJson(previousContext?.data ?? {}, context.data);
  const approxKB = Math.round(JSON.stringify(context.data).length / 1024);

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">Context</span>
        <span className="font-mono text-xs text-zinc-400">{context.context_id}</span>
        <span className="ml-auto text-xs text-zinc-400">
          ~{approxKB}KB{previousContext ? " · diff vs previous" : " · initial"}
        </span>
      </header>
      <div className="max-h-64 overflow-auto p-2">
        <DiffRow label="(root)" node={tree} depth={0} />
      </div>
    </section>
  );
}
