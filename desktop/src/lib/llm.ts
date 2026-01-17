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

export const LLM_PROVIDER_DEFS: Record<LlmProvider, { label: string; modelOptions: string[]; fields: LlmFieldDefinition[] }> = {
  openai: {
    label: LLM_PROVIDER_LABELS.openai,
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
    modelOptions: MODEL_OPTIONS.anthropic,
    fields: [
      { key: "apiKey", label: "Anthropic API key", placeholder: "sk-ant-...", inputType: "password", apiField: "api_key" },
      { key: "baseUrl", label: "Anthropic base URL (optional)", placeholder: "https://api.anthropic.com", apiField: "base_url" },
    ],
  },
  local: {
    label: LLM_PROVIDER_LABELS.local,
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
