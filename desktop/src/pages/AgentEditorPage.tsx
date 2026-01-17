import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  type NodeTypes,
  type Connection,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api, type BackendConfig } from "../lib/api";
import { prettyJson, tryParseJsonObject } from "../lib/json";
import {
  buildLlmConnectionPayload,
  DEFAULT_LLM_PROVIDER,
  isLlmProvider,
  LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  MODEL_OPTIONS,
  type LlmProvider,
} from "../lib/llm";
import { loadAgentDraft, saveAgentDraft, type AppSettings } from "../lib/storage";
import type {
  AgentGraphDocV1,
  AgentNode,
  AgentRevisionCreateRequest,
  AgentRevisionResponse,
  AgentSpecEnvelope,
  LLMNode,
  ToolNode,
  ValidationIssue,
} from "../lib/types";
import { TraceViewer } from "../components/TraceViewer";

const DEFAULT_GRAPH: AgentGraphDocV1 = {
  schema_version: "graph-v1",
  nodes: [
    {
      id: "input-1",
      type: "input",
      name: "Input",
      position: { x: 40, y: 80 },
      schema: { input: "string" },
    },
    {
      id: "llm-1",
      type: "llm",
      name: "Main LLM",
      position: { x: 320, y: 80 },
      system_prompt: "You are a helpful agent.",
      model: { provider: DEFAULT_LLM_PROVIDER, name: MODEL_OPTIONS[DEFAULT_LLM_PROVIDER][0] },
      tools: [],
      temperature: 0.3,
    },
    {
      id: "output-1",
      type: "output",
      name: "Output",
      position: { x: 620, y: 80 },
    },
  ],
  edges: [
    { id: "edge-1", source: "input-1", target: "llm-1" },
    { id: "edge-2", source: "llm-1", target: "output-1" },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  metadata: {},
};

function buildEnvelope(graph: AgentGraphDocV1): AgentSpecEnvelope {
  return {
    schema_version: "graph-v1",
    graph,
    compiled: null,
    metadata: {},
  };
}

function formatRelativeTime(isoTime: string): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return "unknown";
  const diffMs = date.getTime() - Date.now();
  const diffSeconds = Math.round(diffMs / 1000);
  const thresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secondsInUnit] of thresholds) {
    if (Math.abs(diffSeconds) >= secondsInUnit || unit === "second") {
      return rtf.format(-Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return rtf.format(0, "second");
}

function toFlowNodes(graph: AgentGraphDocV1, issuesByNodeId: Map<string, ValidationIssue[]>): Node[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    position: n.position,
    data: {
      label: `${n.type}${n.name ? `: ${n.name}` : ""}`,
      nodeType: n.type,
      name: n.name ?? "",
      issueCount: issuesByNodeId.get(n.id)?.length ?? 0,
    },
    type: "agentNode",
  }));
}

function toFlowEdges(graph: AgentGraphDocV1): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label ?? undefined,
    sourceHandle: e.source_handle ?? undefined,
    targetHandle: e.target_handle ?? undefined,
  }));
}

function mergeFlow(graph: AgentGraphDocV1, flowNodes: Node[], flowEdges: Edge[]): AgentGraphDocV1 {
  const nodeMap = new Map(flowNodes.map((n) => [n.id, n]));
  const nodes = graph.nodes
    .filter((n) => nodeMap.has(n.id))
    .map((n) => {
      const flow = nodeMap.get(n.id);
      if (!flow) return n;
      return { ...n, position: { x: flow.position.x, y: flow.position.y } };
    });
  const edges = flowEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: typeof e.label === "string" ? e.label : undefined,
    source_handle: e.sourceHandle ?? undefined,
    target_handle: e.targetHandle ?? undefined,
  }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgesFiltered = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...graph, nodes, edges: edgesFiltered };
}

