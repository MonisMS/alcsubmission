import { describe, it, expect } from "vitest";
import { diffJson, type DiffNode } from "./diff";

const kind = (n: DiffNode | undefined) => n?.kind;

describe("diffJson — leaves", () => {
  it("marks an unchanged primitive", () => {
    expect(diffJson(5, 5)).toEqual({ kind: "unchanged", after: 5 });
  });
  it("marks a changed primitive with before + after", () => {
    expect(diffJson("a", "b")).toEqual({ kind: "changed", before: "a", after: "b" });
  });
  it("treats a missing-before as added", () => {
    expect(diffJson(undefined, 9)).toEqual({ kind: "added", after: 9 });
  });
  it("treats a missing-after as removed", () => {
    expect(diffJson(9, undefined)).toEqual({ kind: "removed", before: 9 });
  });
});

describe("diffJson — objects", () => {
  it("detects an added, a removed, and a changed key", () => {
    const node = diffJson({ keep: 1, drop: 2, edit: 3 }, { keep: 1, edit: 4, fresh: 5 });
    expect(node.kind).toBe("changed");
    expect(kind(node.children?.keep)).toBe("unchanged");
    expect(kind(node.children?.drop)).toBe("removed");
    expect(kind(node.children?.edit)).toBe("changed");
    expect(kind(node.children?.fresh)).toBe("added");
  });

  it("is unchanged when every key is equal", () => {
    const node = diffJson({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } });
    expect(node.kind).toBe("unchanged");
  });

  it("recurses into nested objects and reports the deep change only", () => {
    const node = diffJson({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expect(node.kind).toBe("changed");
    expect(kind(node.children?.a)).toBe("changed");
    expect(kind(node.children?.a.children?.b)).toBe("changed");
    expect(node.children?.a.children?.b.children?.c).toEqual({
      kind: "changed", before: 1, after: 2,
    });
  });
});

describe("diffJson — arrays", () => {
  it("diffs by index and flags appended / changed items", () => {
    const node = diffJson([1, 2], [1, 9, 3]);
    expect(node.kind).toBe("changed");
    expect(kind(node.children?.["0"])).toBe("unchanged");
    expect(kind(node.children?.["1"])).toBe("changed"); // 2 -> 9
    expect(kind(node.children?.["2"])).toBe("added"); // new 3
  });

  it("flags removed trailing items", () => {
    const node = diffJson([1, 2, 3], [1]);
    expect(kind(node.children?.["1"])).toBe("removed");
    expect(kind(node.children?.["2"])).toBe("removed");
  });
});

describe("diffJson — type changes", () => {
  it("treats object↔array as a changed leaf (no false recursion)", () => {
    const node = diffJson({ x: 1 }, [1]);
    expect(node.kind).toBe("changed");
    expect(node.children).toBeUndefined();
    expect(node.before).toEqual({ x: 1 });
    expect(node.after).toEqual([1]);
  });

  it("treats primitive↔object as a changed leaf", () => {
    const node = diffJson(5, { v: 5 });
    expect(node.kind).toBe("changed");
    expect(node.children).toBeUndefined();
  });
});

describe("diffJson — performance smoke (~500KB)", () => {
  it("diffs a large object well under a budget", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i++) {
      big[`key_${i}`] = { id: i, label: `row number ${i}`, tags: [i, i + 1, i + 2] };
    }
    // a shallow copy with a single nested edit
    const after = structuredClone(big);
    (after["key_5000"] as { label: string }).label = "EDITED";

    const start = performance.now();
    const node = diffJson(big, after);
    const elapsed = performance.now() - start;

    expect(node.kind).toBe("changed");
    expect(kind(node.children?.["key_4999"])).toBe("unchanged");
    expect(kind(node.children?.["key_5000"])).toBe("changed");
    expect(elapsed).toBeLessThan(500); // generous CI budget; typically a few ms
  });
});
