import { useState, useEffect, useMemo } from "react";
import { RunResponse } from "../lib/types";
import { api, BackendConfig } from "../lib/api";
import { formatDateTime, formatDurationMs } from "../lib/json";
import { Card } from "../components/Card";
import { Metric } from "../components/Metric";
import { TraceViewer } from "../components/TraceViewer";
import { Button } from "../components/Button";

export function DashboardPage(props: { backend: BackendConfig; recentRunIds: string[] }) {
  const [runs, setRuns] = useState<RunResponse[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  async function load() {
    if (!props.recentRunIds.length) {
      setRuns([]);
      return;
    }
    setBusy(true);
    try {
      const rs = await Promise.all(props.recentRunIds.slice(0, 20).map((id) => api(props.backend).getRun(id)));
      setRuns(rs);
      setErr(null);
    } catch (e) {
      setRuns(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.backend.baseUrl, props.recentRunIds.join("|")]);

  useEffect(() => {
    if (!runs || runs.length === 0) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !runs.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  const stats = useMemo(() => {
    const rs = runs ?? [];
    const durations = rs
      .filter((r) => r.ended_at)
      .map((r) => Date.parse(r.ended_at as string) - Date.parse(r.started_at))
      .filter((d) => Number.isFinite(d) && d >= 0)
      .sort((a, b) => a - b);
    const p = (q: number) => {
      if (!durations.length) return null;
      const idx = Math.min(durations.length - 1, Math.max(0, Math.floor(q * (durations.length - 1))));
      return durations[idx]!;
    };
    const completed = rs.filter((r) => r.status === "completed").length;
    const failed = rs.filter((r) => r.status === "failed").length;
    const running = rs.filter((r) => r.status === "running" || r.status === "queued").length;
    return {
      total: rs.length,
      completed,
      failed,
      running,
      p50: p(0.5),
      p95: p(0.95),
    };
  }, [runs]);

  return (
    <div className="asStack">
      <Card
        title="Metrics (from recent runs)"
        right={
          <Button tone="neutral" onClick={load} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        }
      >
        {err ? <div className="asError">{err}</div> : null}
        <div className="asCardsRow">
          <Metric label="Total runs" value={String(stats.total)} />
          <Metric label="Completed" value={String(stats.completed)} />
          <Metric label="Failed" value={String(stats.failed)} />
          <Metric label="In flight" value={String(stats.running)} />
          <Metric label="p50 duration" value={stats.p50 != null ? formatDurationMs(stats.p50) : "—"} />
          <Metric label="p95 duration" value={stats.p95 != null ? formatDurationMs(stats.p95) : "—"} />
        </div>
        <div className="asSmall asMuted">This is a lightweight placeholder until the backend adds real aggregates/list-runs endpoints.</div>
      </Card>

      <div className="asGrid2">
        <div className="asCol">
          <Card title="Recent runs">
            {runs ? (
              <div className="asTable">
                <div className="asTableHead">
                  <div>Run</div>
                  <div>Status</div>
                  <div>Started</div>
                  <div>Ended</div>
                </div>
                {runs.map((r) => (
                  <div
                    key={r.id}
                    className={`asTableRow clickable ${selectedRunId === r.id ? "active" : ""}`}
                    onClick={() => setSelectedRunId(r.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedRunId(r.id);
                      }
                    }}
                  >
                    <div className="asMono">{r.id.slice(0, 8)}</div>
                    <div>
                      <span className={`asStatus ${r.status}`}>{r.status}</span>
                    </div>
                    <div>{formatDateTime(r.started_at)}</div>
                    <div>{r.ended_at ? formatDateTime(r.ended_at) : "—"}</div>
                  </div>
                ))}
                {runs.length === 0 ? <div className="asMuted">No recent runs yet. Start one from “Prompt revisions”.</div> : null}
              </div>
            ) : (
              <div className="asMuted">Loading…</div>
            )}
          </Card>
        </div>
        <div className="asCol">
          <TraceViewer
            backend={props.backend}
            runId={selectedRunId}
            mode="static"
            emptyMessage="Select a run to view its trace."
            waitingMessage="Loading trace events…"
            title="Run trace"
          />
        </div>
      </div>
    </div>
  );
}