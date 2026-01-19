import { useState, useEffect, useMemo } from "react";
import { AgentNode, AgentRevisionResponse, AgentSpecEnvelope, LlmConnection, RunCreateRequest, RunResponse } from "../lib/types";
import { LlmProvider, buildLlmConnectionPayload, isLlmProvider } from "../lib/llm";
import { api, BackendConfig } from "../lib/api";
import { AppSettings } from "../lib/storage";
import { prettyJson, tryParseJsonObject } from "../lib/json";
import { formatDateTime } from "../lib/json";
import { Card } from "../components/Card";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { TraceViewer } from "../components/TraceViewer";

export function AgentRunnerPage(props: { backend: BackendConfig; settings: AppSettings; onStartRun: (runId: string) => void }) {
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