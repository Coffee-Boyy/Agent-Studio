import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
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
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api, type BackendConfig } from "../lib/api";
import { formatDateTime, prettyJson, tryParseJsonObject } from "../lib/json";
import {
  buildLlmConnectionPayload,
  DEFAULT_LLM_PROVIDER,
  fetchModelsFromProvider,
  isLlmProvider,
  LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  MODEL_OPTIONS,
  type LlmProvider,
} from "../lib/llm";
import { loadAgentDraft, saveAgentDraft, type AppSettings, type TestRunEntry } from "../lib/storage";
import type {
  AgentGraphDocV1,
  AgentGraphNode,
  AgentNode,
  AgentRevisionCreateRequest,
  AgentRevisionResponse,
  AgentSpecEnvelope,
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
      id: "agent-1",
      type: "agent",
      name: "Main Agent",
      position: { x: 320, y: 80 },
      instructions: "You are a helpful agent.",
      model: { provider: DEFAULT_LLM_PROVIDER, name: MODEL_OPTIONS[DEFAULT_LLM_PROVIDER][0] },
      tools: [],
      input_guardrails: [],
      output_guardrails: [],
      output_type: null,
    },
    {
      id: "output-1",
      type: "output",
      name: "Output",
      position: { x: 620, y: 80 },
    },
  ],
  edges: [
    { id: "edge-1", source: "input-1", target: "agent-1" },
    { id: "edge-2", source: "agent-1", target: "output-1" },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  metadata: {},
};

type NodeHelpContent = {
  title: string;
  summary: string;
  connections: string[];
  fields: string[];
  tips: string[];
};

const NODE_HELP: Record<AgentGraphNode["type"], NodeHelpContent> = {
  input: {
    title: "Input node",
    summary:
      "Defines the entry point for data flowing into the workflow. Use this node to describe the shape of incoming inputs and to make validation explicit.",
    connections: [
      "Source-only node: connects to agents or tools that consume input.",
      "Typically the first node in a workflow.",
    ],
    fields: ["Name: friendly label used in the graph.", "Schema: JSON schema describing the expected input payload."],
    tips: [
      "Keep the schema minimal but accurate to help validation.",
      "Use examples in your test runs to match this schema.",
    ],
  },
  agent: {
    title: "Agent node",
    summary:
      "Runs an LLM-powered agent that interprets instructions, uses tools, and produces outputs. This is the core reasoning unit in a workflow.",
    connections: [
      "Accepts inputs from upstream nodes (input, tool, or other agents).",
      "Can connect to tools and outputs.",
    ],
    fields: [
      "Instructions: system prompt for the agent.",
      "Provider/Model: LLM configuration for this agent.",
      "Workspace root: optional sandbox root for file operations.",
      "Guardrails: optional input/output validation policies.",
      "Output schema: optional JSON schema describing structured output.",
    ],
    tips: ["Keep instructions focused on role + task.", "Add output schema when downstream steps need structured data."],
  },
  tool: {
    title: "Tool node",
    summary:
      "Defines a callable tool that the agent can execute. Tools are small, deterministic functions that return structured data.",
    connections: [
      "Source-only node: connects to agent nodes only.",
      "Agents call tools during reasoning; tools return data to the agent.",
    ],
    fields: [
      "Name/Tool name: how the agent calls the tool.",
      "Description: guidance for when to use the tool.",
      "Code: implementation of the tool.",
      "Schema: JSON schema for tool arguments.",
    ],
    tips: ["Keep tools side-effect focused and narrow in scope.", "Match the schema to the expected arguments."],
  },
  loop_group: {
    title: "Loop group",
    summary:
      "Evaluates a condition to decide whether to repeat part of the workflow or exit. Use it to implement bounded iteration.",
    connections: [
      "Contains nodes that repeat as a subflow.",
      "Has one entry edge and one exit edge.",
    ],
    fields: [
      "Condition: expression evaluated against last output + inputs.",
      "Max iterations: hard cap to prevent infinite loops.",
    ],
    tips: [
      "Use `iteration`, `last`, `inputs`, and `max_iterations` in expressions.",
      "Connect into the group and out of the group once.",
    ],
  },
  output: {
    title: "Output node",
    summary:
      "Marks the final output of the workflow. Use this node to capture the last response from the graph.",
    connections: ["Target-only node: receives output from the final agent.", "Typically the last node in the workflow."],
    fields: ["Name: friendly label for the output."],
    tips: ["Use a single output node to simplify downstream consumers.", "Pair with output schema on the agent for structure."],
  },
};

function buildEnvelope(graph: AgentGraphDocV1): AgentSpecEnvelope {
  return {
    schema_version: "graph-v1",
    graph,
    compiled: null,
    metadata: {},
  };
}

