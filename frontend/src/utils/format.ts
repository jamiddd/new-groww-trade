/**
 * Convert an ISO date `YYYY-MM-DD` to `DD/MM/YYYY`. Returns the input
 * unchanged if it doesn't look like an ISO date.
 */
export function formatExpiry(iso?: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}
