export function formatRemoteId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\s/g, "");
  if (!/^\d{9}$/.test(digits)) return null;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}
