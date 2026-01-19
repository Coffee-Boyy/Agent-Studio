import type { AgentGraphDocV1, AgentSpecEnvelope } from "./types";
import { DEFAULT_LLM_PROVIDER, MODEL_OPTIONS } from "./llm";

export const DEFAULT_GRAPH: AgentGraphDocV1 = {
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
  workspace_root: "",
};

export function buildEnvelope(graph: AgentGraphDocV1): AgentSpecEnvelope {
  return {
    schema_version: "graph-v1",
    graph,
    compiled: null,
    metadata: {},
  };
}
