# Engineering Decisions

> Why the Agent Console is built the way it is. Each entry states the problem,
> the decision, and the trade-off. Written alongside the code, not after.

The console is split into four strictly-separated layers, each ignorant of the
ones above it:

```
L4 RENDER (React)      components/Console.tsx        — clean view-model only
L3 CONTROLLER (FSM)    lib/machine/connectionMachine — pure reduce(state,event)→[state,Command[]]
L2 PROTOCOL (pure)     lib/protocol/* , streamModel  — reorder, dedupe, diff, segment model
L1 TRANSPORT (WS)      lib/transport/*               — raw socket, parse-guard, backoff math
```

The whole of L2 + L3 is pure and unit-tested (60 tests, no DOM, no socket).
That is deliberate: the parts most likely to be wrong are the parts most easily
proven right.

---

## 1. Sequence ordering & de-duplication

**Problem.** In chaos mode the server reorders (size-4 shuffle), duplicates
(exact same-`seq` twin, non-adjacent), and the `STREAM_END` can arrive before
earlier tokens. The renderer must only ever see a gapless, in-order, dup-free
stream.

**Decision.** A `Map<seq, ServerMessage>` "waiting room" plus a single integer
`frontier` (`lib/protocol/reorderBuffer.ts`). On every frame:

1. **Dedupe** — drop if `seq <= frontier` (already released) **or**
   `pending.has(seq)` (already waiting). Both checks are needed: chaos can
   duplicate a `seq` that hasn't been released yet, which the first check alone
   would miss.
2. **Store** — park the frame by `seq`.
3. **Drain** — while `pending.has(frontier + 1)`, release it and advance the
   frontier.

**Why this structure.** O(1) insert/lookup/dedupe; total work O(n) across a
turn. The drain loop is the single invariant that guarantees ordering — nothing
downstream ever has to think about `seq` again. Crucially, **dedupe is by `seq`,
never by content**: tokens legitimately repeat text (`"the "`, `"the "`), so
content-hashing would eat real data.

**Trade-off.** A permanently-missing `seq` (a true drop with no resume) would
stall the frontier forever. That is acceptable because a real drop triggers
reconnect + RESUME, which refills the gap; and `seq` resets per turn, so the
stall can never outlive one turn.

**`seq` is per-turn, not per-session.** The server resets `seq` to 0 on every
`USER_MESSAGE`. So the FSM emits `RESET_BUFFER` on send, wiping the map and the
frontier. Forgetting this is fatal: turn 2's `seq:1` would look `<= frontier`
from turn 1 and the entire second response would silently vanish.

---

## 2. Preventing layout shift / flicker during streaming

**Problem.** Tokens arrive every 30–80ms; a tool call interrupts mid-sentence;
text resumes after. A naive "re-render the whole transcript on every token"
flickers, reflows, and can duplicate text across the tool boundary.

**Decision — the token-boundary freeze** (`lib/machine/streamModel.ts`). The
response is a list of immutable-once-closed **segments**:

- Consecutive `TOKEN`s append to the one *open* text segment.
- A `TOOL_CALL` **freezes** the open text segment and appends a tool card.
- Tokens after the tool resolves open a **brand-new** segment — they never flow
  back into the frozen one, so text cannot duplicate or reflow.

The *mechanism* that makes this cheap is **reference stability**: `appendToken`
rebuilds only the last segment and reuses (`slice(0,-1)`) the references of every
earlier segment. Frozen segments keep the same object identity across updates,
so the memoised render components (`React.memo`, keyed by stable `id`)
short-circuit — only the single growing tail `<span>` repaints. CSS uses
`whitespace-pre-wrap` so wrapping is stable as text grows.

**Trade-off.** String concatenation on the open segment is O(n) per token →
O(n²) for very long responses. Fine at protocol scale; see entry 5 for the fix.

---

## 3. "Rendered to DOM" vs "received off the socket" — the two frontiers

**Problem.** On reconnect, `RESUME { last_seq }` tells the server where to
resume. What number is correct?

**Decision.** Track **two** frontiers:

- **Release frontier** (`reorderBuffer.frontier`, L2) — highest `seq` released
  in clean order to the app. Advances the instant a frame is processed.
- **DOM frontier** (`MachineState.domFrontier`, L3) — highest `seq` actually
  committed to the DOM. Advanced **only** by a `FRAMES_RENDERED` event fired
  from a `useLayoutEffect` *after* React commits (`hooks/useAgentConsole.ts`).

**RESUME sends the DOM frontier, never the release frontier.** If the socket
dies in the window between "released to React state" and "painted", a RESUME of
the release frontier would tell the server "I have seq N" when the user can only
see N−k — and the server, replaying only `seq > last_seq`, would never resend
N−k+1…N. Those frames would be lost silently. Sending the *render* frontier is
conservative: at worst the server replays a few frames we already had, and the
reorder buffer dedupes them.

**Trade-off.** A frame can be replayed-then-deduped (slightly redundant work)
in exchange for a zero-data-loss guarantee. Correct beats clever.

---

## 4. 50 concurrent streams

**What holds today.** `seq` is global *per turn* (not per `stream_id`), so the
single reorder buffer already orders 50 interleaved streams correctly with no
change — ordering is a turn-level concern. Tool cards are keyed by globally
unique `call_id`, so `pendingAcks` (a `Set<call_id>`) already tracks N
in-flight tools across any number of streams without collision.