function formatInputPreview(inputs: Record<string, unknown>): string {
  const rawInput = inputs?.input;
  let preview = "";
  if (typeof rawInput === "string") {
    preview = rawInput;
  } else {
    try {
      preview = JSON.stringify(inputs);
    } catch {
      preview = "[unserializable inputs]";
    }
  }
  const singleLine = preview.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

function formatRelativeTime(isoTime: string): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const trimmed = isoTime.trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const date = new Date(hasZone ? trimmed : `${trimmed}Z`);
  if (Number.isNaN(date.getTime())) return "unknown";
  const diffMs = Date.now() - date.getTime();
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

function tryParseJsonValue(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function toFlowNodes(graph: AgentGraphDocV1, issuesByNodeId: Map<string, ValidationIssue[]>): Node[] {
  const nodes: Node[] = graph.nodes.map((n) => {
    const base = {
      id: n.id,
      position: n.position,
      data: {
        label: `${n.type}${n.name ? `: ${n.name}` : ""}`,
        nodeType: n.type,
        name: n.name ?? "",
        issueCount: issuesByNodeId.get(n.id)?.length ?? 0,
      },
    };
    const parentId = typeof (n as { parent_id?: unknown }).parent_id === "string" ? (n as { parent_id?: string }).parent_id : undefined;
    if (n.type === "loop_group") {
      const width = typeof (n as { width?: unknown }).width === "number" ? (n as { width: number }).width : 360;
      const height = typeof (n as { height?: unknown }).height === "number" ? (n as { height: number }).height : 240;
      return {
        ...base,
        type: "group",
        style: { width, height },
      } as Node;
    }
    return {
      ...base,
      type: "agentNode",
      parentId,
    } as Node;
  });
  return nodes.sort(sortNodesForReactFlow);
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

function edgesFromFlow(flowEdges: Edge[]): AgentGraphDocV1["edges"] {
  return flowEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: typeof e.label === "string" ? e.label : undefined,
    source_handle: e.sourceHandle ?? undefined,
    target_handle: e.targetHandle ?? undefined,
  }));
}

function getNodeSize(node: Node): { width: number; height: number } | null {
  const style = node.style ?? {};
  const width = typeof node.width === "number" ? node.width : typeof style.width === "number" ? style.width : null;
  const height = typeof node.height === "number" ? node.height : typeof style.height === "number" ? style.height : null;
  if (typeof width === "number" && typeof height === "number") {
    return { width, height };
  }
  return null;
}

// React Flow requires parent nodes to appear before their children in the array.
// This ensures groups are rendered before their child nodes.
function sortNodesForReactFlow(a: Node, b: Node): number {
  if (a.type === b.type) return 0;
  return a.type === "group" && b.type !== "group" ? -1 : 1;
}

