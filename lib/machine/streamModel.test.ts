import { describe, it, expect } from "vitest";
import {
  applyMessage,
  buildModel,
  emptyModel,
  type ChatModel,
  type TextSegment,
  type ToolSegment,
} from "./streamModel";
import type { ServerMessage } from "../protocol/types";

const token = (text: string, seq = 1): ServerMessage => ({ type: "TOKEN", seq, text, stream_id: "s1" });
const toolCall = (call_id: string, seq = 1): ServerMessage => ({
  type: "TOOL_CALL", seq, call_id, tool_name: "search", args: { q: "x" }, stream_id: "s1",
});
const toolResult = (call_id: string, seq = 2): ServerMessage => ({
  type: "TOOL_RESULT", seq, call_id, result: { ok: true }, stream_id: "s1",
});
const ctx = (seq = 1): ServerMessage => ({
  type: "CONTEXT_SNAPSHOT", seq, context_id: "c1", data: { rows: 3 },
});
const end = (seq = 9): ServerMessage => ({ type: "STREAM_END", seq, stream_id: "s1" });

// fold helper
const fold = (msgs: ServerMessage[]): ChatModel => buildModel(msgs);
const asText = (s: ChatModel["segments"][number]) => s as TextSegment;
const asTool = (s: ChatModel["segments"][number]) => s as ToolSegment;

describe("streamModel — text", () => {
  it("concatenates consecutive tokens into one open segment", () => {
    const m = fold([token("Hel"), token("lo "), token("there")]);
    expect(m.segments).toHaveLength(1);
    expect(asText(m.segments[0]).text).toBe("Hello there");
    expect(asText(m.segments[0]).frozen).toBe(false);
  });
});

describe("streamModel — tool freeze / resume", () => {
  it("a tool call freezes the prior text and adds a pending card", () => {
    const m = fold([token("thinking "), toolCall("tc_1")]);
    expect(m.segments).toHaveLength(2);
    expect(asText(m.segments[0]).frozen).toBe(true); // frozen at the boundary
    expect(asTool(m.segments[1]).status).toBe("pending");
    expect(asTool(m.segments[1]).call_id).toBe("tc_1");
  });

  it("a tool result resolves the matching card by call_id", () => {
    const m = fold([toolCall("tc_1"), toolResult("tc_1")]);
    const card = asTool(m.segments[0]);
    expect(card.status).toBe("resolved");
    expect(card.result).toEqual({ ok: true });
  });

  it("tokens after a resolved tool open a NEW segment — no dup, no reflow", () => {
    const m = fold([token("before "), toolCall("tc_1"), toolResult("tc_1"), token("after")]);
    expect(m.segments).toHaveLength(3);
    expect(asText(m.segments[0]).text).toBe("before ");
    expect(asText(m.segments[0]).frozen).toBe(true);
    expect(m.segments[1].kind).toBe("tool");
    expect(asText(m.segments[2]).text).toBe("after"); // brand-new run, NOT "before after"
    expect(asText(m.segments[2]).frozen).toBe(false);
  });
});

describe("streamModel — stacked tools", () => {
  it("two tool calls before any result stack as two pending cards", () => {
    const m = fold([toolCall("tc_1"), toolCall("tc_2")]);
    expect(m.segments).toHaveLength(2);
    expect(asTool(m.segments[0]).status).toBe("pending");
    expect(asTool(m.segments[1]).status).toBe("pending");
  });

  it("each result resolves its own card independently by call_id", () => {
    const m = fold([toolCall("tc_1"), toolCall("tc_2"), toolResult("tc_2"), toolResult("tc_1")]);
    expect(asTool(m.segments[0]).status).toBe("resolved"); // tc_1
    expect(asTool(m.segments[1]).status).toBe("resolved"); // tc_2
  });

  it("a result for an unknown call_id is a no-op and returns the same reference", () => {
    const base = fold([toolCall("tc_1")]);
    const after = applyMessage(base, toolResult("ghost"));
    expect(after).toBe(base); // identical reference — idempotent
  });
});

describe("streamModel — context + end", () => {
  it("stores the latest context snapshot", () => {
    const m = fold([token("hi"), ctx()]);
    expect(m.context).toEqual({ context_id: "c1", data: { rows: 3 } });
    expect(m.previousContext).toBeNull();
  });

  it("keeps the prior snapshot as previousContext so they can be diffed", () => {
    const first: ServerMessage = { type: "CONTEXT_SNAPSHOT", seq: 1, context_id: "c1", data: { rows: 3 } };
    const second: ServerMessage = { type: "CONTEXT_SNAPSHOT", seq: 2, context_id: "c2", data: { rows: 4 } };
    const m = fold([first, second]);
    expect(m.context).toEqual({ context_id: "c2", data: { rows: 4 } });
    expect(m.previousContext).toEqual({ context_id: "c1", data: { rows: 3 } });
  });

  it("STREAM_END freezes the open text and marks the turn ended", () => {
    const m = fold([token("done"), end()]);
    expect(m.ended).toBe(true);
    expect(asText(m.segments[0]).frozen).toBe(true);
  });
});

describe("streamModel — reference stability (the anti-reflow guarantee)", () => {
  it("appending a token keeps every earlier segment reference identical", () => {
    // freeze a text segment + a tool card, then grow a new tail segment
    const before = fold([token("intro "), toolCall("tc_1"), toolResult("tc_1"), token("a")]);
    const after = applyMessage(before, token("b"));

    // tail grew "a" -> "ab"
    expect(asText(after.segments[2]).text).toBe("ab");
    // ...but the frozen text segment and the tool card are the SAME objects.
    // React will skip re-rendering them → no flicker, no reflow.
    expect(after.segments[0]).toBe(before.segments[0]);
    expect(after.segments[1]).toBe(before.segments[1]);
    // and the tail is a new object (it changed)
    expect(after.segments[2]).not.toBe(before.segments[2]);
  });
});

describe("streamModel — buildModel == live apply (resume parity)", () => {
  it("folding history yields the same model as applying one-by-one", () => {
    const history: ServerMessage[] = [token("x "), toolCall("tc_1"), toolResult("tc_1"), token("y")];
    const folded = buildModel(history);
    const stepped = history.reduce((m, msg) => applyMessage(m, msg), emptyModel);
    expect(folded).toEqual(stepped);
  });
});
