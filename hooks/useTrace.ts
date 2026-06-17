"use client";

// Stateful wrapper around the pure trace reducers. Holds the timeline array and
// hands back two stable callbacks; all the grouping/cap logic lives in
// lib/trace so it can be tested without React.

import { useCallback, useRef, useState } from "react";
import {
  appendEvent,
  appendToken,
  type TraceEntry,
  type TraceTone,
} from "../lib/trace/trace";

export interface TraceRecorder {
  trace: TraceEntry[];
  traceEvent: (label: string, detail: string, tone: TraceTone) => void;
  traceToken: (text: string) => void;
}

export function useTrace(): TraceRecorder {
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const idRef = useRef(0);

  const traceEvent = useCallback(
    (label: string, detail: string, tone: TraceTone) => {
      const id = idRef.current++;
      setTrace((prev) => appendEvent(prev, id, label, detail, tone));
    },
    [],
  );

  const traceToken = useCallback((text: string) => {
    const id = idRef.current++;
    setTrace((prev) => appendToken(prev, id, text, Date.now()));
  }, []);

  return { trace, traceEvent, traceToken };
}
