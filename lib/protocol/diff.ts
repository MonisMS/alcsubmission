// Pure structural JSON diff for the Context Inspector. Produces a tree
// mirroring the JSON, each node tagged added/removed/changed/unchanged, which
// the render layer walks and lazy-expands. Container nodes store only their
// children, never a copy of the subtree, so large payloads stay cheap.

export type DiffKind = "added" | "removed" | "changed" | "unchanged";

export interface DiffNode {
  kind: DiffKind;
  before?: unknown; // changed/removed leaves and removed subtrees
  after?: unknown; // changed/unchanged/added leaves and added subtrees
  children?: Record<string, DiffNode>; // only on recursed containers
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// before === undefined => the key is new (added); after === undefined => gone (removed).
export function diffJson(before: unknown, after: unknown): DiffNode {
  const beforeMissing = before === undefined;
  const afterMissing = after === undefined;

  if (beforeMissing && !afterMissing) return { kind: "added", after };
  if (!beforeMissing && afterMissing) return { kind: "removed", before };

  if (isRecord(before) && isRecord(after)) {
    return diffChildren(Object.keys(before), Object.keys(after), before, after);
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Treat arrays as containers keyed by stringified index ("0", "1", ...).
    const keys = (arr: unknown[]) => arr.map((_, i) => String(i));
    const b = before as unknown as Record<string, unknown>;
    const a = after as unknown as Record<string, unknown>;
    return diffChildren(keys(before), keys(after), b, a);
  }

  // Primitives or a type change (object<->array<->primitive): leaf comparison.
  if (Object.is(before, after)) return { kind: "unchanged", after };
  return { kind: "changed", before, after };
}

// Walks the union of keys; a container is "changed" if any child changed.
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
