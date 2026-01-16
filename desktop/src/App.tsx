import "./App.css";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRevisionResponse,
  HealthResponse,
  RunCreateRequest,
  RunEventResponse,
  RunResponse,
} from "./lib/types";
import { api, type BackendConfig } from "./lib/api";
import { diffLines } from "./lib/diff";
import { loadSettings, saveSettings, type AppSettings } from "./lib/storage";
import { formatDateTime, formatDurationMs, prettyJson, tryParseJsonObject } from "./lib/json";

type Route = "revisions" | "run" | "trace" | "dashboard" | "settings";

function App() {
  const [route, setRoute] = useState<Route>("revisions");
  const [settings, setSettings] = useState(() => loadSettings());
  const backend: BackendConfig = useMemo(() => ({ baseUrl: settings.backendBaseUrl }), [settings.backendBaseUrl]);

  // Shared “recent runs” list (frontend-side, since backend MVP doesn’t have list-runs yet).
  const [recentRunIds, setRecentRunIds] = useState<string[]>(() => settings.recentRunIds);
  useEffect(() => {
    const next = { ...settings, recentRunIds };
    setSettings(next);
    saveSettings(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentRunIds]);

  // Global health status
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    async function checkHealthOnce() {
      try {
        const h = await api(backend).health();
        if (cancelled) return;
        setHealth(h);
        setHealthErr(null);
      } catch (e) {
        if (cancelled) return;
        setHealth(null);
        setHealthErr(e instanceof Error ? e.message : String(e));

        // Backend may still be booting (desktop app starts UI + backend together).
        // Keep retrying while we're in an error state.
        retryTimer = window.setTimeout(checkHealthOnce, 1000);
      }
    }

    // Give the backend a moment to boot before the first probe.
    retryTimer = window.setTimeout(checkHealthOnce, 1000);

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [backend.baseUrl]);

  return (
    <div className="asApp">
      <aside className="asSidebar">
        <div className="asBrand">
          <div className="asBrandTitle">Agent Studio</div>
          <div className="asBrandSub">Local-first prompt + runs + traces</div>
        </div>

        <nav className="asNav">
          <NavItem active={route === "revisions"} onClick={() => setRoute("revisions")} label="Prompt revisions" />
          <NavItem active={route === "run"} onClick={() => setRoute("run")} label="Run launcher" />
          <NavItem active={route === "trace"} onClick={() => setRoute("trace")} label="Live trace" />
          <NavItem active={route === "dashboard"} onClick={() => setRoute("dashboard")} label="Dashboard" />
          <NavItem active={route === "settings"} onClick={() => setRoute("settings")} label="Settings" />
        </nav>

        <div className="asSidebarFooter">
          <div className="asPill">
            <span className="asPillLabel">Backend</span>
            <span className="asPillValue">{backend.baseUrl}</span>
          </div>
          <div className="asPill">
            <span className="asPillLabel">Health</span>
            <span className={`asPillValue ${health?.ok ? "ok" : "bad"}`}>{health?.ok ? "ok" : "down"}</span>
          </div>
        </div>
      </aside>

      <main className="asMain">
        {healthErr ? (
          <Banner tone="warn" title="Backend not reachable">
            <div className="asBannerBody">
              <div className="asMono asSmall">{healthErr}</div>
              <div className="asSmall">
                If this is a CORS issue in Tauri dev, set <span className="asMono">AGENT_STUDIO_ALLOW_CORS_ORIGINS</span>{" "}
                to include your UI origin (commonly <span className="asMono">http://localhost:1420</span>).
              </div>
            </div>
          </Banner>
        ) : null}

        {route === "revisions" ? <RevisionsPage backend={backend} onStartRun={(runId) => setRecentRunIds((s) => uniq([runId, ...s]))} /> : null}
        {route === "run" ? (
          <RunLauncherPage backend={backend} recentRunIds={recentRunIds} setRecentRunIds={setRecentRunIds} />
        ) : null}
        {route === "trace" ? <LiveTracePage backend={backend} recentRunIds={recentRunIds} /> : null}
        {route === "dashboard" ? <DashboardPage backend={backend} recentRunIds={recentRunIds} /> : null}
        {route === "settings" ? <SettingsPage settings={settings} setSettings={setSettings} /> : null}
      </main>
    </div>
  );
}

export default App;

function NavItem(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={`asNavItem ${props.active ? "active" : ""}`} onClick={props.onClick} type="button">
      {props.label}
    </button>
  );
}

