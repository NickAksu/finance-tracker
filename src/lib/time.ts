// Время храним в UTC (ISO 8601), показываем в часовом поясе семьи.

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string, withTime: boolean): Intl.DateTimeFormat {
  const key = `${timezone}|${withTime}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
    });
    formatters.set(key, f);
  }
  return f;
}

/** "05.10.2026 14:32" в часовом поясе семьи. */
export function formatDateTime(iso: string, timezone: string): string {
  return formatter(timezone, true).format(new Date(iso)).replace(",", "");
}

/** "05.10.2026" в часовом поясе семьи. */
export function formatDate(iso: string, timezone: string): string {
  return formatter(timezone, false).format(new Date(iso));
}