function newNode(type: AgentGraphNode["type"], idx: number): AgentGraphNode {
  const id = `${type}-${crypto.randomUUID()}`;
  const position = { x: 40 + idx * 30, y: 220 + idx * 30 };
  if (type === "agent") {
    return {
      id,
      type,
      name: "Agent",
      position,
      instructions: "",
      model: { provider: DEFAULT_LLM_PROVIDER, name: MODEL_OPTIONS[DEFAULT_LLM_PROVIDER][0] },
      tools: [],
      input_guardrails: [],
      output_guardrails: [],
      output_type: null,
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
  if (type === "loop_group") {
    return {
      id,
      type,
      name: "Loop group",
      position,
      condition: "iteration < max_iterations",
      max_iterations: 3,
      width: 360,
      height: 240,
    };
  }
  if (type === "output") {
    return { id, type, name: "Output", position };
  }
  return { id, type: "input", name: "Input", position, schema: {} };
}

function migrateLegacyGraph(graph: AgentGraphDocV1): AgentGraphDocV1 {
  const migratedNodes: AgentGraphNode[] = [];
  for (const node of graph.nodes as Array<Record<string, unknown>>) {
    const type = node.type;
    if (type === "agent") {
      migratedNodes.push(node as AgentGraphNode);
      continue;
    }
    if (type === "llm" || type === "code_editor") {
      migratedNodes.push({
        id: String(node.id ?? crypto.randomUUID()),
        type: "agent",
        name: typeof node.name === "string" ? node.name : type === "code_editor" ? "Code editor" : "Agent",
        position: (node.position as AgentGraphNode["position"]) ?? { x: 0, y: 0 },
        instructions: typeof node.system_prompt === "string" ? node.system_prompt : "",
        model: (node.model as Record<string, unknown>) ?? {},
        tools: Array.isArray(node.tools) ? (node.tools as string[]) : [],
        input_guardrails: [],
        output_guardrails: [],
        output_type: null,
        workspace_root: typeof node.workspace_root === "string" ? node.workspace_root : undefined,
      });
      continue;
    }
    if (type === "loop") {
      migratedNodes.push({
        id: String(node.id ?? crypto.randomUUID()),
        type: "loop_group",
        name: typeof node.name === "string" ? node.name : "Loop group",
        position: (node.position as AgentGraphNode["position"]) ?? { x: 0, y: 0 },
        condition: typeof node.condition === "string" ? node.condition : "iteration < max_iterations",
        max_iterations: typeof node.max_iterations === "number" ? node.max_iterations : 3,
        width: typeof node.width === "number" ? node.width : 360,
        height: typeof node.height === "number" ? node.height : 240,
      });
      continue;
    }
    if (type === "tool" || type === "input" || type === "output" || type === "loop_group") {
      migratedNodes.push(node as AgentGraphNode);
      continue;
    }
  }
  const nodeIds = new Set(migratedNodes.map((n) => n.id));
  const edges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return { ...graph, nodes: migratedNodes, edges };
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

function LoopGroupFlowNode(props: { data: { label: string; nodeType: string; name: string } }) {
  const { data } = props;
  return (
    <div className={`asFlowGroup type-${data.nodeType}`}>
      <div className="asFlowGroupTitle">
        <span className="asFlowGroupType">loop group</span>
      </div>
      <div className="asFlowGroupName">{data.name || data.label}</div>
    </div>
  );
}

export function AgentEditorPage(props: {
  backend: BackendConfig;
  settings: AppSettings;
  onStartRun: (runId: string) => void;
  selectedRevisionId?: string;
  onSelectRevision?: (revId: string) => void;
  onRevisionsChange?: (revs: AgentRevisionResponse[]) => void;
}) {
  const graphState = useUndoRedoState<AgentGraphDocV1>(() => {
    const draft = loadAgentDraft();
    if (draft && draft.schema_version === "graph-v1") {
      return migrateLegacyGraph(draft as AgentGraphDocV1);
    }
    return DEFAULT_GRAPH;
  });
  const graph = graphState.value;
  const setGraph = graphState.setValue;

  const [revs, setRevs] = useState<AgentRevisionResponse[] | null>(null);
  const [selectedRevId, setSelectedRevId] = useState<string>("");
  const [name, setName] = useState("New Workflow");
  const [baselineName, setBaselineName] = useState("New Workflow");
  const [baselineGraphJson, setBaselineGraphJson] = useState(() => JSON.stringify(graphState.value));
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodeHelpOpen, setNodeHelpOpen] = useState(false);
  const [jsonModal, setJsonModal] = useState<null | { text: string }>(null);
  const [testInputText, setTestInputText] = useState('{"input": "Create a simple HTML page"}');
  const [testOutput, setTestOutput] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [testRunId, setTestRunId] = useState("");
  const [testTraceMode, setTestTraceMode] = useState<"stream" | "static">("stream");
  const [testRunHistory, setTestRunHistory] = useState<TestRunEntry[]>([]);
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
      return nextNodes
        .map((node) => {
          const existing = prevById.get(node.id);
          if (!existing) return node;
          // Merge existing node with graph-derived values.
          // Important: parentId, extent, position, data, and type must come from the graph
          // to ensure coordinate system consistency (relative vs absolute positions).
          return {
            ...existing,
            position: node.position,
            data: node.data,
            type: node.type,
            parentId: node.parentId,
            extent: node.extent,
          };
        })
        .sort(sortNodesForReactFlow);
    });
    setFlowEdges(nextEdges);
  }, [graph, issuesByNodeId]);

  const refreshRevisions = useCallback(async () => {
    try {
      const list = await api(props.backend).listAgentRevisions();
      setRevs(list);
      props.onRevisionsChange?.(list);
    } catch (e) {
      setRevs(null);
    }
  }, [props.backend, props.onRevisionsChange]);

  useEffect(() => {
    refreshRevisions();
  }, [refreshRevisions]);

  const selectRevision = useCallback(
    (revId: string) => {
      setSelectedRevId(revId);
      props.onSelectRevision?.(revId);
      loadRevision(revId);
    },
    [loadRevision, props.onSelectRevision],
  );

  useEffect(() => {
    if (!props.selectedRevisionId) return;
    if (props.selectedRevisionId === selectedRevId) return;
    setSelectedRevId(props.selectedRevisionId);
    loadRevision(props.selectedRevisionId);
  }, [props.selectedRevisionId, selectedRevId]);

  useEffect(() => {
    if (selectedRevId || !revs || revs.length === 0) return;
    const first = revs[0];
    selectRevision(first.id);
    setName(first.name || "New Workflow");
  }, [revs, selectedRevId, selectRevision]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setFlowNodes((prev) => {
      const next = applyNodeChanges(changes, prev);
      const shouldPersist = changes.some((change) => change.type === "remove");
      if (shouldPersist) {
        setGraph((g) => {
          const nodeIds = new Set(next.map((node) => node.id));
          const nodes = g.nodes.filter((node) => nodeIds.has(node.id));
          const edges = g.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
          return { ...g, nodes, edges };
        });
      }
      return next;
    });
  }, []);

  const onNodeDragStop: OnNodeDrag = useCallback((_, dragged) => {
    // For groups, just sync their position to the graph (no reparenting logic)
    if (dragged.type === "group") {
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === dragged.id ? { ...n, position: dragged.position } : n
        ),
      }));
      return;
    }

    setFlowNodes((prev) => {
      const current = prev.find((n) => n.id === dragged.id);
      if (!current) return prev;

      const loopGroupNodes = prev.filter((n) => n.type === "group");
      if (loopGroupNodes.length === 0) {
        // No groups, but still sync all positions to the graph to prevent position drift
        setGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const flowNode = prev.find((fn) => fn.id === n.id);
            if (flowNode) {
              return { ...n, position: flowNode.position };
            }
            return n;
          }),
        }));
        return prev;
      }

      const prevParentId = typeof current.parentId === "string" ? current.parentId : undefined;

      // Calculate the absolute position of the dragged node.
      // If the node currently has a parent, dragged.position is relative to the parent,
      // so we need to add the parent's position to get absolute coordinates.
      let absolutePosition = { ...dragged.position };
      if (prevParentId) {
        const currentParent = prev.find((n) => n.id === prevParentId);
        if (currentParent) {
          absolutePosition = {
            x: dragged.position.x + currentParent.position.x,
            y: dragged.position.y + currentParent.position.y,
          };
        }
      }

      const draggedSize = getNodeSize(dragged) ?? getNodeSize(current) ?? { width: 0, height: 0 };
      const draggedCenter = {
        x: absolutePosition.x + draggedSize.width / 2,
        y: absolutePosition.y + draggedSize.height / 2,
      };

      // Find groups that contain the node's center point
      const containingGroups = loopGroupNodes.filter((group) => {
        const groupSize = getNodeSize(group);
        if (!groupSize) return false;
        return (
          draggedCenter.x >= group.position.x &&
          draggedCenter.x <= group.position.x + groupSize.width &&
          draggedCenter.y >= group.position.y &&
          draggedCenter.y <= group.position.y + groupSize.height
        );
      });

      // Pick the smallest containing group (most specific)
      const nextParentId = containingGroups
        .sort((a, b) => {
          const aSize = getNodeSize(a);
          const bSize = getNodeSize(b);
          const aArea = aSize ? aSize.width * aSize.height : Number.POSITIVE_INFINITY;
          const bArea = bSize ? bSize.width * bSize.height : Number.POSITIVE_INFINITY;
          return aArea - bArea;
        })[0]?.id;

      // Calculate the new position based on the new parent (even if parent didn't change,
      // we need to sync positions to the graph)
      let newPosition: { x: number; y: number };
      if (nextParentId === prevParentId) {
        // No change in parent - use the dragged position as-is
        newPosition = dragged.position;
      } else if (nextParentId) {
        // Node is being parented to a group: convert absolute to relative position
        const newParent = prev.find((n) => n.id === nextParentId);
        if (newParent) {
          const parentSize = getNodeSize(newParent) ?? { width: 0, height: 0 };
          // Calculate relative position inside parent
          let relX = absolutePosition.x - newParent.position.x;
          let relY = absolutePosition.y - newParent.position.y;
          // Clamp to stay within parent bounds
          relX = Math.max(0, Math.min(relX, parentSize.width - draggedSize.width));
          relY = Math.max(0, Math.min(relY, parentSize.height - draggedSize.height));
          newPosition = { x: relX, y: relY };
        } else {
          newPosition = absolutePosition;
        }
      } else {
        // Node is being removed from a parent: use the absolute position
        newPosition = absolutePosition;
      }

      // If parent didn't change, just sync all positions to the graph
      if (nextParentId === prevParentId) {
        setGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            if (n.id === current.id) {
              return { ...n, position: newPosition };
            }
            // Sync other node positions from flow state to prevent position drift
            const flowNode = prev.find((fn) => fn.id === n.id);
            if (flowNode) {
              return { ...n, position: flowNode.position };
            }
            return n;
          }),
        }));
        return prev;
      }

      const next = prev
        .map((n) => {
          if (n.id !== current.id) return n;
          return {
            ...n,
            position: newPosition,
            parentId: nextParentId,
            extent: nextParentId ? ("parent" as const) : undefined,
          };
        })
        .sort(sortNodesForReactFlow);

      // Update the graph state with new parent_id and position for the dragged node,
      // AND sync positions for all other nodes to prevent position drift
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          if (n.id === current.id) {
            return { ...n, parent_id: nextParentId, position: newPosition };
          }
          // Sync other node positions from flow state
          const flowNode = prev.find((fn) => fn.id === n.id);
          if (flowNode) {
            return { ...n, position: flowNode.position };
          }
          return n;
        }),
      }));

      return next;
    });
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setFlowEdges((prev) => {
      const next = applyEdgeChanges(changes, prev);
      const shouldPersist = changes.some((change) => change.type === "add" || change.type === "remove");
      if (shouldPersist) {
        setGraph((g) => {
          const nodeIds = new Set(g.nodes.map((node) => node.id));
          const edges = edgesFromFlow(next).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
          return { ...g, edges };
        });
      }
      return next;
    });
  }, []);

  const onConnect = useCallback((params: Connection) => {
    setFlowEdges((prev) => {
      const sourceType = flowNodesRef.current.find((n) => n.id === params.source)?.data?.nodeType;
      const targetType = flowNodesRef.current.find((n) => n.id === params.target)?.data?.nodeType;
      const isAgentTarget = targetType === "agent";
      if (sourceType === "output" || targetType === "input") {
        return prev;
      }
      if (sourceType === "tool" && !isAgentTarget) {
        return prev;
      }
      if (targetType === "tool") {
        return prev;
      }
      if (sourceType === "loop_group" || targetType === "loop_group") {
        return prev;
      }
      const nextEdges = addEdge(params, prev);
      setGraph((g) => {
        const nodeIds = new Set(g.nodes.map((node) => node.id));
        const edges = edgesFromFlow(nextEdges).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
        return { ...g, edges };
      });
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

  useEffect(() => {
    if (!selectedNodeId) {
      setNodeHelpOpen(false);
    }
  }, [selectedNodeId]);

  const loopGroups = useMemo(
    () => graph.nodes.filter((node) => node.type === "loop_group"),
    [graph.nodes],
  );
  const nodeTypes: NodeTypes = useMemo(() => ({ agentNode: AgentFlowNode, group: LoopGroupFlowNode }), []);

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
      selectRevision(res.id);
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
    setTestTraceMode("stream");
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
        selectRevision(res.id);
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
      props.onStartRun(res.id);
      const entry = {
        id: res.id,
        started_at: new Date().toISOString(),
        inputs_json: parsed.value,
        final_output: res.final_output ?? null,
      };
      setTestRunHistory((prev) => [entry, ...prev.filter((it) => it.id !== entry.id)].slice(0, 5));
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

  async function recallTestRun(entry: TestRunEntry) {
    setTestInputText(prettyJson(entry.inputs_json ?? {}));
    setTestOutput("");
    setTestErr(null);
    setTestStatus("");
    setTestRunId(entry.id);
    setTestTraceMode("static");
    setTestBusy(false);
    try {
      const run = await api(props.backend).getRun(entry.id);
      setTestStatus(run.status);
      setTestInputText(prettyJson(run.inputs_json ?? entry.inputs_json ?? {}));
      if (typeof run.final_output === "string") {
        setTestOutput(run.final_output);
      }
      if (run.error) {
        setTestErr(run.error);
      }
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    }
  }

  function addNode(type: AgentGraphNode["type"]) {
    setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode(type, g.nodes.length)] }));
  }

  function updateNode(next: AgentGraphNode) {
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
    const nextGraph = migrateLegacyGraph(spec.graph);
    setGraph(nextGraph);
    setBaselineGraphJson(JSON.stringify(nextGraph));
    graphState.clearHistory();
    const nextName = rev.name || "New Workflow";
    setName(nextName);
    setBaselineName(nextName);
    setErr(null);
    setIssues(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    // Reset the graph editor viewport
    setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 200 }), 50);
  }

  async function createNewWorkflow() {
    setGraph(DEFAULT_GRAPH);
    setBaselineGraphJson(JSON.stringify(DEFAULT_GRAPH));
    graphState.clearHistory();
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedRevId("");
    props.onSelectRevision?.("");
    setIssues(null);
    setErr(null);
    setName("New Workflow");
    setBaselineName("New Workflow");
    // Reset the graph editor viewport
    setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 200 }), 50);

    setBusy(true);
    try {
      const res = await api(props.backend).createAgentRevision({
        name: "New Workflow",
        spec_json: buildEnvelope(DEFAULT_GRAPH),
      });
      await refreshRevisions();
      selectRevision(res.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  const nameChanged = name.trim() !== baselineName.trim();
  const graphChanged = graphJson !== baselineGraphJson;
  const isUnsaved = nameChanged || graphChanged;

  const activeWorkflowName = useMemo(() => {
    const selected = revs?.find((rev) => rev.id === selectedRevId);
    if (selected?.name) return selected.name;
    const baseline = baselineName.trim();
    return baseline || name.trim();
  }, [revs, selectedRevId, baselineName, name]);

  const workflowRevisions = useMemo(() => {
    if (!revs || !activeWorkflowName) return [];
    const trimmedName = activeWorkflowName.trim();
    return revs
      .filter((rev) => (rev.name || "").trim() === trimmedName)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [revs, activeWorkflowName]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedRevId || !activeWorkflowName) {
      setTestRunHistory([]);
      return () => {
        cancelled = true;
      };
    }

    async function loadRuns() {
      try {
        const runs = await api(props.backend).listRuns(5, 0, { workflowName: activeWorkflowName });
        if (cancelled) return;
        setTestRunHistory(runs);
      } catch {
        if (cancelled) return;
        setTestRunHistory([]);
      }
    }

    loadRuns();
    return () => {
      cancelled = true;
    };
  }, [props.backend, selectedRevId, activeWorkflowName]);

  return (
    <div className="asEditor">
      <div className="asEditorLeft">
        <div className="asCard">
          <div className="asCardHeader">
            <div className="asCardTitle">Workflow editor</div>
          </div>
          <div className="asCardBody">
            <label className="asField">
              <div className="asFieldLabel">Name</div>
              <input className="asInput" value={name} onChange={(e) => setName(e.currentTarget.value)} />
            </label>
            <div className="asRow">
              <button className="asBtn" onClick={createNewWorkflow} disabled={busy}>
                New workflow
              </button>
              <button className="asBtn primary" onClick={saveRevision} disabled={busy || !isUnsaved}>
                Save
              </button>
              {isUnsaved ? <div className="asMuted">(Unsaved changes)</div> : null}
            </div>
          </div>
        </div>

        <div className="asCard">
          <div className="asCardHeader">
            {selectedNode ? (
              <div className="asNodeInspectorHeader">
                <div className="asNodeInspectorTitle">
                  <span>Node details</span>
                </div>
                <div className="asNodeInspectorActions">
                  <span className={`asNodeTypePill type-${selectedNode.type}`}>{selectedNode.type.replace("_", " ")}</span>
                  <button
                    className="asHelpIcon"
                    type="button"
                    aria-label={`${nodeHelpOpen ? "Hide" : "Show"} ${selectedNode.type} node help`}
                    onClick={() => setNodeHelpOpen((prev) => !prev)}
                  >
                    ?
                  </button>
                </div>
              </div>
            ) : selectedEdge ? (
              <div className="asCardTitle">Edge inspector</div>
            ) : (
              <div className="asCardTitle">Inspector</div>
            )}
          </div>
          <div className="asCardBody">
            {selectedNode ? (
              <NodeInspector
                node={selectedNode}
                issues={issuesByNodeId.get(selectedNode.id) ?? []}
                onChange={updateNode}
                onDelete={deleteNode}
                settings={props.settings}
                helpOpen={nodeHelpOpen}
                loopGroups={loopGroups}
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
            <button className="asBtn asPaletteBtn type-agent" onClick={() => addNode("agent")}>
              + Agent
            </button>
            <button className="asBtn asPaletteBtn type-tool" onClick={() => addNode("tool")}>
              + Tool
            </button>
            <button className="asBtn asPaletteBtn type-loop_group" onClick={() => addNode("loop_group")}>
              + Loop
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
                value={workflowRevisions.some((rev) => rev.id === selectedRevId) ? selectedRevId : ""}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  if (!next) return;
                  selectRevision(next);
                }}
              >
                <option value="" disabled>
                  {workflowRevisions.length ? "Select a revision..." : "No revisions yet"}
                </option>
                {workflowRevisions.map((rev, idx) => (
                  <option key={rev.id} value={rev.id}>
                    {idx === 0 ? "Latest" : "Revision"} · {formatRelativeTime(rev.created_at)} · {rev.id.slice(0, 8)}
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
                      <span className="asCanvasErrorSep">{idx + 1}. </span>
                      <span className="asMono asCodeBlock">{issue.code}</span> {issue.message}
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
            onNodeDragStop={onNodeDragStop}
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

      <div className="asCard asEditorWide">
        <div className="asCardHeader">
          <div className="asCardTitle">Recent test runs</div>
        </div>
        <div className="asCardBody">
          {testRunHistory.length === 0 ? (
            <div className="asMuted">No test runs yet.</div>
          ) : (
            <div className="asTable asRecentRunsTable">
              <div className="asTableHead">
                <div>Run</div>
                <div>Started</div>
                <div>Input</div>
                <div>Output</div>
              </div>
              {testRunHistory.map((entry) => (
                <div
                  key={entry.id}
                  className="asTableRow clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => recallTestRun(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      recallTestRun(entry);
                    }
                  }}
                >
                  <div className="asMono">{entry.id.slice(0, 8)}</div>
                  <div>{formatDateTime(entry.started_at)}</div>
                  <div>{formatInputPreview(entry.inputs_json)}</div>
                  <div>{entry.final_output ? entry.final_output : "—"}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="asEditorFooter">
        <div className="asEditorFooterGrid">
          <div className="asCard">
            <div className="asCardHeader">
              <div className="asCardTitle">Trigger test run</div>
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
                <div className="asMarkdown">
                  {testOutput ? (
                    <ReactMarkdown>{testOutput}</ReactMarkdown>
                  ) : (
                    <div className="asMuted">No output yet.</div>
                  )}
                </div>
              </label>
            </div>
          </div>
          <TraceViewer
            backend={props.backend}
            runId={testRunId || null}
            mode={testTraceMode}
            emptyMessage="Run a test to stream events here."
            waitingMessage="Waiting for events…"
            title="Trace"
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
  node: AgentGraphNode;
  issues: ValidationIssue[];
  onChange: (node: AgentGraphNode) => void;
  onDelete: (nodeId: string) => void;
  settings: AppSettings;
  helpOpen: boolean;
  loopGroups: AgentGraphNode[];
}) {
  const { node, issues, onChange, onDelete, settings, helpOpen, loopGroups } = props;
  const [schemaText, setSchemaText] = useState(() =>
    node.type === "tool" ? prettyJson(node.schema ?? {}) : "{}",
  );
  const isModelNode = node.type === "agent";
  const [inputGuardrailsText, setInputGuardrailsText] = useState(() =>
    node.type === "agent" ? prettyJson(node.input_guardrails ?? []) : "[]",
  );
  const [outputGuardrailsText, setOutputGuardrailsText] = useState(() =>
    node.type === "agent" ? prettyJson(node.output_guardrails ?? []) : "[]",
  );
  const [outputTypeText, setOutputTypeText] = useState(() =>
    node.type === "agent" ? prettyJson(node.output_type ?? {}) : "{}",
  );

  useEffect(() => {
    if (node.type === "tool") {
      setSchemaText(prettyJson(node.schema ?? {}));
    }
    if (node.type === "agent") {
      setInputGuardrailsText(prettyJson(node.input_guardrails ?? []));
      setOutputGuardrailsText(prettyJson(node.output_guardrails ?? []));
      setOutputTypeText(prettyJson(node.output_type ?? {}));
    }
  }, [node]);

  const modelProvider = useMemo<LlmProvider>(() => {
    if (!isModelNode) return settings.llmProvider;
    const model = node.model ?? {};
    if (typeof model !== "object" || Array.isArray(model) || !model) return settings.llmProvider;
    const provider = (model as { provider?: unknown }).provider;
    return isLlmProvider(provider) ? provider : settings.llmProvider;
  }, [node, settings.llmProvider, isModelNode]);

  const modelName = useMemo(() => {
    if (!isModelNode) return "";
    const model = node.model ?? {};
    if (typeof model !== "object" || Array.isArray(model) || !model) return "";
    return typeof (model as { name?: unknown }).name === "string" ? ((model as { name?: string }).name ?? "") : "";
  }, [node, isModelNode]);

  // Fetch models from provider API
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isFetchingModels, setIsFetchingModels] = useState(false);

  const connectionConfig = settings.llmConnections[modelProvider];
  useEffect(() => {
    if (!isModelNode) return;
    let cancelled = false;
    setIsFetchingModels(true);
    setModelsFetchError(null);

    fetchModelsFromProvider(modelProvider, connectionConfig).then((result) => {
      if (cancelled) return;
      setIsFetchingModels(false);
      if (result.ok) {
        setFetchedModels(result.models);
        setModelsFetchError(null);
      } else {
        setFetchedModels([]);
        setModelsFetchError(result.error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [modelProvider, connectionConfig, isModelNode]);

  const modelOptions = useMemo(() => {
    // Prioritize fetched models, fall back to hardcoded defaults
    const base = fetchedModels.length > 0 ? fetchedModels : (MODEL_OPTIONS[modelProvider] ?? []);
    const next = [...base];
    const preferredModel = settings.llmConnections[modelProvider]?.model?.trim() ?? "";
    for (const candidate of [preferredModel, modelName]) {
      if (candidate && !next.includes(candidate)) {
        next.unshift(candidate);
      }
    }
    return next;
  }, [modelProvider, modelName, settings.llmConnections, fetchedModels]);

  function updateLlmModel(nextProvider: LlmProvider, nextName: string) {
    if (!isModelNode) return;
    const nextModel = {
      ...(node.model as Record<string, unknown> | undefined),
      provider: nextProvider,
      name: nextName,
    };
    updateModelNode({ model: nextModel });
  }

  function updateModelNode(next: Partial<AgentNode>) {
    if (!isModelNode) return;
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
      {helpOpen ? (
        <div className="asHelpPanel">
          <div className="asHelpPanelTitle">{NODE_HELP[node.type].title}</div>
          <div className="asHelpPanelBody">
            <div className="asHelpPanelSummary">{NODE_HELP[node.type].summary}</div>
            <div className="asHelpPanelSection">
              <div className="asHelpPanelLabel">Connections</div>
              <ul>
                {NODE_HELP[node.type].connections.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="asHelpPanelSection">
              <div className="asHelpPanelLabel">Fields</div>
              <ul>
                {NODE_HELP[node.type].fields.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="asHelpPanelSection">
              <div className="asHelpPanelLabel">Tips</div>
              <ul>
                {NODE_HELP[node.type].tips.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
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

      {node.type !== "loop_group" ? (
        <label className="asField">
          <div className="asFieldLabel">Parent loop group</div>
          <select
            className="asSelect"
            value={typeof (node as { parent_id?: unknown }).parent_id === "string" ? (node as { parent_id?: string }).parent_id : ""}
            onChange={(e) => {
              const nextParent = e.currentTarget.value || undefined;
              onChange({ ...node, parent_id: nextParent });
            }}
          >
            <option value="">None</option>
            {loopGroups
              .filter((group) => group.id !== node.id)
              .map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name || group.id}
                </option>
              ))}
          </select>
        </label>
      ) : null}

      {node.type === "loop_group" ? (
        <>
          <label className="asField">
            <div className="asFieldLabel">Condition</div>
            <textarea
              className="asTextarea"
              rows={3}
              value={node.condition ?? ""}
              onChange={(e) => onChange({ ...node, condition: e.currentTarget.value })}
            />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Max iterations</div>
            <input
              className="asInput"
              type="number"
              min={1}
              value={node.max_iterations ?? 1}
              onChange={(e) => {
                const nextValue = Number(e.currentTarget.value);
                onChange({ ...node, max_iterations: Number.isFinite(nextValue) ? nextValue : 1 });
              }}
            />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Width</div>
            <input
              className="asInput"
              type="number"
              min={200}
              value={node.width ?? 360}
              onChange={(e) => {
                const nextValue = Number(e.currentTarget.value);
                onChange({ ...node, width: Number.isFinite(nextValue) ? nextValue : 360 });
              }}
            />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Height</div>
            <input
              className="asInput"
              type="number"
              min={160}
              value={node.height ?? 240}
              onChange={(e) => {
                const nextValue = Number(e.currentTarget.value);
                onChange({ ...node, height: Number.isFinite(nextValue) ? nextValue : 240 });
              }}
            />
          </label>
        </>
      ) : null}

      {isModelNode ? (
        <>
          <label className="asField">
            <div className="asFieldLabel">Instructions</div>
            <textarea
              className="asTextarea"
              rows={6}
              value={node.instructions ?? ""}
              onChange={(e) => updateModelNode({ instructions: e.currentTarget.value })}
            />
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
            <div className="asFieldLabel">
              Model
              {isFetchingModels ? (
                <span className="asFieldHint"> (loading...)</span>
              ) : modelsFetchError ? (
                <span className="asFieldHint asFieldHintWarn" title={modelsFetchError}> (using defaults)</span>
              ) : fetchedModels.length > 0 ? (
                <span className="asFieldHint"> ({fetchedModels.length} available)</span>
              ) : null}
            </div>
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
            <div className="asFieldLabel">Workspace root (optional)</div>
            <div className="asRow">
              <input
                className="asInput"
                placeholder="Select a folder or enter a path"
                value={node.workspace_root ?? ""}
                onChange={(e) => updateModelNode({ workspace_root: e.currentTarget.value })}
              />
              <button
                className="asBtn"
                type="button"
                onClick={async () => {
                  const folder = await (window as any).agentStudio.selectFolder();
                  if (folder) {
                    updateModelNode({ workspace_root: folder });
                  }
                }}
              >
                Select folder
              </button>
            </div>
          </label>
          <label className="asField">
            <div className="asFieldLabel">Input guardrails (JSON)</div>
            <textarea
              className="asTextarea"
              rows={4}
              value={inputGuardrailsText}
              onChange={(e) => setInputGuardrailsText(e.currentTarget.value)}
              onBlur={() => {
                const parsed = tryParseJsonValue(inputGuardrailsText);
                if (parsed.ok && Array.isArray(parsed.value)) {
                  updateModelNode({ input_guardrails: parsed.value as AgentNode["input_guardrails"] });
                }
              }}
            />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Output guardrails (JSON)</div>
            <textarea
              className="asTextarea"
              rows={4}
              value={outputGuardrailsText}
              onChange={(e) => setOutputGuardrailsText(e.currentTarget.value)}
              onBlur={() => {
                const parsed = tryParseJsonValue(outputGuardrailsText);
                if (parsed.ok && Array.isArray(parsed.value)) {
                  updateModelNode({ output_guardrails: parsed.value as AgentNode["output_guardrails"] });
                }
              }}
            />
          </label>
          <label className="asField">
            <div className="asFieldLabel">Output schema (JSON)</div>
            <textarea
              className="asTextarea"
              rows={4}
              value={outputTypeText}
              onChange={(e) => setOutputTypeText(e.currentTarget.value)}
              onBlur={() => {
                const parsed = tryParseJsonValue(outputTypeText);
                if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
                  updateModelNode({ output_type: parsed.value as Record<string, unknown> });
                }
              }}
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

      <div className="asRow">
        <button className="asBtn danger" onClick={() => onDelete(node.id)}>
          Delete node
        </button>
      </div>
    </div>
  );
}
