import { useState, useEffect, useMemo } from "react";
import { prettyJson, tryParseJsonObject, tryParseJsonValue } from "../lib/json";
import { LlmProvider, isLlmProvider, fetchModelsFromProvider, MODEL_OPTIONS, LLM_PROVIDERS, LLM_PROVIDER_LABELS } from "../lib/llm";
import { AppSettings } from "../lib/storage";
import { AgentGraphNode, ValidationIssue, AgentNode, ToolNode } from "../lib/types";

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

export function NodeInspector(props: {
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
