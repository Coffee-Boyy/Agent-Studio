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
  type NodeProps,
  type NodeTypes,
  type Connection,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
  type OnNodeDrag,
  NodeResizer,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api, type BackendConfig } from "../lib/api";
import { formatDateTime, prettyJson, tryParseJsonObject } from "../lib/json";
import {
  buildLlmConnectionPayload,
  DEFAULT_LLM_PROVIDER,
  MODEL_OPTIONS,
} from "../lib/llm";
import { loadAgentDraft, saveAgentDraft, type AppSettings, type TestRunEntry } from "../lib/storage";
import type {
  AgentGraphDocV1,
  AgentGraphNode,
  AgentSpecEnvelope,
  ValidationIssue,
  WorkflowRevisionResponse,
  WorkflowWithLatestRevisionResponse,
} from "../lib/types";
import { TraceViewer } from "../components/TraceViewer";
import { useUndoRedoState } from "../components/UndoRedo";
import { NodeInspector } from "../components/NodeInspector";

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

function toFlowNodes(graph: AgentGraphDocV1, issuesByNodeId: Map<string, ValidationIssue[]>): Node[] {
  const nodes: Node[] = graph.nodes.map((n) => {
    const parentId = typeof (n as { parent_id?: unknown }).parent_id === "string" ? (n as { parent_id?: string }).parent_id : undefined;
    const parentNode = parentId ? graph.nodes.find((node) => node.id === parentId) : undefined;
    const base = {
      id: n.id,
      position: n.position,
      data: {
        label: `${n.type}${n.name ? `: ${n.name}` : ""}`,
        nodeType: n.type,
        name: n.name ?? "",
        issueCount: issuesByNodeId.get(n.id)?.length ?? 0,
        hasParent: !!parentId,
        parentName: parentNode?.name,
      },
    };
    if (n.type === "loop_group") {
      return {
        ...base,
        type: "group",
        style: {
          width: n.width,
          height: n.height,
        },
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

function AgentFlowNode(props: { data: { label: string; nodeType: string; name: string; issueCount: number; hasParent?: boolean; parentName?: string }; selected?: boolean }) {
  const { data, selected } = props;
  const isSourceOnly = data.nodeType === "input" || data.nodeType === "tool";
  const isTargetOnly = data.nodeType === "output";

  return (
    <div className={`asFlowNode type-${data.nodeType}${selected ? " isSelected" : ""}${data.hasParent ? " inLoopGroup" : ""}`}>
      {!isSourceOnly ? <Handle className="nodrag" type="target" position={Position.Left} /> : null}
      {!isTargetOnly ? <Handle className="nodrag" type="source" position={Position.Right} /> : null}
      <div className="asFlowNodeTitle">
        <span className="asFlowNodeType">{data.nodeType}</span>
        {data.issueCount > 0 ? <span className="asFlowNodeIssue">{data.issueCount}</span> : null}
      </div>
      <div className="asFlowNodeName">{data.name || data.label}</div>
      {data.hasParent ? (
        <div className="asFlowNodeLoopBadge" title={`Inside loop: ${data.parentName || "Loop group"}`}>
          ↻
        </div>
      ) : null}
    </div>
  );
}

export function AgentEditorPage(props: {
  backend: BackendConfig;
  settings: AppSettings;
  onStartRun: (runId: string) => void;
  selectedWorkflowId?: string;
  onSelectWorkflow?: (workflowId: string) => void;
  onWorkflowsChange?: (workflows: WorkflowWithLatestRevisionResponse[]) => void;
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

  const [workflows, setWorkflows] = useState<WorkflowWithLatestRevisionResponse[] | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [selectedRevisionId, setSelectedRevisionId] = useState<string>("");
  const [name, setName] = useState("New Workflow");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
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
  const loadedWorkflowIdRef = useRef<string>("");

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

  const refreshWorkflows = useCallback(async () => {
    try {
      const list = await api(props.backend).listWorkflows();
      setWorkflows(list);
      props.onWorkflowsChange?.(list);
    } catch (e) {
      setWorkflows(null);
    }
  }, [props.backend, props.onWorkflowsChange]);

  useEffect(() => {
    refreshWorkflows();
  }, [refreshWorkflows]);

  const selectWorkflow = useCallback(
    (workflowId: string) => {
      setSelectedWorkflowId(workflowId);
      props.onSelectWorkflow?.(workflowId);
    },
    [props.onSelectWorkflow],
  );

  // Effect to load workflow when selectedWorkflowId changes or workflows first becomes available
  useEffect(() => {
    if (!selectedWorkflowId || !workflows) return;
    // Skip if we've already loaded this workflow (prevents reloading on workflows refresh)
    if (loadedWorkflowIdRef.current === selectedWorkflowId) return;
    
    const workflow = workflows.find((w) => w.id === selectedWorkflowId);
    if (!workflow) return;
    const revision = workflow.latest_revision;
    if (!revision) {
      setErr("Workflow has no revisions.");
      return;
    }
    const spec = revision.spec_json as AgentSpecEnvelope;
    if (!spec || spec.schema_version !== "graph-v1" || !spec.graph) {
      setErr("Selected revision is not a graph-v1 spec.");
      return;
    }
    
    loadedWorkflowIdRef.current = selectedWorkflowId;
    const nextGraph = migrateLegacyGraph(spec.graph);
    setGraph(nextGraph);
    setHasUnsavedChanges(false);
    graphState.clearHistory();
    const nextName = workflow.name || "New Workflow";
    setName(nextName);
    setSelectedRevisionId(revision.id);
    setErr(null);
    setIssues(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    // Reset the graph editor viewport
    setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 200 }), 50);
  }, [selectedWorkflowId, workflows]);

  // Sync with props.selectedWorkflowId
  useEffect(() => {
    if (!props.selectedWorkflowId) return;
    if (props.selectedWorkflowId === selectedWorkflowId) return;
    setSelectedWorkflowId(props.selectedWorkflowId);
  }, [props.selectedWorkflowId, selectedWorkflowId]);

  // Auto-select first workflow if none selected
  useEffect(() => {
    if (selectedWorkflowId || !workflows || workflows.length === 0) return;
    const first = workflows[0];
    selectWorkflow(first.id);
  }, [workflows, selectedWorkflowId, selectWorkflow]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setFlowNodes((prev) => {
      const next = applyNodeChanges(changes, prev);
      const shouldPersist = changes.some((change) => change.type === "remove");
      if (shouldPersist) {
        setHasUnsavedChanges(true);
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
      setHasUnsavedChanges(true);
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
        setHasUnsavedChanges(true);
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
        setHasUnsavedChanges(true);
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
      setHasUnsavedChanges(true);
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
        setHasUnsavedChanges(true);
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
      setHasUnsavedChanges(true);
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

  const LoopGroupFlowNode = useCallback(
    ({ id, data, selected }: NodeProps) => {
      const typedData = data as { label: string; nodeType: string; name: string };
      return (
        <>
          <NodeResizer
            minWidth={100}
            minHeight={30}
            isVisible={!!selected}
            onResizeEnd={(_, params) => {
              const nextWidth = typeof params.width === "number" ? params.width : null;
              const nextHeight = typeof params.height === "number" ? params.height : null;
              if (nextWidth == null || nextHeight == null) return;

              const nextX = typeof params.x === "number" ? params.x : null;
              const nextY = typeof params.y === "number" ? params.y : null;

              const width = Math.round(nextWidth);
              const height = Math.round(nextHeight);

              setHasUnsavedChanges(true);

              // Persist into the React Flow state immediately (so it doesn't "snap back")
              // and into the graph document (so it survives refresh/save/undo stack).
              setFlowNodes((prev) =>
                prev.map((n) =>
                  n.id === id
                    ? {
                        ...n,
                        position: nextX != null && nextY != null ? { x: nextX, y: nextY } : n.position,
                        style: { ...(n.style ?? {}), width, height },
                      }
                    : n,
                ),
              );

              setGraph((g) => ({
                ...g,
                nodes: g.nodes.map((n) =>
                  n.id === id && n.type === "loop_group"
                    ? {
                        ...n,
                        position: nextX != null && nextY != null ? { x: nextX, y: nextY } : n.position,
                        width,
                        height,
                      }
                    : n,
                ),
              }));
            }}
          />
          <div className={`asFlowGroup type-${typedData.nodeType}`}>
            <div className="asFlowGroupTitle">
              <span className="asFlowGroupType">{typedData.name || typedData.label}</span>
            </div>
          </div>
        </>
      );
    },
    [setFlowNodes, setGraph],
  );

  const nodeTypes: NodeTypes = useMemo(() => ({ agentNode: AgentFlowNode, group: LoopGroupFlowNode }), [LoopGroupFlowNode]);

  const onUndo = useCallback(() => {
    setHasUnsavedChanges(true);
    graphState.undo();
  }, [graphState]);

  const onRedo = useCallback(() => {
    setHasUnsavedChanges(true);
    graphState.redo();
  }, [graphState]);

  async function saveRevision() {
    setBusy(true);
    try {
      const validation = await api(props.backend).validateSpec({ spec: buildEnvelope(graph) });
      setIssues(validation.issues);
      if (!validation.ok || validation.issues.length > 0) {
        return;
      }

      const trimmedName = name.trim() || "Visual agent";

      if (selectedWorkflowId) {
        // Update existing workflow: check if name changed, then create revision
        const currentWorkflow = workflows?.find((w) => w.id === selectedWorkflowId);
        if (currentWorkflow && currentWorkflow.name !== trimmedName) {
          // Name changed - update the workflow
          await api(props.backend).updateWorkflow(selectedWorkflowId, { name: trimmedName });
        }
        // Create a new revision for the existing workflow
        const revision = await api(props.backend).createWorkflowRevision(selectedWorkflowId, {
          spec_json: buildEnvelope(graph),
        });
        setSelectedRevisionId(revision.id);
      } else {
        // Create a new workflow with initial revision
        const res = await api(props.backend).createWorkflow({
          name: trimmedName,
          spec_json: buildEnvelope(graph),
        });
        // Mark as loaded to prevent effect from re-running
        loadedWorkflowIdRef.current = res.id;
        setSelectedWorkflowId(res.id);
        props.onSelectWorkflow?.(res.id);
        if (res.latest_revision) {
          setSelectedRevisionId(res.latest_revision.id);
        }
      }

      setErr(null);
      setIssues(null);
      await refreshWorkflows();
      setHasUnsavedChanges(false);
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
      let revisionId = selectedRevisionId;
      if (!revisionId) {
        const spec = buildEnvelope(graph);
        const validation = await api(props.backend).validateSpec({ spec });
        setIssues(validation.issues);
        if (!validation.ok || validation.issues.length > 0) {
          setTestErr("Fix validation issues before testing.");
          return;
        }

        const trimmedName = name.trim() || "Visual agent";

        if (selectedWorkflowId) {
          // Create a new revision for the existing workflow
          const revision = await api(props.backend).createWorkflowRevision(selectedWorkflowId, {
            spec_json: spec,
          });
          revisionId = revision.id;
          setSelectedRevisionId(revision.id);
        } else {
          // Create a new workflow with initial revision
          const res = await api(props.backend).createWorkflow({
            name: trimmedName,
            spec_json: spec,
          });
          setSelectedWorkflowId(res.id);
          props.onSelectWorkflow?.(res.id);
          if (res.latest_revision) {
            revisionId = res.latest_revision.id;
            setSelectedRevisionId(res.latest_revision.id);
          }
        }
        await refreshWorkflows();
      }
      const llmConnection = buildLlmConnectionPayload(
        props.settings.llmProvider,
        props.settings.llmConnections[props.settings.llmProvider],
      );
      const res = await api(props.backend).createRun({
        workflow_revision_id: revisionId,
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
    setHasUnsavedChanges(true);
    setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode(type, g.nodes.length)] }));
  }

  function updateNode(next: AgentGraphNode) {
    setHasUnsavedChanges(true);
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === next.id ? next : n)) }));
  }

  function updateEdgeLabel(edgeId: string, label: string) {
    setHasUnsavedChanges(true);
    setGraph((g) => ({
      ...g,
      edges: g.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)),
    }));
  }

  function deleteNode(nodeId: string) {
    setHasUnsavedChanges(true);
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
    setHasUnsavedChanges(true);
    setGraph((g) => ({
      ...g,
      edges: g.edges.filter((ed) => ed.id !== edgeId),
    }));
    if (selectedEdgeId === edgeId) {
      setSelectedEdgeId(null);
    }
  }

  function loadRevision(revision: WorkflowRevisionResponse) {
    const spec = revision.spec_json as AgentSpecEnvelope;
    if (!spec || spec.schema_version !== "graph-v1" || !spec.graph) {
      setErr("Selected revision is not a graph-v1 spec.");
      return;
    }
    const nextGraph = migrateLegacyGraph(spec.graph);
    setGraph(nextGraph);
    setHasUnsavedChanges(false);
    graphState.clearHistory();
    setSelectedRevisionId(revision.id);
    setErr(null);
    setIssues(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    // Reset the graph editor viewport
    setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 200 }), 50);
  }

  async function createNewWorkflow() {
    setGraph(DEFAULT_GRAPH);
    setHasUnsavedChanges(true);
    graphState.clearHistory();
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedWorkflowId("");
    setSelectedRevisionId("");
    loadedWorkflowIdRef.current = "";
    props.onSelectWorkflow?.("");
    setIssues(null);
    setErr(null);
    setName("New Workflow");
    // Reset the graph editor viewport
    setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 200 }), 50);

    setBusy(true);
    try {
      const res = await api(props.backend).createWorkflow({
        name: "New Workflow",
        spec_json: buildEnvelope(DEFAULT_GRAPH),
      });
      await refreshWorkflows();
      // Set the loaded ref so we don't re-trigger the load effect
      loadedWorkflowIdRef.current = res.id;
      selectWorkflow(res.id);
      if (res.latest_revision) {
        setSelectedRevisionId(res.latest_revision.id);
      }
      setHasUnsavedChanges(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const [workflowRevisions, setWorkflowRevisions] = useState<WorkflowRevisionResponse[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedWorkflowId) {
      setWorkflowRevisions([]);
      return () => {
        cancelled = true;
      };
    }

    async function loadRevisions() {
      try {
        const revisions = await api(props.backend).listWorkflowRevisions(selectedWorkflowId);
        if (cancelled) return;
        setWorkflowRevisions(revisions);
      } catch {
        if (cancelled) return;
        setWorkflowRevisions([]);
      }
    }

    loadRevisions();
    return () => {
      cancelled = true;
    };
  }, [props.backend, selectedWorkflowId]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedWorkflowId) {
      setTestRunHistory([]);
      return () => {
        cancelled = true;
      };
    }

    async function loadRuns() {
      try {
        const runs = await api(props.backend).listRuns(5, 0, { workflowId: selectedWorkflowId });
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
  }, [props.backend, selectedWorkflowId]);

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
              <input
                className="asInput"
                value={name}
                onChange={(e) => {
                  setName(e.currentTarget.value);
                  setHasUnsavedChanges(true);
                }}
              />
            </label>
            <div className="asRow">
              <button className="asBtn" onClick={createNewWorkflow} disabled={busy}>
                New workflow
              </button>
              <button className="asBtn primary" onClick={saveRevision} disabled={busy || !hasUnsavedChanges}>
                Save
              </button>
              {hasUnsavedChanges ? <div className="asMuted">(Unsaved changes)</div> : null}
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
                      deleteEdge(selectedEdge.id);
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
              <button className="asBtn sm" onClick={onUndo} disabled={!graphState.canUndo}>
                Undo
              </button>
              <button className="asBtn sm" onClick={onRedo} disabled={!graphState.canRedo}>
                Redo
              </button>
              <button className="asBtn sm" onClick={openExportJson}>
                Export JSON
              </button>
              <select
                className="asSelect asSelectInline asSelectUnderline"
                value={workflowRevisions.some((rev) => rev.id === selectedRevisionId) ? selectedRevisionId : ""}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  if (!next) return;
                  const revision = workflowRevisions.find((r) => r.id === next);
                  if (revision) {
                    loadRevision(revision);
                  }
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
