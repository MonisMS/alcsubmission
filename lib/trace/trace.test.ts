import { describe, it, expect } from "vitest";
import {
  appendEvent,
  appendToken,
  TRACE_CAP,
  type TraceEntry,
  type TokenGroupEntry,
} from "./trace";

describe("trace — appendToken grouping", () => {
  it("opens a new group for the first token", () => {
    const out = appendToken([], 0, "Hel", 100);
    expect(out).toHaveLength(1);
    const g = out[0] as TokenGroupEntry;
    expect(g.kind).toBe("tokens");
    expect(g.count).toBe(1);
    expect(g.text).toBe("Hel");
    expect(g.startMs).toBe(100);
    expect(g.endMs).toBe(100);
  });

  it("grows the trailing group instead of adding a row", () => {
    let trace: TraceEntry[] = [];
    trace = appendToken(trace, 0, "Hel", 100);
    trace = appendToken(trace, 1, "lo", 150);
    trace = appendToken(trace, 2, " world", 220);
    expect(trace).toHaveLength(1);
    const g = trace[0] as TokenGroupEntry;
    expect(g.count).toBe(3);
    expect(g.text).toBe("Hello world");
    expect(g.startMs).toBe(100); // start is pinned to the first token
    expect(g.endMs).toBe(220); // end tracks the latest
  });

  it("starts a fresh group after a non-token event breaks the run", () => {
    let trace: TraceEntry[] = [];
    trace = appendToken(trace, 0, "before", 100);
    trace = appendEvent(trace, 1, "↓ TOOL_CALL", "search abc", "in");
    trace = appendToken(trace, 2, "after", 200);
    expect(trace).toHaveLength(3);
    expect(trace[0].kind).toBe("tokens");
    expect(trace[1].kind).toBe("event");
    expect(trace[2].kind).toBe("tokens");
    expect((trace[2] as TokenGroupEntry).count).toBe(1);
  });

  it("preserves earlier references when growing the tail", () => {
    let trace: TraceEntry[] = [];
    trace = appendEvent(trace, 0, "● CONNECTED", "", "life");
    trace = appendToken(trace, 1, "a", 100);
    const eventRef = trace[0];
    trace = appendToken(trace, 2, "b", 110);
    expect(trace[0]).toBe(eventRef); // the event row is untouched
  });
});

describe("trace — cap", () => {
  it("keeps only the most recent TRACE_CAP entries", () => {
    let trace: TraceEntry[] = [];
    for (let i = 0; i < TRACE_CAP + 50; i++) {
      // distinct events so none of them group together
      trace = appendEvent(trace, i, `evt ${i}`, "", "in");
    }
    expect(trace).toHaveLength(TRACE_CAP);
    expect(trace[0].id).toBe(50); // the first 50 were trimmed
    expect(trace[trace.length - 1].id).toBe(TRACE_CAP + 49);
  });
});