function newNode(type: AgentNode["type"], idx: number): AgentNode {
  const id = `${type}-${crypto.randomUUID()}`;
  const position = { x: 40 + idx * 30, y: 220 + idx * 30 };
  if (type === "llm") {
    return {
      id,
      type,
      name: "LLM",
      position,
      system_prompt: "",
      model: { provider: DEFAULT_LLM_PROVIDER, name: MODEL_OPTIONS[DEFAULT_LLM_PROVIDER][0] },
      tools: [],
      temperature: 0.2,
    };
  }
  if (type === "tool") {
    return {
      id,
      type,
      name: "Tool",
      position,
      tool_name: "Tool",
      language: "python",
      description: "",
      schema: { type: "object", properties: {}, additionalProperties: false },
      code: 'def run(ctx, **kwargs):\n    return {"received": kwargs}\n',
    };
  }
  if (type === "guardrail") {
    return { id, type, name: "Guardrail", position, rule: "" };
  }
  if (type === "router") {
    return { id, type, name: "Router", position, strategy: "first" };
  }
  if (type === "handoff") {
    return { id, type, name: "Handoff", position, target_agent_id: "" };
  }
  if (type === "subagent") {
    return { id, type, name: "Subagent", position, agent_name: "Subagent", agent_revision_id: "", system_prompt: "" };
  }
  if (type === "output") {
    return { id, type, name: "Output", position };
  }
  return { id, type: "input", name: "Input", position, schema: {} };
}

type UndoRedoState<T> = {
  value: T;
  setValue: (updater: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  clearHistory: () => void;
};

function useUndoRedoState<T>(initial: () => T): UndoRedoState<T> {
  const [value, setValue] = useState<T>(initial);
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);
  const applyingHistoryRef = useRef(false);

  const setValueWithHistory = useCallback((updater: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
      if (!applyingHistoryRef.current) {
        setPast((p) => [...p, prev]);
        setFuture([]);
      }
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      applyingHistoryRef.current = true;
      setValue((curr) => {
        setFuture((f) => [curr, ...f]);
        return prev;
      });
      applyingHistoryRef.current = false;
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      applyingHistoryRef.current = true;
      setValue((curr) => {
        setPast((p) => [...p, curr]);
        return next;
      });
      applyingHistoryRef.current = false;
      return f.slice(1);
    });
  }, []);

  const clearHistory = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  return {
    value,
    setValue: setValueWithHistory,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    clearHistory,
  };
}

function AgentFlowNode(props: { data: { label: string; nodeType: string; name: string; issueCount: number }; selected?: boolean }) {
  const { data, selected } = props;
  const isSourceOnly = data.nodeType === "input" || data.nodeType === "tool";
  const isTargetOnly = data.nodeType === "output";

  return (
    <div className={`asFlowNode type-${data.nodeType}${selected ? " isSelected" : ""}`}>
      {!isSourceOnly ? <Handle className="nodrag" type="target" position={Position.Left} /> : null}
      {!isTargetOnly ? <Handle className="nodrag" type="source" position={Position.Right} /> : null}
      <div className="asFlowNodeTitle">
        <span className="asFlowNodeType">{data.nodeType}</span>
        {data.issueCount > 0 ? <span className="asFlowNodeIssue">{data.issueCount}</span> : null}
      </div>
      <div className="asFlowNodeName">{data.name || data.label}</div>
    </div>
  );
}

