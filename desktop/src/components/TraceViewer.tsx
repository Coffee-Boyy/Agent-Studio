import { useEffect, useMemo, useRef, useState } from "react";

import { api, type BackendConfig } from "../lib/api";
import type { RunEventResponse } from "../lib/types";
import { formatDateTime, prettyJson } from "../lib/json";

type TraceMode = "stream" | "static";

export function TraceViewer(props: {
  backend: BackendConfig;
  runId: string | null;
  mode: TraceMode;
  emptyMessage: string;
  waitingMessage: string;
  title: string;
}) {
  const [traceErr, setTraceErr] = useState<string | null>(null);
  const [traceEvents, setTraceEvents] = useState<RunEventResponse[]>([]);
  const esRef = useRef<EventSource | null>(null);

  function disconnectTrace() {
    esRef.current?.close();
    esRef.current = null;
  }

  useEffect(() => {
    let cancelled = false;

    async function loadStatic(runId: string) {
      setTraceErr(null);
      setTraceEvents([]);
      try {
        const events = await api(props.backend).listRunEvents(runId, 500, 0);
        if (cancelled) return;
        setTraceEvents(events);
      } catch (e) {
        if (cancelled) return;
        setTraceErr(e instanceof Error ? e.message : String(e));
      }
    }

    function connectStream(runId: string) {
      disconnectTrace();
      setTraceErr(null);
      setTraceEvents([]);
      const url = `${props.backend.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events/stream`;
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener("run_event", (msg) => {
        try {
          const data = JSON.parse((msg as MessageEvent).data) as RunEventResponse;
          setTraceEvents((prev) => {
            const idx = prev.findIndex((ev) => ev.id === data.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = data;
              return next;
            }
            return [...prev, data].slice(-2000);
          });
        } catch (e) {
          setTraceErr(e instanceof Error ? e.message : String(e));
        }
      });

      es.onerror = () => {
        setTraceErr("SSE connection error (backend down, CORS blocked, or run_id not found).");
      };
    }

    if (!props.runId) {
      disconnectTrace();
      setTraceErr(null);
      setTraceEvents([]);
      return () => {
        cancelled = true;
      };
    }

    if (props.mode === "stream") {
      connectStream(props.runId);
    } else {
      disconnectTrace();
      loadStatic(props.runId);
    }

    return () => {
      cancelled = true;
      disconnectTrace();
    };
  }, [props.backend.baseUrl, props.mode, props.runId]);

  return (
    <section className="asCard">
      <header className="asCardHeader">
        <div className="asCardTitle">{props.title}</div>
      </header>
      <div className="asCardBody">
        {traceErr ? <div className="asError">{traceErr}</div> : null}
        {props.runId ? <div className="asSmall asMuted">run_id: {props.runId}</div> : null}
        <div className="asEvents">
          {traceEvents.map((ev) => (
            <EventRow key={ev.id} ev={ev} />
          ))}
          {props.runId && traceEvents.length === 0 ? <div className="asMuted">{props.waitingMessage}</div> : null}
          {!props.runId ? <div className="asMuted">{props.emptyMessage}</div> : null}
        </div>
      </div>
    </section>
  );
}

function EventRow(props: { ev: RunEventResponse }) {
  const payload = useMemo(() => prettyJson(props.ev.payload_json), [props.ev.payload_json]);
  const eventName = useMemo(() => extractEventName(props.ev.payload_json), [props.ev.payload_json]);
  return (
    <details className="asEvent">
      <summary className="asEventSummary">
        <span className="asEventSeq asMono">{String(props.ev.seq).padStart(4, "0")}</span>
        <span className="asEventType">
          <span className="asMono">{props.ev.type}</span>
          {eventName ? <span className="asMuted"> · {eventName}</span> : null}
        </span>
        <span className="asEventTime">{formatDateTime(props.ev.created_at)}</span>
      </summary>
      <pre className="asEventPayload">{payload}</pre>
    </details>
  );
}

function extractEventName(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const directName = payload.name;
  if (typeof directName === "string" && directName.trim()) return directName.trim();
  const newAgent = payload.new_agent;
  if (newAgent && typeof newAgent === "object" && "name" in newAgent) {
    const nestedName = (newAgent as { name?: unknown }).name;
    if (typeof nestedName === "string" && nestedName.trim()) return nestedName.trim();
  }
  const agent = payload.agent;
  if (agent && typeof agent === "object" && "name" in agent) {
    const nestedName = (agent as { name?: unknown }).name;
    if (typeof nestedName === "string" && nestedName.trim()) return nestedName.trim();
  }
  return null;
}
