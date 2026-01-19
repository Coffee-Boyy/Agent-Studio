import "./App.css";

import { useEffect, useMemo, useState } from "react";
import type {
  AgentNode,
  AgentRevisionResponse,
  AgentSpecEnvelope,
  HealthResponse,
  LlmConnection,
  RunCreateRequest,
  RunResponse,
} from "./lib/types";
import { api, type BackendConfig } from "./lib/api";
import {
  buildLlmConnectionPayload,
  isLlmProvider,
  LLM_PROVIDER_DEFS,
  LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  type LlmProvider,
} from "./lib/llm";
import { loadSettings, saveSettings, type AppSettings } from "./lib/storage";
import { formatDateTime, formatDurationMs, prettyJson, tryParseJsonObject } from "./lib/json";
import { AgentEditorPage } from "./pages/AgentEditorPage";
import { TraceViewer } from "./components/TraceViewer";

type Route = "editor" | "runner" | "dashboard" | "settings";

function App() {
  const [route, setRoute] = useState<Route>("editor");
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
          <div className="asBrandTitle">LLM Agent Studio</div>
          <div className="asBrandSub">Create and manage your LLM agents</div>
        </div>

        <nav className="asNav">
          <NavItem active={route === "dashboard"} onClick={() => setRoute("dashboard")} label="Dashboard" />
          <NavItem active={route === "runner"} onClick={() => setRoute("runner")} label="Agent runner" />
          <NavItem active={route === "editor"} onClick={() => setRoute("editor")} label="Agent editor" />
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

        {route === "editor" ? (
          <AgentEditorPage
            backend={backend}
            settings={settings}
            onStartRun={(runId) => setRecentRunIds((s) => uniq([runId, ...s]).slice(0, 50))}
          />
        ) : null}
        {route === "runner" ? (
          <AgentRunnerPage
            backend={backend}
            settings={settings}
            onStartRun={(runId) => setRecentRunIds((s) => uniq([runId, ...s]).slice(0, 50))}
          />
        ) : null}
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

function AgentRunnerPage(props: { backend: BackendConfig; settings: AppSettings; onStartRun: (runId: string) => void }) {
  const [revs, setRevs] = useState<AgentRevisionResponse[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [runInputsText, setRunInputsText] = useState(prettyJson({ input: "hello" }));
  const [runTagsText, setRunTagsText] = useState(prettyJson({}));
  const [runGroupId, setRunGroupId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runCreated, setRunCreated] = useState<RunResponse | null>(null);

  async function refresh() {
    try {
      setErr(null);
      const list = await api(props.backend).listAgentRevisions();
      setRevs(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRevs(null);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.backend.baseUrl]);

  function resolveProvider(revision: AgentRevisionResponse): LlmProvider | null {
    const spec = revision.spec_json as AgentSpecEnvelope;
    if (!spec || spec.schema_version !== "graph-v1" || !spec.graph) return null;
    const agentNode = spec.graph.nodes.find((node) => node.type === "agent") as AgentNode | undefined;
    if (!agentNode) return null;
    const model = agentNode.model ?? {};
    if (typeof model !== "object" || Array.isArray(model) || !model) return null;
    const provider = (model as { provider?: unknown }).provider;
    return isLlmProvider(provider) ? provider : null;
  }

  function buildLlmConnection(provider: LlmProvider): LlmConnection {
    return buildLlmConnectionPayload(provider, props.settings.llmConnections[provider]) as LlmConnection;
  }

  const agents = useMemo(() => {
    if (!revs) return [];
    const byName = new Map<string, AgentRevisionResponse[]>();
    for (const rev of revs) {
      const name = rev.name || "Untitled agent";
      const existing = byName.get(name) ?? [];
      existing.push(rev);
      byName.set(name, existing);
    }
    const sortedAgents = Array.from(byName.entries()).map(([name, revisions]) => {
      const sorted = [...revisions].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return { name, revisions: sorted };
    });
    sortedAgents.sort((a, b) => {
      const aTime = a.revisions[0] ? Date.parse(a.revisions[0].created_at) : 0;
      const bTime = b.revisions[0] ? Date.parse(b.revisions[0].created_at) : 0;
      return bTime - aTime;
    });
    return sortedAgents;
  }, [revs]);

  const selectedRevisions = useMemo(() => {
    return agents.find((agent) => agent.name === selectedAgent)?.revisions ?? [];
  }, [agents, selectedAgent]);

  const selectedRevision = useMemo(() => {
    return selectedRevisions.find((rev) => rev.id === selectedRevisionId) ?? selectedRevisions[0] ?? null;
  }, [selectedRevisions, selectedRevisionId]);

  useEffect(() => {
    if (!agents.length) return;
    const activeAgent = agents.find((agent) => agent.name === selectedAgent) ?? agents[0];
    if (!activeAgent) return;
    if (activeAgent.name !== selectedAgent) {
      setSelectedAgent(activeAgent.name);
    }
    const latestId = activeAgent.revisions[0]?.id ?? "";
    if (!latestId) return;
    if (!selectedRevisionId || !activeAgent.revisions.some((rev) => rev.id === selectedRevisionId)) {
      setSelectedRevisionId(latestId);
    }
  }, [agents, selectedAgent, selectedRevisionId]);

  function handleAgentChange(nextAgent: string) {
    setSelectedAgent(nextAgent);
    const revisions = agents.find((agent) => agent.name === nextAgent)?.revisions ?? [];
    setSelectedRevisionId(revisions[0]?.id ?? "");
  }

  async function startRun() {
    if (!selectedRevision) return;
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
    const provider = resolveProvider(selectedRevision) ?? props.settings.llmProvider;
    const req: RunCreateRequest = {
      agent_revision_id: selectedRevision.id,
      inputs_json: inputs.value,
      tags_json: tags.value,
      group_id: runGroupId.trim() || null,
      llm_connection: buildLlmConnection(provider),
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

  return (
    <div className="asGrid2">
      <div className="asCol">
        <Card title="Agent runner">
          {err ? <div className="asError">{err}</div> : null}
          {revs ? (
            agents.length ? (
              <div className="asStack">
                <Field label="Agent">
                  <select className="asSelect" value={selectedAgent} onChange={(e) => handleAgentChange(e.currentTarget.value)}>
                    {agents.map((agent) => (
                      <option key={agent.name} value={agent.name}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Version">
                  <select className="asSelect" value={selectedRevisionId} onChange={(e) => setSelectedRevisionId(e.currentTarget.value)}>
                    {selectedRevisions.map((rev, idx) => (
                      <option key={rev.id} value={rev.id}>
                        {idx === 0 ? "Latest" : "Version"} · {formatDateTime(rev.created_at)} · {rev.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Inputs JSON">
                  <textarea className="asTextarea" value={runInputsText} onChange={(e) => setRunInputsText(e.currentTarget.value)} rows={6} />
                </Field>
                <Field label="Tags JSON">
                  <textarea className="asTextarea" value={runTagsText} onChange={(e) => setRunTagsText(e.currentTarget.value)} rows={4} />
                </Field>
                <Field label="Group ID (optional)">
                  <input className="asInput" value={runGroupId} onChange={(e) => setRunGroupId(e.currentTarget.value)} />
                </Field>
                <div className="asRow">
                  <Button tone="primary" onClick={startRun} disabled={runBusy || !selectedRevision}>
                    {runBusy ? "Starting…" : "Run agent"}
                  </Button>
                  {runCreated ? <span className="asMono asSmall">run_id: {runCreated.id}</span> : null}
                </div>
              </div>
            ) : (
              <div className="asMuted">No agents yet. Create a revision to get started.</div>
            )
          ) : (
            <div className="asMuted">Loading…</div>
          )}
        </Card>
      </div>

      <div className="asCol">
        <div className="asStack">
          <Card title="Selected version">
            {selectedRevision ? (
              <div className="asStack">
                <div className="asKeyValue">
                  <div className="k">Agent</div>
                  <div className="v">{selectedRevision.name}</div>
                </div>
                <div className="asKeyValue">
                  <div className="k">Revision</div>
                  <div className="v asMono">{selectedRevision.id}</div>
                </div>
                <div className="asKeyValue">
                  <div className="k">Created</div>
                  <div className="v">{formatDateTime(selectedRevision.created_at)}</div>
                </div>
                <div className="asKeyValue">
                  <div className="k">Content hash</div>
                  <div className="v asMono">{selectedRevision.content_hash}</div>
                </div>
              </div>
            ) : (
              <div className="asMuted">Select an agent and version to see details.</div>
            )}
          </Card>
          <TraceViewer
            backend={props.backend}
            runId={runCreated?.id ?? null}
            mode="stream"
            emptyMessage="Start a run to stream events here."
            waitingMessage="Waiting for events…"
            title="Agent trace"
          />
        </div>
      </div>
    </div>
  );
}

function DashboardPage(props: { backend: BackendConfig; recentRunIds: string[] }) {
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
  const [llmProvider, setLlmProvider] = useState<AppSettings["llmProvider"]>(props.settings.llmProvider);
  const [connections, setConnections] = useState(props.settings.llmConnections);
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    const nextConnections = { ...connections };
    for (const provider of LLM_PROVIDERS) {
      const def = LLM_PROVIDER_DEFS[provider];
      const cfg = { ...nextConnections[provider] };
      for (const field of def.fields) {
        const value = cfg[field.key];
        if (typeof value === "string") {
          cfg[field.key] = value.trim();
        }
      }
      nextConnections[provider] = cfg;
    }
    const next = {
      ...props.settings,
      backendBaseUrl: baseUrl.trim() || "http://127.0.0.1:37123",
      llmProvider,
      llmConnections: nextConnections,
    };
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
        <div className="asSectionTitle">LLM connections</div>
        <Field label="Provider">
          <select className="asSelect" value={llmProvider} onChange={(e) => setLlmProvider(e.currentTarget.value as AppSettings["llmProvider"])}>
            {LLM_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {LLM_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </Field>
        {LLM_PROVIDER_DEFS[llmProvider].fields.map((field) => (
          <Field key={`${llmProvider}-${field.key}`} label={field.label}>
            <input
              className="asInput"
              type={field.inputType ?? "text"}
              placeholder={field.placeholder}
              value={connections[llmProvider]?.[field.key] ?? ""}
              onChange={(e) =>
                setConnections((prev) => ({
                  ...prev,
                  [llmProvider]: {
                    ...prev[llmProvider],
                    [field.key]: e.currentTarget.value,
                  },
                }))
              }
            />
          </Field>
        ))}
        <div className="asSmall asMuted">
          Credentials are stored locally in this browser profile.
        </div>
        <div className="asRow">
          <Button tone="primary" onClick={save}>
            Save
          </Button>
          {msg ? <div className="asSmall asMuted">{msg}</div> : null}
        </div>
      </Card>
    </div>
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