**What would change.** The segment model is currently one lane. For 50 streams
I'd partition segments by `stream_id` into independent lanes
(`Map<stream_id, Segment[]>`), each with its own freeze/resume state, and render
them as separate panes. Two scaling moves:

- **Render**: virtualise the lane list (only mount visible lanes) — 50 live
  `<pre>` blocks repainting on every token would thrash the main thread.
- **Backpressure**: coalesce token application with a microtask/rAF batch so 50
  streams × ~20 tokens/s don't trigger 1000 React commits/s. The model stays
  pure; only the flush cadence changes.

The FSM is unaffected — `STREAMING` / `TOOL_CALL_PENDING` describe the
*connection*, not an individual stream; per-stream status is derived from each
lane's model.

---

## 5. 100× longer responses

**The bottleneck is text concatenation, not React.** Reference stability already
keeps rendering O(1) per token (one tail node repaints). But `appendToken` does
`oldText + newText`, which is O(n) per token → O(n²) over the response. At 100×
length that dominates.

**Fix (staged, not yet needed at current scale).** Hold the open segment's text
as a `string[]` of chunks and `push` each token (amortised O(1)); `join("")`
once when the segment freezes or at render. Freezing flattens to a single
immutable string so frozen segments stay cheap to diff and render. Pair with
list virtualisation so only on-screen segments mount.

**Memory.** A 100× transcript is still bounded per turn (cleared on
`RESET_BUFFER`). If unbounded multi-turn history were required, I'd window the
retained transcript (keep last K turns fully, summarise older) rather than hold
everything.

**Why not optimise now.** It would add complexity the current payloads don't
justify, and the seam (segment text representation) is isolated — swapping
`string` for `string[]` touches one file and zero tests' meaning. Documented so
the trade is a choice, not an oversight.

---

## 6. The TOOL_ACK race

**The bug in the server.** `waitForAck` resolves on a **5s timeout and sends
`TOOL_RESULT` anyway** (`agent-server/src/server.ts:515`). Combined with the
800–2000ms exec delay and chaos reorder, the `TOOL_RESULT` can land **while the
card still says "waiting"**, and a late `TOOL_ACK` is logged
`verdict:"unexpected"`. So ACK and RESULT can cross on the wire.

**Decision.** Make tool resolution **idempotent and state-agnostic**:

- The FSM accepts `TOOL_RESULT` in *any* live state and removes the `call_id`
  from `pendingAcks`; an unknown/duplicate `call_id` is a harmless no-op
  (`connectionMachine.ts`).
- The segment model resolves the card by `call_id` and returns the **same model
  reference** if the card is already resolved or unknown (`streamModel.ts`) — no
  double-resolve, no spurious re-render.
- We ACK **immediately** on processing the `TOOL_CALL` (well inside 2s), so we
  never *cause* the timeout — but we tolerate it if chaos delays our ACK anyway.

---

## 7. Failure modes the brief didn't ask about

**(a) Orphaned / never-ending streams.** `handleResume` replays history but
**does not re-run the script** (`server.ts:241`). If a drop happened mid-stream,
the replayed history ends where the drop did — you can receive a `TOOL_CALL`
with **no `TOOL_RESULT` and no `STREAM_END`, ever**. The UI must tolerate a tool
card that stays "running" forever. Decision: after replay drains
(`REPLAY_QUIET`) the FSM returns to `CONNECTED`, *not* `STREAMING` — we do not
pretend the orphaned turn will finish; the user can start a fresh turn while the
stale card sits unresolved. No timer pretends to "fail" it, because the protocol
gives us no signal that it failed.

**(b) Replayed PING must not be PONGed.** PINGs consume `seq` and enter history,
so a stale PING is replayed on RESUME. The server only holds one live
`pendingPing`; PONGing a replayed challenge logs `verdict:"unexpected"`.
Decision: while `RESUMING`, the FSM suppresses **all** outbound protocol (no
PONG, no ACK) — every replayed frame is treated as read-only history. We detect
the end of the replay burst with a quiet-timer (`REPLAY_QUIET_MS = 750`), which
is safe because **RESUME replay bypasses chaos** (`rawSend`) and so arrives as a
tight synchronous burst, comfortably before the first post-reconnect heartbeat
PING (~2s).

**(c) Corrupt PING (`challenge: ""`).** The server compares `echo === challenge`,
so an empty challenge must be answered with `{type:"PONG", echo:""}` — **not**
early-returned. A naive `if (challenge)` guard skips it, registering a missed
PONG; three misses → `ws.terminate()`. The FSM echoes the challenge verbatim
including the empty string.

**(d) Hard drops have no close frame.** Chaos drops via `ws.terminate()` → code
1006, `wasClean:false`, no close handshake. Decision: the transport threads
`event.wasClean` into `onClose`, and the FSM treats **any** `wasClean:false`
close as a drop → `RECONNECTING` + backoff. We never wait for a graceful 1000.
The one clean close we expect is the server's `1000 "replaced"` when a second
socket opens — which is why the transport detaches its handlers *before* an
intentional `close()`, so our own teardown never looks like a drop.

---

## Backoff

500 → 1000 → 2000 → 4000 → … capped at 10000ms, reset to base on a clean open
(`lib/transport/backoff.ts`). Kept as a pure function of the attempt count so
the whole curve is unit-tested with zero fake timers. **No jitter** — there is a
single client here, so the thundering-herd problem jitter solves doesn't exist;
determinism is worth more (testability). Documented so it reads as a choice.
