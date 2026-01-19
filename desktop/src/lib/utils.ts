export function formatRelativeTime(isoTime: string): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const date = parseIsoDate(isoTime);
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

export function parseIsoDate(value: string): Date {
  const trimmed = value.trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  return new Date(hasZone ? trimmed : `${trimmed}Z`);
}

export function uniq(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const k = id.trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}