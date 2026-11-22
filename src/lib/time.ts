/** Position in Sekunden als „37:12“ bzw. „1:05:09“. */
export function formatPosition(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** Dauer als „3 Std. 30 Min.“ bzw. „45 Min.“. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} Min.`;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}
