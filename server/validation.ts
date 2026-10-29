export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string, max = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(400, `Enter a valid ${label}.`);
  return value.trim();
}
export function optionalString(value: unknown, label: string, max = 16384) {
  return value == null || value === "" ? "" : string(value, label, max);
}
export function url(value: unknown) {
  const text = string(value, "server URL");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new HttpError(
      400,
      "Enter a complete http:// or https:// server URL.",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new HttpError(
      400,
      "Use an HTTP server URL without credentials, query parameters, or a fragment.",
    );
  return parsed.toString().replace(/\/$/, "");
}
export function strings(value: unknown, label: string): string[] | null {
  if (value == null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 200 ||
    value.some((v) => typeof v !== "string" || !v.trim() || v.length > 255)
  )
    throw new HttpError(400, `Select at least one ${label}, or allow all.`);
  return [...new Set(value.map((v) => v.trim()))];
}
