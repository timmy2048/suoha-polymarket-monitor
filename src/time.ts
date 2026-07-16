export function formatUtcAndBeijing(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (!Number.isFinite(date.getTime())) {
    return String(input);
  }

  return `${date.toISOString()} UTC / ${formatBeijingTime(date)} Asia/Shanghai`;
}

export function formatMonitorWindow(
  gameStartTime: string,
  prematchMinutes: number,
  durationMinutes: number
): { start: string; kickoff: string; end: string } {
  const kickoff = new Date(gameStartTime);
  const start = new Date(kickoff.getTime() - prematchMinutes * 60_000);
  const end = new Date(kickoff.getTime() + durationMinutes * 60_000);

  return {
    start: formatUtcAndBeijing(start),
    kickoff: formatUtcAndBeijing(kickoff),
    end: formatUtcAndBeijing(end)
  };
}

export function formatBeijingTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(date);

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}
