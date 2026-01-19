export const LLM_PROVIDERS = ["openai", "anthropic", "local"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const DEFAULT_LLM_PROVIDER: LlmProvider = "openai";

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  local: "Local",
};

export type LlmConnectionConfig = {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  model?: string;
};

type LlmFieldDefinition = {
  key: keyof LlmConnectionConfig;
  label: string;
  placeholder?: string;
  inputType?: "text" | "password";
  defaultValue?: string;
  apiField?: string;
};

export const MODEL_OPTIONS: Record<LlmProvider, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"],
  local: ["llama3.1", "llama3", "mistral", "qwen2.5", "phi3"],
};

export const LLM_PROVIDER_DEFS: Record<LlmProvider, { label: string; defaultBaseUrl: string; modelOptions: string[]; fields: LlmFieldDefinition[] }> = {
  openai: {
    label: LLM_PROVIDER_LABELS.openai,
    defaultBaseUrl: "https://api.openai.com/v1",
    modelOptions: MODEL_OPTIONS.openai,
    fields: [
      { key: "apiKey", label: "OpenAI API key", placeholder: "sk-...", inputType: "password", apiField: "api_key" },
      { key: "baseUrl", label: "OpenAI base URL (optional)", placeholder: "https://api.openai.com/v1", apiField: "base_url" },
      { key: "organization", label: "OpenAI organization (optional)", apiField: "organization" },
      { key: "project", label: "OpenAI project (optional)", apiField: "project" },
    ],
  },
  anthropic: {
    label: LLM_PROVIDER_LABELS.anthropic,
    defaultBaseUrl: "https://api.anthropic.com/v1",
    modelOptions: MODEL_OPTIONS.anthropic,
    fields: [
      { key: "apiKey", label: "Anthropic API key", placeholder: "sk-ant-...", inputType: "password", apiField: "api_key" },
      { key: "baseUrl", label: "Anthropic base URL (optional)", placeholder: "https://api.anthropic.com", apiField: "base_url" },
    ],
  },
  local: {
    label: LLM_PROVIDER_LABELS.local,
    defaultBaseUrl: "http://localhost:11434/v1",
    modelOptions: MODEL_OPTIONS.local,
    fields: [
      { key: "baseUrl", label: "Local base URL", placeholder: "http://localhost:11434", defaultValue: "http://localhost:11434", apiField: "base_url" },
      { key: "model", label: "Local model (optional)", placeholder: "llama3.1" },
    ],
  },
};

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && LLM_PROVIDERS.includes(value as LlmProvider);
}

export function buildDefaultConnections(): Record<LlmProvider, LlmConnectionConfig> {
  const connections = {} as Record<LlmProvider, LlmConnectionConfig>;
  for (const provider of LLM_PROVIDERS) {
    const def = LLM_PROVIDER_DEFS[provider];
    const next: LlmConnectionConfig = {};
    for (const field of def.fields) {
      next[field.key] = field.defaultValue ?? "";
    }
    connections[provider] = next;
  }
  return connections;
}

export function buildLlmConnectionPayload(provider: LlmProvider, config: LlmConnectionConfig): { provider: LlmProvider } & Record<string, string> {
  const def = LLM_PROVIDER_DEFS[provider];
  const payload: Record<string, string> = { provider };
  for (const field of def.fields) {
    if (!field.apiField) continue;
    const value = config[field.key];
    if (typeof value === "string" && value.trim() !== "") {
      payload[field.apiField] = value.trim();
    }
  }
  return payload as { provider: LlmProvider } & Record<string, string>;
}

export type FetchModelsResult = { ok: true; models: string[] } | { ok: false; error: string };

/**
 * Fetch available models from an OpenAI-compatible /v1/models endpoint.
 */
export async function fetchModelsFromProvider(
  provider: LlmProvider,
  config: LlmConnectionConfig,
): Promise<FetchModelsResult> {
  const baseUrl = (config.baseUrl?.trim() || LLM_PROVIDER_DEFS[provider].defaultBaseUrl).replace(/\/$/, "");
  const apiKey = config.apiKey?.trim() || "";

  // Build the models endpoint URL
  // OpenAI-compatible APIs expose /v1/models (per the OpenAI API reference).
  // For local providers (like Ollama), the endpoint might be different.
  let modelsUrl = `${baseUrl}/models`;
  if (provider === "local" && !config.baseUrl?.includes("/v1")) {
    // Ollama uses /api/tags for listing models
    modelsUrl = `${baseUrl.replace(/\/v1$/, "")}/api/tags`;
  } else if (provider !== "local") {
    const needsV1 = !/\/v1(?:\/|$)/.test(baseUrl);
    const openAiBase = needsV1 ? `${baseUrl}/v1` : baseUrl.replace(/\/$/, "");
    modelsUrl = `${openAiBase}/models`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();

    // Handle OpenAI-compatible response format
    if (data.data && Array.isArray(data.data)) {
      const models = data.data
        .map((m: { id?: string; created?: number }) => ({
          id: m.id,
          created: typeof m.created === "number" ? m.created : 0,
        }))
        .filter((m: { id?: string }): m is { id: string; created: number } => typeof m.id === "string")
        .sort((a: { id: string; created: number }, b: { id: string; created: number }) => b.created - a.created)
        .map((m: { id: string; created: number }) => m.id);
      return { ok: true, models };
    }

    // Handle Ollama response format
    if (data.models && Array.isArray(data.models)) {
      const models = data.models
        .map((m: { name?: string }) => m.name)
        .filter((name: unknown): name is string => typeof name === "string")
        .sort();
      return { ok: true, models };
    }

    return { ok: false, error: "Unexpected response format" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
