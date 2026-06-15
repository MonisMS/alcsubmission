import { describe, it, expect } from "vitest";
import { createReorderBuffer } from "./reorderBuffer";
import type { TokenMessage } from "./types";

// helper: a fake TOKEN with a given seq, so tests read cleanly
const tok = (seq: number): TokenMessage => ({
  type: "TOKEN",
  seq,
  text: `t${seq}`,
  stream_id: "s1",
});

describe("reorderBuffer", () => {
  it("releases an in-order message immediately", () => {
    const buf = createReorderBuffer();
    expect(buf.push(tok(1))).toEqual([tok(1)]);
    expect(buf.frontier).toBe(1);
  });

  it("holds an out-of-order message until the gap fills", () => {
    const buf = createReorderBuffer();
    expect(buf.push(tok(2))).toEqual([]); // nothing yet — waiting for 1
    expect(buf.frontier).toBe(0);
    expect(buf.push(tok(1))).toEqual([tok(1), tok(2)]); // gap filled → both flush
    expect(buf.frontier).toBe(2);
  });

  it("drops a duplicate of an already-released message", () => {
    const buf = createReorderBuffer();
    buf.push(tok(1)); // released, frontier = 1
    expect(buf.push(tok(1))).toEqual([]); // 1 <= frontier → dropped
    expect(buf.frontier).toBe(1);
  });

  it("drops a duplicate that is still waiting in pending", () => {
    const buf = createReorderBuffer();
    buf.push(tok(2)); // parked on the shelf, frontier still 0
    expect(buf.push(tok(2))).toEqual([]); // pending.has(2) → dropped
    expect(buf.frontier).toBe(0);
  });

  it("flushes a fully-reversed burst in order", () => {
    const buf = createReorderBuffer();
    expect(buf.push(tok(3))).toEqual([]);
    expect(buf.push(tok(2))).toEqual([]);
    expect(buf.push(tok(1))).toEqual([tok(1), tok(2), tok(3)]);
    expect(buf.frontier).toBe(3);
  });

  it("a fresh (empty) buffer starts at frontier 0 and holds nothing", () => {
    const buf = createReorderBuffer();
    expect(buf.frontier).toBe(0);
    // first thing it ever sees is the out-of-order seq 5 → parked, nothing released
    expect(buf.push(tok(5))).toEqual([]);
    expect(buf.frontier).toBe(0);
  });

  it("fills a gap mid-stream and flushes the backlog in one burst", () => {
    const buf = createReorderBuffer();
    expect(buf.push(tok(1))).toEqual([tok(1)]); // frontier = 1
    expect(buf.push(tok(3))).toEqual([]); // gap at 2 → park 3
    expect(buf.push(tok(4))).toEqual([]); // still gap at 2 → park 4
    // the missing 2 finally arrives → 2,3,4 all release together, in order
    expect(buf.push(tok(2))).toEqual([tok(2), tok(3), tok(4)]);
    expect(buf.frontier).toBe(4);
  });

  it("reset() clears state for a new turn", () => {
    const buf = createReorderBuffer();
    buf.push(tok(1));
    buf.push(tok(2));
    buf.reset();
    expect(buf.frontier).toBe(0);
    // after reset, seq 1 is treated as brand new again
    expect(buf.push(tok(1))).toEqual([tok(1)]);
  });
});