function Banner(props: { tone: "warn" | "info"; title: string; children: React.ReactNode }) {
  return (
    <div className={`asBanner ${props.tone}`}>
      <div className="asBannerTitle">{props.title}</div>
      {props.children}
    </div>
  );
}

function Card(props: { title?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="asCard">
      {props.title ? (
        <header className="asCardHeader">
          <div className="asCardTitle">{props.title}</div>
          {props.right ? <div className="asCardRight">{props.right}</div> : null}
        </header>
      ) : null}
      <div className="asCardBody">{props.children}</div>
    </section>
  );
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="asField">
      <div className="asFieldLabel">
        <div>{props.label}</div>
        {props.hint ? <div className="asFieldHint">{props.hint}</div> : null}
      </div>
      {props.children}
    </label>
  );
}

function Button(props: {
  tone?: "primary" | "neutral" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  type?: "button" | "submit";
}) {
  return (
    <button className={`asBtn ${props.tone ?? "neutral"}`} disabled={props.disabled} onClick={props.onClick} type={props.type ?? "button"}>
      {props.children}
    </button>
  );
}

function RevisionsPage(props: { backend: BackendConfig; onStartRun: (runId: string) => void }) {
  const [revs, setRevs] = useState<AgentRevisionResponse[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);

  const [createName, setCreateName] = useState("Example agent");
  const [createAuthor, setCreateAuthor] = useState("local");
  const [createSpecText, setCreateSpecText] = useState(
    prettyJson({
      name: "Example agent",
      system_prompt: "You are a helpful agent.",
      model: { provider: "mock", name: "mock.generate" },
      tools: [],
      guardrails: [],
      handoffs: [],
    }),
  );
  const [createBusy, setCreateBusy] = useState(false);

  const selected = useMemo(() => revs?.find((r) => r.id === selectedId) ?? null, [revs, selectedId]);
  const compare = useMemo(() => revs?.find((r) => r.id === compareId) ?? null, [revs, compareId]);

  async function refresh() {
    try {
      setErr(null);
      const list = await api(props.backend).listAgentRevisions();
      setRevs(list);
      if (!selectedId && list.length) setSelectedId(list[0]!.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRevs(null);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.backend.baseUrl]);

  async function createRevision() {
    const spec = tryParseJsonObject(createSpecText);
    if (!spec.ok) {
      setErr(`Spec JSON invalid: ${spec.error}`);
      return;
    }
    setCreateBusy(true);
    try {
      const rev = await api(props.backend).createAgentRevision({ name: createName, author: createAuthor || null, spec_json: spec.value });
      setErr(null);
      await refresh();
      setSelectedId(rev.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  const [runInputsText, setRunInputsText] = useState(prettyJson({ input: "hello" }));
  const [runTagsText, setRunTagsText] = useState(prettyJson({}));
  const [runGroupId, setRunGroupId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runCreated, setRunCreated] = useState<RunResponse | null>(null);

  async function startRun() {
    if (!selected) return;
    const inputs = tryParseJsonObject(runInputsText);
    const tags = tryParseJsonObject(runTagsText);
    if (!inputs.ok) {
      setErr(`Inputs JSON invalid: ${inputs.error}`);
      return;
    }
    if (!tags.ok) {
      setErr(`Tags JSON invalid: ${tags.error}`);
      return;
    }
    const req: RunCreateRequest = {
      agent_revision_id: selected.id,
      inputs_json: inputs.value,
      tags_json: tags.value,
      group_id: runGroupId.trim() || null,
    };
    setRunBusy(true);
    try {
      const run = await api(props.backend).createRun(req);
      setRunCreated(run);
      props.onStartRun(run.id);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunBusy(false);
    }
  }

  const diffText = useMemo(() => {
    if (!selected || !compare) return null;
    const a = prettyJson(compare.spec_json).split("\n");
    const b = prettyJson(selected.spec_json).split("\n");
    return diffLines(a, b);
  }, [selected, compare]);

  return (
    <div className="asGrid2">
      <div className="asCol">
        <Card
          title="Prompt revisions"
          right={
            <Button tone="neutral" onClick={refresh}>
              Refresh
            </Button>
          }
        >
          {err ? <div className="asError">{err}</div> : null}
          {revs ? (
            <div className="asList">
              {revs.map((r) => (
                <button
                  key={r.id}
                  className={`asListItem ${selectedId === r.id ? "active" : ""}`}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                >
                  <div className="asListTitle">{r.name}</div>
                  <div className="asListMeta">
                    <span className="asMono">{r.id.slice(0, 8)}</span> · {formatDateTime(r.created_at)} · {r.author ?? "unknown"}
                  </div>
                </button>
              ))}
              {revs.length === 0 ? <div className="asMuted">No revisions yet. Create one below.</div> : null}
            </div>
          ) : (
            <div className="asMuted">Loading…</div>
          )}
        </Card>

        <Card title="Create new revision">
          <div className="asFormGrid">
            <Field label="Name">
              <input className="asInput" value={createName} onChange={(e) => setCreateName(e.currentTarget.value)} />
            </Field>
            <Field label="Author (optional)">
              <input className="asInput" value={createAuthor} onChange={(e) => setCreateAuthor(e.currentTarget.value)} />
            </Field>
          </div>
          <Field label="Spec JSON" hint="This is the versioned artifact. Store prompts, tools, model params, guardrails, and the handoff graph here.">
            <textarea className="asTextarea" value={createSpecText} onChange={(e) => setCreateSpecText(e.currentTarget.value)} rows={14} />
          </Field>
          <div className="asRow">
            <Button tone="primary" onClick={createRevision} disabled={createBusy}>
              {createBusy ? "Creating…" : "Create revision"}
            </Button>
          </div>
        </Card>
      </div>

      <div className="asCol">
        <Card title="Selected revision">
          {selected ? (
            <div className="asStack">
              <div className="asKeyValue">
                <div className="k">ID</div>
                <div className="v asMono">{selected.id}</div>
              </div>
              <div className="asKeyValue">
                <div className="k">Created</div>
                <div className="v">{formatDateTime(selected.created_at)}</div>
              </div>
              <div className="asKeyValue">
                <div className="k">Content hash</div>
                <div className="v asMono">{selected.content_hash}</div>
              </div>
              <Field label="Spec JSON (read-only)">
                <textarea className="asTextarea" readOnly value={prettyJson(selected.spec_json)} rows={12} />
              </Field>
            </div>
          ) : (
            <div className="asMuted">Select a revision to see details.</div>
          )}
        </Card>

        <Card title="Run this revision">
          {selected ? (
            <>
              <Field label="Inputs JSON">
                <textarea className="asTextarea" value={runInputsText} onChange={(e) => setRunInputsText(e.currentTarget.value)} rows={6} />
              </Field>
              <Field label="Tags JSON">
                <textarea className="asTextarea" value={runTagsText} onChange={(e) => setRunTagsText(e.currentTarget.value)} rows={4} />
              </Field>
              <Field label="Group ID (optional)" hint="Useful for dataset runs / regression tracking.">
                <input className="asInput" value={runGroupId} onChange={(e) => setRunGroupId(e.currentTarget.value)} />
              </Field>
              <div className="asRow">
                <Button tone="primary" onClick={startRun} disabled={runBusy}>
                  {runBusy ? "Starting…" : "Start run"}
                </Button>
                {runCreated ? <span className="asMono asSmall">run_id: {runCreated.id}</span> : null}
              </div>
            </>
          ) : (
            <div className="asMuted">Pick a revision first.</div>
          )}
        </Card>

        <Card title="Diff revisions" right={<span className="asSmall asMuted">Compare → Selected</span>}>
          {revs && revs.length > 1 ? (
            <>
              <Field label="Compare against">
                <select className="asSelect" value={compareId ?? ""} onChange={(e) => setCompareId(e.currentTarget.value || null)}>
                  <option value="">(none)</option>
                  {revs
                    .filter((r) => r.id !== selectedId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {r.id.slice(0, 8)}
                      </option>
                    ))}
                </select>
              </Field>
              {diffText ? (
                <pre className="asDiff">
                  {diffText.map((d, idx) => (
                    <div key={idx} className={`asDiffLine ${d.kind}`}>
                      <span className="asDiffGlyph">{d.kind === "add" ? "+" : d.kind === "del" ? "-" : " "}</span>
                      <span>{d.text}</span>
                    </div>
                  ))}
                </pre>
              ) : (
                <div className="asMuted">Select a “compare” revision to see a simple line diff.</div>
              )}
            </>
          ) : (
            <div className="asMuted">Create at least 2 revisions to compare.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RunLauncherPage(props: {
  backend: BackendConfig;
  recentRunIds: string[];
  setRecentRunIds: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [runId, setRunId] = useState(props.recentRunIds[0] ?? "");
  const [run, setRun] = useState<RunResponse | null>(null);
  const [events, setEvents] = useState<RunEventResponse[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const id = runId.trim();
    if (!id) return;
    setBusy(true);
    try {
      setErr(null);
      const r = await api(props.backend).getRun(id);
      const evs = await api(props.backend).listRunEvents(id);
      setRun(r);
      setEvents(evs);
      props.setRecentRunIds((s) => uniq([id, ...s]).slice(0, 50));
    } catch (e) {
      setRun(null);
      setEvents(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!run) return;
    try {
      await api(props.backend).cancelRun(run.id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="asGrid2">
      <div className="asCol">
        <Card title="Open run">
          {err ? <div className="asError">{err}</div> : null}
          <div className="asRow">
            <input className="asInput" placeholder="run_id…" value={runId} onChange={(e) => setRunId(e.currentTarget.value)} />
            <Button tone="primary" onClick={load} disabled={busy}>
              {busy ? "Loading…" : "Load"}
            </Button>
          </div>
          {props.recentRunIds.length ? (
            <div className="asSmall asMuted">
              Recent:{" "}
              {props.recentRunIds.slice(0, 8).map((id) => (
                <button key={id} className="asLink" type="button" onClick={() => setRunId(id)}>
                  {id.slice(0, 8)}
                </button>
              ))}
            </div>
          ) : null}
        </Card>

        <Card title="Run details" right={run ? <span className={`asStatus ${run.status}`}>{run.status}</span> : null}>
          {run ? (
            <div className="asStack">
              <div className="asKeyValue">
                <div className="k">Run ID</div>
                <div className="v asMono">{run.id}</div>
              </div>
              <div className="asKeyValue">
                <div className="k">Revision</div>
                <div className="v asMono">{run.agent_revision_id}</div>
              </div>
              <div className="asKeyValue">
                <div className="k">Started</div>
                <div className="v">{formatDateTime(run.started_at)}</div>
              </div>
              <div className="asKeyValue">
                <div className="k">Ended</div>
                <div className="v">{run.ended_at ? formatDateTime(run.ended_at) : "—"}</div>
              </div>
              <div className="asKeyValue">
                <div className="k">Duration</div>
                <div className="v">
                  {run.ended_at ? formatDurationMs(Date.parse(run.ended_at) - Date.parse(run.started_at)) : "—"}
                </div>
              </div>
              <div className="asKeyValue">
                <div className="k">Cancel requested</div>
                <div className="v">{run.cancel_requested ? "true" : "false"}</div>
              </div>
              {run.error ? <div className="asError asMono">{run.error}</div> : null}
              <Field label="Inputs">
                <textarea className="asTextarea" readOnly value={prettyJson(run.inputs_json)} rows={6} />
              </Field>
              <Field label="Final output">
                <textarea className="asTextarea" readOnly value={run.final_output ?? ""} rows={5} placeholder="(not completed yet)" />
              </Field>
              <div className="asRow">
                <Button tone="neutral" onClick={load} disabled={busy}>
                  Refresh
                </Button>
                <Button tone="danger" onClick={cancel} disabled={run.status !== "running" && run.status !== "queued"}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="asMuted">Load a run to see its details.</div>
          )}
        </Card>
      </div>

      <div className="asCol">
        <Card title="Persisted events" right={events ? <span className="asSmall asMuted">{events.length} events</span> : null}>
          {events ? (
            <div className="asEvents">
              {events.map((ev) => (
                <EventRow key={ev.id} ev={ev} />
              ))}
              {events.length === 0 ? <div className="asMuted">No events yet.</div> : null}
            </div>
          ) : (
            <div className="asMuted">Load a run to view its persisted events.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function LiveTracePage(props: { backend: BackendConfig; recentRunIds: string[] }) {
  const [runId, setRunId] = useState(props.recentRunIds[0] ?? "");
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEventResponse[]>([]);
  const lastSeqRef = useRef<number>(0);
  const esRef = useRef<EventSource | null>(null);

  function disconnect() {
    esRef.current?.close();
    esRef.current = null;
    setStatus("idle");
  }

  function connect() {
    const id = runId.trim();
    if (!id) return;
    disconnect();
    setStatus("connecting");
    setErr(null);
    setEvents([]);
    lastSeqRef.current = 0;

    const url = `${props.backend.baseUrl}/v1/runs/${encodeURIComponent(id)}/events/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("run_event", (msg) => {
      try {
        const data = JSON.parse((msg as MessageEvent).data) as RunEventResponse;
        lastSeqRef.current = Math.max(lastSeqRef.current, data.seq ?? 0);
        setEvents((prev) => [...prev, data].slice(-2000));
        setStatus("connected");
      } catch (e) {
        setStatus("error");
        setErr(e instanceof Error ? e.message : String(e));
      }
    });

    es.onerror = () => {
      setStatus("error");
      setErr("SSE connection error (backend down, CORS blocked, or run_id not found).");
    };
  }

  async function loadBacklog() {
    const id = runId.trim();
    if (!id) return;
    try {
      const evs = await api(props.backend).listRunEvents(id, 2000, 0);
      setEvents(evs);
      lastSeqRef.current = evs.length ? evs[evs.length - 1]!.seq : 0;
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="asGrid2">
      <div className="asCol">
        <Card
          title="Live trace (SSE)"
          right={<span className={`asStatusPill ${status}`}>{status}</span>}
        >
          {err ? <div className="asError">{err}</div> : null}
          <Field label="Run ID">
            <input className="asInput" value={runId} onChange={(e) => setRunId(e.currentTarget.value)} placeholder="run_id…" />
          </Field>
          <div className="asRow">
            <Button tone="neutral" onClick={loadBacklog}>
              Load backlog
            </Button>
            <Button tone="primary" onClick={connect}>
              Connect
            </Button>
            <Button tone="neutral" onClick={disconnect}>
              Disconnect
            </Button>
          </div>
          <div className="asSmall asMuted">
            Tip: the backend emits <span className="asMono">span.started</span>/<span className="asMono">span.completed</span> so you can treat
            these as “spans” in the timeline.
          </div>
        </Card>
      </div>

      <div className="asCol">
        <Card title="Timeline" right={<span className="asSmall asMuted">{events.length} events</span>}>
          <div className="asEvents">
            {events.map((ev) => (
              <EventRow key={ev.id} ev={ev} />
            ))}
            {events.length === 0 ? <div className="asMuted">No events yet.</div> : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

function DashboardPage(props: { backend: BackendConfig; recentRunIds: string[] }) {
  const [runs, setRuns] = useState<RunResponse[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
              <div key={r.id} className="asTableRow">
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
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="asMetric">
      <div className="asMetricLabel">{props.label}</div>
      <div className="asMetricValue">{props.value}</div>
    </div>
  );
}

function SettingsPage(props: { settings: AppSettings; setSettings: (s: AppSettings) => void }) {
  const [baseUrl, setBaseUrl] = useState(props.settings.backendBaseUrl);
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    const next = { ...props.settings, backendBaseUrl: baseUrl.trim() || "http://127.0.0.1:37123" };
    props.setSettings(next);
    saveSettings(next);
    setMsg("Saved.");
    setTimeout(() => setMsg(null), 1200);
  }

  return (
    <div className="asStack">
      <Card title="Settings">
        <Field label="Backend base URL" hint="Default backend port is 37123 (see backend/README.md).">
          <input className="asInput" value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} />
        </Field>
        <div className="asRow">
          <Button tone="primary" onClick={save}>
            Save
          </Button>
          {msg ? <div className="asSmall asMuted">{msg}</div> : null}
        </div>
      </Card>

      <Card title="Notes">
        <div className="asSmall asMuted">
          The backend is local-first and can run with the mock executor (no API keys). If you’re running this UI in Tauri dev, you may need to
          enable CORS via <span className="asMono">AGENT_STUDIO_ALLOW_CORS_ORIGINS</span>.
        </div>
      </Card>
    </div>
  );
}

function EventRow(props: { ev: RunEventResponse }) {
  const payload = useMemo(() => prettyJson(props.ev.payload_json), [props.ev.payload_json]);
  return (
    <details className="asEvent">
      <summary className="asEventSummary">
        <span className="asEventSeq asMono">{String(props.ev.seq).padStart(4, "0")}</span>
        <span className="asEventType asMono">{props.ev.type}</span>
        <span className="asEventTime">{formatDateTime(props.ev.created_at)}</span>
      </summary>
      <pre className="asEventPayload">{payload}</pre>
    </details>
  );
}

function uniq(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const k = id.trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
