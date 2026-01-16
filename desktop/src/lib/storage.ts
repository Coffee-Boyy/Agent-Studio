export type AppSettings = {
  backendBaseUrl: string;
  recentRunIds: string[];
};

const KEY = "agent_studio.settings.v1";

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

function defaults(): AppSettings {
  return { backendBaseUrl: "http://127.0.0.1:37123", recentRunIds: [] };
}

