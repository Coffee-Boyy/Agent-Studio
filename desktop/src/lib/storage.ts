export type AppSettings = {
  backendBaseUrl: string;
  recentRunIds: string[];
};

const KEY = "agent_studio.settings.v1";
const EDITOR_DRAFT_KEY = "agent_studio.editor_draft.v1";

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      backendBaseUrl: typeof parsed.backendBaseUrl === "string" ? parsed.backendBaseUrl : defaults().backendBaseUrl,
      recentRunIds: Array.isArray(parsed.recentRunIds) ? parsed.recentRunIds.filter((x) => typeof x === "string") : [],
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

function defaults(): AppSettings {
  return { backendBaseUrl: "http://127.0.0.1:37123", recentRunIds: [] };
}

