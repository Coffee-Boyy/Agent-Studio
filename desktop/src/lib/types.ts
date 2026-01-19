import type { LlmProvider } from "./llm";

export type IsoDateTimeString = string;

export type HealthResponse = {
  ok: boolean;
};

export type AgentRevisionCreateRequest = {
  name: string;
  spec_json: Record<string, unknown>;
};

export type AgentRevisionResponse = {
  id: string;
  name: string;
  created_at: IsoDateTimeString;
  content_hash: string;
  spec_json: Record<string, unknown>;
};

export type LlmConnection = {
  provider: LlmProvider;
  api_key?: string;
  base_url?: string;
  organization?: string;
  project?: string;
};

export type RunCreateRequest = {
  agent_revision_id: string;
  inputs_json: Record<string, unknown>;
  tags_json: Record<string, unknown>;
  group_id: string | null;
  llm_connection?: LlmConnection;
};

export type RunResponse = {
  id: string;
  agent_revision_id: string;
  started_at: IsoDateTimeString;
  ended_at: IsoDateTimeString | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | (string & {});
  inputs_json: Record<string, unknown>;
  final_output: string | null;
  tags_json: Record<string, unknown>;
  trace_id: string | null;
  group_id: string | null;
  error: string | null;
  cancel_requested: boolean;
};

export type RunEventResponse = {
  id: string;
  run_id: string;
  created_at: IsoDateTimeString;
  seq: number;
  type: string;
  payload_json: Record<string, unknown>;
};

export type GraphPosition = {
  x: number;
  y: number;
};

export type GraphViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string | null;
  source_handle?: string | null;
  target_handle?: string | null;
};

export type NodeBase = {
  id: string;
  type: string;
  name?: string | null;
  position: GraphPosition;
  [key: string]: unknown;
};

export type InputNode = NodeBase & {
  type: "input";
  schema?: Record<string, unknown>;
};

export type OutputNode = NodeBase & {
  type: "output";
};

export type GuardrailSpec = {
  name: string;
  rule: string;
  blocking?: boolean;
  description?: string | null;
};

export type AgentNode = NodeBase & {
  type: "agent";
  instructions?: string;
  model?: Record<string, unknown>;
  tools?: string[];
  temperature?: number | null;
  input_guardrails?: GuardrailSpec[];
  output_guardrails?: GuardrailSpec[];
  output_type?: Record<string, unknown> | null;
  workspace_root?: string;
  sandbox_tools?: boolean;
};

export type ToolNode = NodeBase & {
  type: "tool";
  tool_name: string;
  language?: string;
  code?: string;
  schema?: Record<string, unknown>;
  description?: string | null;
};

export type LoopGroupNode = NodeBase & {
  type: "loop_group";
  condition?: string;
  max_iterations?: number;
  width?: number;
  height?: number;
};

export type AgentGraphNode = InputNode | OutputNode | AgentNode | ToolNode | LoopGroupNode;

export type AgentGraphDocV1 = {
  schema_version: "graph-v1";
  nodes: AgentGraphNode[];
  edges: GraphEdge[];
  viewport: GraphViewport;
  metadata: Record<string, unknown>;
};

export type AgentSpecEnvelope = {
  schema_version: "graph-v1";
  graph: AgentGraphDocV1;
  compiled?: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

export type ValidationIssue = {
  code: string;
  message: string;
  node_id?: string | null;
  edge_id?: string | null;
};

export type SpecValidateRequest = {
  spec: AgentSpecEnvelope;
};

export type SpecValidateResponse = {
  ok: boolean;
  issues: ValidationIssue[];
  normalized: AgentSpecEnvelope;
};

export type SpecCompileResponse = {
  compiled: Record<string, unknown>;
};
