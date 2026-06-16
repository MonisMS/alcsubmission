// ─────────────────────────────────────────────────────────────
// Pure JSON diff — powers the Context Inspector (Task 3).
//
// CONTEXT_SNAPSHOTs can be ~500KB and arrive repeatedly; the inspector
// wants to show WHAT CHANGED between the previous and current snapshot
// without re-rendering the whole tree. This produces a structural diff:
// a tree mirroring the JSON, each node tagged added / removed / changed /
// unchanged. The render layer walks it and lazy-expands.
//
// Memory discipline for big payloads: container nodes (objects/arrays we
// recursed into) store ONLY their children, never a copy of the whole
// subtree. Only leaves, and wholly-added/removed subtrees, carry values.
// ─────────────────────────────────────────────────────────────

export type DiffKind = "added" | "removed" | "changed" | "unchanged";

export interface DiffNode {
  kind: DiffKind;
  before?: unknown; // present on changed/removed leaves and removed subtrees
  after?: unknown; // present on changed/unchanged/added leaves and added subtrees
  children?: Record<string, DiffNode>; // present only on recursed containers
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Diff two JSON-ish values. `before === undefined` ⇒ the key didn't exist
// before (added); `after === undefined` ⇒ it's gone now (removed).
export function diffJson(before: unknown, after: unknown): DiffNode {
  const beforeMissing = before === undefined;
  const afterMissing = after === undefined;

  if (beforeMissing && !afterMissing) return { kind: "added", after };
  if (!beforeMissing && afterMissing) return { kind: "removed", before };

  // both objects → recurse over the union of keys
  if (isRecord(before) && isRecord(after)) {
    return diffChildren(Object.keys(before), Object.keys(after), before, after);
  }

  // both arrays → recurse by index (index used as the child key)
  if (Array.isArray(before) && Array.isArray(after)) {
    const keys = (arr: unknown[]) => arr.map((_, i) => String(i));
    // arrays are index-addressable by string key ("0", "1", …); the cast
    // through unknown just tells TS we're treating them as keyed containers.
    const b = before as unknown as Record<string, unknown>;
    const a = after as unknown as Record<string, unknown>;
    return diffChildren(keys(before), keys(after), b, a);
  }

  // primitives, or a type change (object↔array↔primitive): leaf comparison
  if (Object.is(before, after)) return { kind: "unchanged", after };
  return { kind: "changed", before, after };
}

// Shared object/array recursion. Walks the union of keys; a container is
// "changed" if any child is not unchanged, else "unchanged".
function diffChildren(
  beforeKeys: string[],
  afterKeys: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DiffNode {
  const children: Record<string, DiffNode> = {};
  const allKeys = new Set([...beforeKeys, ...afterKeys]);
  let anyChanged = false;

  for (const key of allKeys) {
    const child = diffJson(before[key], after[key]);
    children[key] = child;
    if (child.kind !== "unchanged") anyChanged = true;
  }

  return { kind: anyChanged ? "changed" : "unchanged", children };
}