export function AgentEditorPage(props: { backend: BackendConfig; settings: AppSettings }) {
  const graphState = useUndoRedoState<AgentGraphDocV1>(() => {
    const draft = loadAgentDraft();
    if (draft && draft.schema_version === "graph-v1") {
      return draft as AgentGraphDocV1;
    }
    return DEFAULT_GRAPH;
  });
  const graph = graphState.value;
  const setGraph = graphState.setValue;

  const [revs, setRevs] = useState<AgentRevisionResponse[] | null>(null);
  const [selectedRevId, setSelectedRevId] = useState<string>("");
  const [name, setName] = useState("Visual agent");
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [jsonModal, setJsonModal] = useState<null | { text: string }>(null);
  const [testInputText, setTestInputText] = useState('{"input": ""}');
  const [testOutput, setTestOutput] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [testRunId, setTestRunId] = useState("");
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    | null
    | {
        kind: "node" | "edge";
        id: string;
        x: number;
        y: number;
      }
  >(null);

  const flowRef = useRef<ReactFlowInstance | null>(null);

  const issuesByNodeId = useMemo(() => {
    const m = new Map<string, ValidationIssue[]>();
    for (const it of issues ?? []) {
      if (!it.node_id) continue;
      const arr = m.get(it.node_id) ?? [];
      arr.push(it);
      m.set(it.node_id, arr);
    }
    return m;
  }, [issues]);

  const [flowNodes, setFlowNodes] = useState<Node[]>(() => toFlowNodes(graph, issuesByNodeId));
  const [flowEdges, setFlowEdges] = useState<Edge[]>(() => toFlowEdges(graph));
  const flowNodesRef = useRef(flowNodes);
  const flowEdgesRef = useRef(flowEdges);

  useEffect(() => {
    flowNodesRef.current = flowNodes;
  }, [flowNodes]);

  useEffect(() => {
    flowEdgesRef.current = flowEdges;
  }, [flowEdges]);

  useEffect(() => {
    saveAgentDraft(graph);
  }, [graph]);

  useEffect(() => {
    const nextNodes = toFlowNodes(graph, issuesByNodeId);
    const nextEdges = toFlowEdges(graph);
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return nextNodes.map((node) => {
        const existing = prevById.get(node.id);
        if (!existing) return node;
        return { ...existing, position: node.position, data: node.data, type: node.type };
      });
    });
    setFlowEdges(nextEdges);
  }, [graph, issuesByNodeId]);

  const refreshRevisions = useCallback(async () => {
    try {
      const list = await api(props.backend).listAgentRevisions();
      setRevs(list);
    } catch (e) {
      setRevs(null);
    }
  }, [props.backend]);

  useEffect(() => {
    refreshRevisions();
  }, [refreshRevisions]);

  useEffect(() => {
    if (selectedRevId || !revs || revs.length === 0) return;
    const first = revs[0];
    setSelectedRevId(first.id);
    setName(first.name || "Visual agent");
    loadRevision(first.id);
  }, [revs, selectedRevId]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setFlowNodes((prev) => {
      const next = applyNodeChanges(changes, prev);
      const shouldPersist = changes.some(
        (change) => change.type === "position" || change.type === "remove" || change.type === "add",
      );
      if (shouldPersist) {
        setGraph((g) => mergeFlow(g, next, flowEdgesRef.current));
      }
      return next;
    });
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setFlowEdges((prev) => {
      const next = applyEdgeChanges(changes, prev);
      const shouldPersist = changes.some((change) => change.type === "add" || change.type === "remove");
      if (shouldPersist) {
        setGraph((g) => mergeFlow(g, flowNodesRef.current, next));
      }
      return next;
    });
  }, []);

  const onConnect = useCallback((params: Connection) => {
    setFlowEdges((prev) => {
      const sourceType = flowNodesRef.current.find((n) => n.id === params.source)?.data?.nodeType;
      const targetType = flowNodesRef.current.find((n) => n.id === params.target)?.data?.nodeType;
      if (sourceType === "tool" && targetType !== "llm") {
        return prev;
      }
      if (targetType === "tool") {
        return prev;
      }
      const nextEdges = addEdge(params, prev);
      setGraph((g) => mergeFlow(g, flowNodesRef.current, nextEdges));
      return nextEdges;
    });
  }, []);

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

  const selectedEdge = useMemo(
    () => graph.edges.find((e) => e.id === selectedEdgeId) ?? null,
    [graph.edges, selectedEdgeId],
  );

  const nodeTypes: NodeTypes = useMemo(() => ({ agentNode: AgentFlowNode }), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) graphState.redo();
        else graphState.undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        graphState.redo();
        return;
      }
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void saveRevision();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNodeId) {
          e.preventDefault();
          setGraph((g) => ({
            ...g,
            nodes: g.nodes.filter((n) => n.id !== selectedNodeId),
            edges: g.edges.filter((ed) => ed.source !== selectedNodeId && ed.target !== selectedNodeId),
          }));
          setSelectedNodeId(null);
        } else if (selectedEdgeId) {
          e.preventDefault();
          setGraph((g) => ({ ...g, edges: g.edges.filter((ed) => ed.id !== selectedEdgeId) }));
          setSelectedEdgeId(null);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [graphState, saveRevision, selectedNodeId, selectedEdgeId, setGraph]);

  async function saveRevision() {
    setBusy(true);
    const req: AgentRevisionCreateRequest = {
      name: name.trim() || "Visual agent",
      spec_json: buildEnvelope(graph),
    };
    try {
      const validation = await api(props.backend).validateSpec({ spec: buildEnvelope(graph) });
      setIssues(validation.issues);
      if (!validation.ok || validation.issues.length > 0) {
        return;
      }
      const res = await api(props.backend).createAgentRevision(req);
      setErr(null);
      setIssues(null);
      await refreshRevisions();
      setSelectedRevId(res.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openExportJson() {
    setJsonModal({ text: prettyJson(graph) });
  }

  async function runTest() {
    const parsed = tryParseJsonObject(testInputText);
    if (!parsed.ok) {
      setTestErr("Inputs JSON must be a valid JSON object.");
      return;
    }
    setTestErr(null);
    setTestOutput("");
    setTestStatus("starting");
    setTestRunId("");
    setTestBusy(true);
    try {
      let revisionId = selectedRevId;
      if (!revisionId) {
        const spec = buildEnvelope(graph);
        const validation = await api(props.backend).validateSpec({ spec });
        setIssues(validation.issues);
        if (!validation.ok || validation.issues.length > 0) {
          setTestErr("Fix validation issues before testing.");
          return;
        }
        const res = await api(props.backend).createAgentRevision({
          name: name.trim() || "Visual agent",
          spec_json: spec,
        });
        await refreshRevisions();
        setSelectedRevId(res.id);
        revisionId = res.id;
      }
      const llmConnection = buildLlmConnectionPayload(
        props.settings.llmProvider,
        props.settings.llmConnections[props.settings.llmProvider],
      );
      const res = await api(props.backend).createRun({
        agent_revision_id: revisionId,
        inputs_json: parsed.value,
        tags_json: {},
        group_id: null,
        llm_connection: llmConnection,
      });
      setTestRunId(res.id);
      setTestStatus(res.status);
      let latest = res;
      while (latest && !latest.ended_at && !["completed", "failed", "cancelled"].includes(latest.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        latest = await api(props.backend).getRun(res.id);
        setTestStatus(latest.status);
        if (typeof latest.final_output === "string") {
          setTestOutput(latest.final_output);
        }
        if (latest.error) {
          setTestErr(latest.error);
        }
      }
      if (latest) {
        if (typeof latest.final_output === "string") {
          setTestOutput(latest.final_output);
        }
        if (latest.error) {
          setTestErr(latest.error);
        }
      }
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy(false);
    }
  }

  async function cancelTestRun() {
    if (!testRunId) return;
    try {
      await api(props.backend).cancelRun(testRunId);
      setTestStatus("cancelled");
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    }
  }

  function addNode(type: AgentNode["type"]) {
    setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode(type, g.nodes.length)] }));
  }

  function updateNode(next: AgentNode) {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === next.id ? next : n)) }));
  }

  function updateEdgeLabel(edgeId: string, label: string) {
    setGraph((g) => ({
      ...g,
      edges: g.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)),
    }));
  }

  function deleteNode(nodeId: string) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.filter((n) => n.id !== nodeId),
      edges: g.edges.filter((ed) => ed.source !== nodeId && ed.target !== nodeId),
    }));
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
  }

  function deleteEdge(edgeId: string) {
    setGraph((g) => ({
      ...g,
      edges: g.edges.filter((ed) => ed.id !== edgeId),
    }));
    if (selectedEdgeId === edgeId) {
      setSelectedEdgeId(null);
    }
  }

  function loadRevision(revId: string) {
    if (!revId || !revs) return;
    const rev = revs.find((r) => r.id === revId);
    if (!rev) return;
    const spec = rev.spec_json as AgentSpecEnvelope;
    if (!spec || spec.schema_version !== "graph-v1" || !spec.graph) {
      setErr("Selected revision is not a graph-v1 spec.");
      return;
    }
    setGraph(spec.graph);
    graphState.clearHistory();
    setErr(null);
    setIssues(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }

  return (
    <div className="asEditor">
      <div className="asEditorLeft">
        <div className="asCard">
          <div className="asCardHeader">
            <div className="asCardTitle">Agent editor</div>
          </div>
          <div className="asCardBody">
            <label className="asField">
              <div className="asFieldLabel">Name</div>
              <input className="asInput" value={name} onChange={(e) => setName(e.currentTarget.value)} />
            </label>
            <div className="asRow">
              <button className="asBtn primary" onClick={saveRevision} disabled={busy}>
                Save
              </button>
            </div>
          </div>
        </div>

        <div className="asCard">
          <div className="asCardHeader">
            <div className="asCardTitle">Inspector</div>
          </div>
          <div className="asCardBody">
            {selectedNode ? (
              <NodeInspector
                node={selectedNode}
                issues={issuesByNodeId.get(selectedNode.id) ?? []}
                onChange={updateNode}
                onDelete={deleteNode}
                revisions={revs}
                currentAgentName={name}
                settings={props.settings}
              />
            ) : selectedEdge ? (
              <div className="asStack">
                <div className="asKeyValue">
                  <div className="k">From</div>
                  <div className="v asMono">{selectedEdge.source}</div>
                  <div className="k">To</div>
                  <div className="v asMono">{selectedEdge.target}</div>
                </div>
                <label className="asField">
                  <div className="asFieldLabel">Label</div>
                  <input
                    className="asInput"
                    value={selectedEdge.label ?? ""}
                    onChange={(e) => updateEdgeLabel(selectedEdge.id, e.currentTarget.value)}
                  />
                </label>
                <div className="asRow">
                  <button
                    className="asBtn danger"
                    onClick={() => {
                      setGraph((g) => ({ ...g, edges: g.edges.filter((ed) => ed.id !== selectedEdge.id) }));
                      setSelectedEdgeId(null);
                    }}
                  >
                    Delete edge
                  </button>
                </div>
              </div>
            ) : (
              <div className="asMuted">Select a node or edge to edit details.</div>
            )}
          </div>
        </div>
      </div>

      <div className="asEditorRight">
        <div className="asCard">
          <div className="asCardHeader">
            <div className="asCardTitle">Palette</div>
          </div>
          <div className="asCardBody asRow">
            <button className="asBtn asPaletteBtn type-input" onClick={() => addNode("input")}>
              + Input
            </button>
            <button className="asBtn asPaletteBtn type-llm" onClick={() => addNode("llm")}>
              + LLM
            </button>
            <button className="asBtn asPaletteBtn type-tool" onClick={() => addNode("tool")}>
              + Tool
            </button>
            <button className="asBtn asPaletteBtn type-guardrail" onClick={() => addNode("guardrail")}>
              + Guardrail
            </button>
            <button className="asBtn asPaletteBtn type-router" onClick={() => addNode("router")}>
              + Router
            </button>
            <button className="asBtn asPaletteBtn type-handoff" onClick={() => addNode("handoff")}>
              + Handoff
            </button>
            <button className="asBtn asPaletteBtn type-subagent" onClick={() => addNode("subagent")}>
              + Subagent
            </button>
            <button className="asBtn asPaletteBtn type-output" onClick={() => addNode("output")}>
              + Output
            </button>
          </div>
        </div>
        <div className="asEditorCanvas">
          <div className="asCanvasToolbar">
            <div className="asRow">
              <button className="asBtn sm" onClick={graphState.undo} disabled={!graphState.canUndo}>
                Undo
              </button>
              <button className="asBtn sm" onClick={graphState.redo} disabled={!graphState.canRedo}>
                Redo
              </button>
              <button className="asBtn sm" onClick={openExportJson}>
                Export JSON
              </button>
              <select
                className="asSelect asSelectInline asSelectUnderline"
                value={selectedRevId}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  setSelectedRevId(next);
                  loadRevision(next);
                }}
              >
                <option value="">Load a previous revision...</option>
                {(revs ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {formatRelativeTime(r.created_at)} · {r.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <div className="asCanvasMeta">
                <span className="asMono">{graph.nodes.length}</span> nodes ·{" "}
                <span className="asMono">{graph.edges.length}</span> edges ·{" "}
                <span className="asMono">{issues?.length ?? 0}</span> issues
              </div>
            </div>
          </div>
          {err || (issues && issues.length > 0) ? (
            <div className="asCanvasToolbar asCanvasToolbarSecondary">
              {issues && issues.length > 0
                ? issues.map((issue, idx) => (
                    <button
                      key={`${issue.code}-${idx}`}
                      className="asIssueItem asIssueButton asCanvasErrorText"
                      onClick={() => {
                        if (!issue.node_id) return;
                        setSelectedNodeId(issue.node_id);
                        setSelectedEdgeId(null);
                        const inst = flowRef.current;
                        const n = inst?.getNode(issue.node_id);
                        if (inst && n) {
                          inst.fitView({ nodes: [n], padding: 0.45, duration: 220 });
                        }
                      }}
                    >
                      <span className="asCanvasErrorSep"> • </span>
                      <span className="asMono">{issue.code}</span> {issue.message}
                    </button>
                  ))
                : null}
            </div>
          ) : null}
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            onInit={(inst) => {
              flowRef.current = inst;
            }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setContextMenu({ kind: "node", id: node.id, x: event.clientX, y: event.clientY });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              setContextMenu({ kind: "edge", id: edge.id, x: event.clientX, y: event.clientY });
            }}
            onPaneClick={() => {
              setContextMenu(null);
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
          {contextMenu ? (
            <div
              className="asContextMenu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={() => setContextMenu(null)}
            >
              {contextMenu.kind === "node" ? (
                <button className="asBtn sm danger" onClick={() => deleteNode(contextMenu.id)}>
                  Delete node
                </button>
              ) : (
                <button className="asBtn sm danger" onClick={() => deleteEdge(contextMenu.id)}>
                  Delete edge
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="asEditorFooter">
        <div className="asEditorFooterGrid">
          <div className="asCard">
            <div className="asCardHeader">
              <div className="asCardTitle">Test agent</div>
            </div>
            <div className="asCardBody asStack">
              <label className="asField">
                <div className="asFieldLabel">Inputs JSON</div>
                <textarea
                  className="asTextarea"
                  rows={5}
                  value={testInputText}
                  onChange={(e) => setTestInputText(e.currentTarget.value)}
                />
              </label>
              <div className="asRow">
                <button className="asBtn primary" onClick={runTest} disabled={testBusy}>
                  {testBusy ? "Running..." : "Run test"}
                </button>
                <button
                  className="asBtn"
                  onClick={cancelTestRun}
                  disabled={!testRunId || !["queued", "running", "starting"].includes(testStatus)}
                >
                  Cancel
                </button>
                {testStatus ? <div className="asMuted">Status: {testStatus}</div> : null}
                {testRunId ? <div className="asMuted">Run ID: {testRunId.slice(0, 8)}</div> : null}
              </div>
              {testErr ? <div className="asIssueItem asCanvasErrorText">{testErr}</div> : null}
              <label className="asField">
                <div className="asFieldLabel">Final output</div>
                <textarea className="asTextarea" rows={6} value={testOutput} readOnly />
              </label>
            </div>
          </div>
          <TraceViewer
            backend={props.backend}
            runId={testRunId || null}
            mode="stream"
            emptyMessage="Run a test to stream events here."
            waitingMessage="Waiting for events…"
            title="Test trace"
          />
        </div>
      </div>

      {jsonModal ? (
        <div
          className="asModalBackdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setJsonModal(null);
          }}
        >
          <div className="asModal">
            <div className="asModalHeader">
              <div className="asModalTitle">Export graph JSON</div>
              <button className="asBtn" onClick={() => setJsonModal(null)}>
                Close
              </button>
            </div>
            <div className="asModalBody">
              <textarea
                className="asTextarea"
                rows={18}
                value={jsonModal.text}
                onChange={(e) => setJsonModal((m) => (m ? { ...m, text: e.currentTarget.value } : m))}
              />
              <div className="asRow">
                <button
                  className="asBtn primary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(jsonModal.text);
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NodeInspector(props: {
  node: AgentNode;
  issues: ValidationIssue[];
  onChange: (node: AgentNode) => void;
  onDelete: (nodeId: string) => void;
  revisions: AgentRevisionResponse[] | null;
  currentAgentName: string;
  settings: AppSettings;
}) {
  const { node, issues, onChange, onDelete, revisions, currentAgentName, settings } = props;
  const [schemaText, setSchemaText] = useState(() =>
    node.type === "tool" ? prettyJson(node.schema ?? {}) : "{}",
  );

  useEffect(() => {
    if (node.type === "tool") {
      setSchemaText(prettyJson(node.schema ?? {}));
    }
  }, [node]);

  const revisionsByAgent = useMemo(() => {
    const map = new Map<string, AgentRevisionResponse[]>();
    for (const rev of revisions ?? []) {
      if (rev.name === currentAgentName) continue;
      const list = map.get(rev.name) ?? [];
      list.push(rev);
      map.set(rev.name, list);
    }
    for (const [key, list] of map.entries()) {
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      map.set(key, list);
    }
    return map;
  }, [revisions, currentAgentName]);
  const agentNames = useMemo(() => Array.from(revisionsByAgent.keys()).sort(), [revisionsByAgent]);
  const selectedAgentRevisions =
    node.type === "subagent" && node.agent_name ? revisionsByAgent.get(node.agent_name) ?? [] : [];

  const modelProvider = useMemo<LlmProvider>(() => {
    if (node.type !== "llm") return settings.llmProvider;
    const model = node.model ?? {};
    if (typeof model !== "object" || Array.isArray(model) || !model) return settings.llmProvider;
    const provider = (model as { provider?: unknown }).provider;
    return isLlmProvider(provider) ? provider : settings.llmProvider;
  }, [node, settings.llmProvider]);

  const modelName = useMemo(() => {
    if (node.type !== "llm") return "";
    const model = node.model ?? {};
    if (typeof model !== "object" || Array.isArray(model) || !model) return "";
    return typeof (model as { name?: unknown }).name === "string" ? ((model as { name?: string }).name ?? "") : "";
  }, [node]);

  const modelOptions = useMemo(() => {
    const base = MODEL_OPTIONS[modelProvider] ?? [];
    const next = [...base];
    const preferredModel = settings.llmConnections[modelProvider]?.model?.trim() ?? "";
    for (const candidate of [preferredModel, modelName]) {
      if (candidate && !next.includes(candidate)) {
        next.unshift(candidate);
      }
    }
    return next;
  }, [modelProvider, modelName, settings.llmConnections]);

  function updateLlmModel(nextProvider: LlmProvider, nextName: string) {
    if (node.type !== "llm") return;
    const nextModel = {
      ...(node.model as Record<string, unknown> | undefined),
      provider: nextProvider,
      name: nextName,
    };
    updateLLM({ model: nextModel });
  }

  useEffect(() => {
    if (node.type !== "subagent") return;
    if (!node.agent_name) return;
    const list = revisionsByAgent.get(node.agent_name) ?? [];
    if (list.length === 0) return;
    const hasSelected = node.agent_revision_id && list.some((rev) => rev.id === node.agent_revision_id);
    if (!hasSelected) {
      onChange({ ...node, agent_revision_id: list[0].id });
    }
  }, [node, onChange, revisionsByAgent]);

  function updateLLM(next: Partial<LLMNode>) {
    if (node.type !== "llm") return;
    onChange({ ...node, ...next });
  }

  function updateTool(next: Partial<ToolNode>) {
    if (node.type !== "tool") return;
    onChange({ ...node, ...next });
  }

  return (
    <div className="asStack">
      {issues.length > 0 ? (
        <div className="asIssueList">
          {issues.map((issue, idx) => (
            <div key={`${issue.code}-${idx}`} className="asIssueItem">
              <span className="asMono">{issue.code}</span> {issue.message}
            </div>
          ))}
        </div>
      ) : null}
      <label className="asField">
        <div className="asFieldLabel">Name</div>
        <input
          className="asInput"
          value={node.name ?? ""}
          onChange={(e) => {
            const nextName = e.currentTarget.value;
            if (node.type === "tool") {
              onChange({ ...node, name: nextName, tool_name: nextName });
            } else {
              onChange({ ...node, name: nextName });
            }
          }}
        />
      </label>

      {node.type === "llm" ? (
        <>
          <label className="asField">
            <div className="asFieldLabel">System prompt</div>
            <textarea className="asTextarea" rows={6} value={node.system_prompt ?? ""} onChange={(e) => updateLLM({ system_prompt: e.currentTarget.value })} />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Provider</div>
            <select
              className="asSelect"
              value={modelProvider}
              onChange={(e) => {
                const nextProvider = e.currentTarget.value as LlmProvider;
                const nextName = (MODEL_OPTIONS[nextProvider]?.[0] ?? modelName ?? "").trim();
                updateLlmModel(nextProvider, nextName);
              }}
            >
              {LLM_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {LLM_PROVIDER_LABELS[provider]}
                </option>
              ))}
            </select>
          </label>
          <label className="asField">
            <div className="asFieldLabel">Model</div>
            <select
              className="asSelect"
              value={modelName || modelOptions[0] || ""}
              onChange={(e) => {
                const nextName = e.currentTarget.value;
                updateLlmModel(modelProvider, nextName);
              }}
            >
              {modelOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="asField">
            <div className="asFieldLabel">Temperature</div>
            <input
              className="asInput"
              type="number"
              step="0.1"
              value={node.temperature ?? 0}
              onChange={(e) => updateLLM({ temperature: Number(e.currentTarget.value) })}
            />
          </label>
        </>
      ) : null}

      {node.type === "tool" ? (
        <>
          <label className="asField">
            <div className="asFieldLabel">Language</div>
            <select className="asSelect" value={node.language ?? "python"} onChange={(e) => updateTool({ language: e.currentTarget.value })}>
              <option value="python">Python</option>
            </select>
          </label>
          <label className="asField">
            <div className="asFieldLabel">Description</div>
            <textarea className="asTextarea" rows={4} value={node.description ?? ""} onChange={(e) => updateTool({ description: e.currentTarget.value })} />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Code</div>
            <textarea className="asTextarea" rows={8} value={node.code ?? ""} onChange={(e) => updateTool({ code: e.currentTarget.value })} />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Schema JSON</div>
            <textarea
              className="asTextarea"
              rows={4}
              value={schemaText}
              onChange={(e) => setSchemaText(e.currentTarget.value)}
              onBlur={() => {
                const parsed = tryParseJsonObject(schemaText);
                if (parsed.ok) updateTool({ schema: parsed.value });
              }}
            />
          </label>
        </>
      ) : null}

      {node.type === "guardrail" ? (
        <label className="asField">
          <div className="asFieldLabel">Rule</div>
          <textarea className="asTextarea" rows={4} value={node.rule ?? ""} onChange={(e) => onChange({ ...node, rule: e.currentTarget.value })} />
        </label>
      ) : null}

      {node.type === "router" ? (
        <label className="asField">
          <div className="asFieldLabel">Strategy</div>
          <input className="asInput" value={node.strategy ?? ""} onChange={(e) => onChange({ ...node, strategy: e.currentTarget.value })} />
        </label>
      ) : null}

      {node.type === "handoff" ? (
        <label className="asField">
          <div className="asFieldLabel">Target agent ID</div>
          <input className="asInput" value={node.target_agent_id} onChange={(e) => onChange({ ...node, target_agent_id: e.currentTarget.value })} />
        </label>
      ) : null}

      {node.type === "subagent" ? (
        <>
          <label className="asField">
            <div className="asFieldLabel">Agent name</div>
            <select
              className="asSelect"
              value={node.agent_name}
              onChange={(e) => {
                const nextAgent = e.currentTarget.value;
                const nextRevs = revisionsByAgent.get(nextAgent) ?? [];
                onChange({ ...node, agent_name: nextAgent, agent_revision_id: nextRevs[0]?.id ?? "" });
              }}
            >
              <option value="">Select agent…</option>
              {node.agent_name &&
              node.agent_name !== currentAgentName &&
              !(revisions ?? []).some((rev) => rev.name === node.agent_name) ? (
                <option value={node.agent_name}>{node.agent_name}</option>
              ) : null}
              {agentNames.map((agent) => (
                <option key={agent} value={agent}>
                  {agent}
                </option>
              ))}
            </select>
          </label>
          <label className="asField">
            <div className="asFieldLabel">Agent version</div>
            <select
              className="asSelect"
              value={node.agent_revision_id ?? ""}
              onChange={(e) => onChange({ ...node, agent_revision_id: e.currentTarget.value })}
              disabled={!node.agent_name || selectedAgentRevisions.length === 0}
            >
              <option value="">Latest revision</option>
              {selectedAgentRevisions.map((rev) => (
                <option key={rev.id} value={rev.id}>
                  {formatRelativeTime(rev.created_at)} · {rev.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="asField">
            <div className="asFieldLabel">System prompt</div>
            <textarea className="asTextarea" rows={4} value={node.system_prompt ?? ""} onChange={(e) => onChange({ ...node, system_prompt: e.currentTarget.value })} />
          </label>
        </>
      ) : null}

      <div className="asRow">
        <button className="asBtn danger" onClick={() => onDelete(node.id)}>
          Delete node
        </button>
      </div>
    </div>
  );
}
