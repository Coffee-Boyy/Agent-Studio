import {
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDERS,
  LLM_PROVIDER_DEFS,
  buildDefaultConnections,
  isLlmProvider,
  type LlmConnectionConfig,
  type LlmProvider,
} from "./llm";

export type AppSettings = {
  backendBaseUrl: string;
  recentRunIds: string[];
  llmProvider: LlmProvider;
  llmConnections: Record<LlmProvider, LlmConnectionConfig>;
};

const KEY = "agent_studio.settings.v1";
const EDITOR_DRAFT_KEY = "agent_studio.editor_draft.v1";
const EDITOR_TEST_RUNS_KEY = "agent_studio.editor_test_runs.v1";

export type TestRunEntry = {
  id: string;
  created_at: string;
  inputs_json: Record<string, unknown>;
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const llmParsed = parsed.llmConnections;
    return {
      backendBaseUrl: typeof parsed.backendBaseUrl === "string" ? parsed.backendBaseUrl : defaults().backendBaseUrl,
      recentRunIds: Array.isArray(parsed.recentRunIds) ? parsed.recentRunIds.filter((x) => typeof x === "string") : [],
      llmProvider: asProvider(parsed.llmProvider),
      llmConnections: normalizeConnections(llmParsed),
    };
  } catch {
    return defaults();
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function loadAgentDraft(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(EDITOR_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function saveAgentDraft(draft: Record<string, unknown>): void {
  localStorage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(draft));
}

export function loadTestRunsForRevision(revisionId: string): TestRunEntry[] {
  if (!revisionId) return [];
  const history = loadTestRunHistory();
  return history[revisionId] ?? [];
}

export function saveTestRunForRevision(
  revisionId: string,
  entry: TestRunEntry,
  maxEntries: number = 20,
): TestRunEntry[] {
  if (!revisionId) return [];
  const history = loadTestRunHistory();
  const existing = history[revisionId] ?? [];
  const next = [entry, ...existing.filter((it) => it.id !== entry.id)].slice(0, maxEntries);
  history[revisionId] = next;
  localStorage.setItem(EDITOR_TEST_RUNS_KEY, JSON.stringify(history));
  return next;
}

function loadTestRunHistory(): Record<string, TestRunEntry[]> {
  try {
    const raw = localStorage.getItem(EDITOR_TEST_RUNS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: Record<string, TestRunEntry[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const entries = value
        .filter((it) => it && typeof it === "object" && !Array.isArray(it))
        .map((it) => it as TestRunEntry)
        .filter(
          (it) =>
            typeof it.id === "string" &&
            typeof it.created_at === "string" &&
            it.inputs_json &&
            typeof it.inputs_json === "object" &&
            !Array.isArray(it.inputs_json),
        );
      if (entries.length) next[key] = entries;
    }
    return next;
  } catch {
    return {};
  }
}

function defaults(): AppSettings {
  return {
    backendBaseUrl: "http://127.0.0.1:37123",
    recentRunIds: [],
    llmProvider: DEFAULT_LLM_PROVIDER,
    llmConnections: buildDefaultConnections(),
  };
}

function asProvider(value: unknown): AppSettings["llmProvider"] {
  return isLlmProvider(value) ? value : defaults().llmProvider;
}

function normalizeConnections(value: unknown): AppSettings["llmConnections"] {
  const defaults = buildDefaultConnections();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const parsed = value as Record<string, unknown>;
  const next = { ...defaults };
  for (const provider of LLM_PROVIDERS) {
    const rawProvider = parsed[provider];
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) continue;
    const providerConfig = { ...next[provider] };
    const rawConfig = rawProvider as Record<string, unknown>;
    for (const field of LLM_PROVIDER_DEFS[provider].fields) {
      const rawValue = rawConfig[field.key];
      if (typeof rawValue === "string") {
        providerConfig[field.key] = rawValue;
      }
    }
    next[provider] = providerConfig;
  }
  return next;
}

