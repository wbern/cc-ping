import { format, formatDistance } from "date-fns";

export function formatLocalHour(utcHour: number, referenceDate: Date): string {
  const d = new Date(referenceDate);
  d.setUTCHours(utcHour, 0, 0, 0);
  return format(d, "h a");
}

export function formatTimeAgo(isoString: string, now: Date): string {
  return formatDistance(new Date(isoString), now, { addSuffix: true });
}
