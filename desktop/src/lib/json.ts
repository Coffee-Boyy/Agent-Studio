export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function tryParseJsonValue(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

export function tryParseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: "expected a JSON object at the top level" };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function formatDateTime(iso: string): string {
  const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  const normalized = hasTimezone ? iso : `${iso}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDurationMs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(1)}s`;
}

