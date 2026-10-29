import type {
  PublicConnection,
  PublicKey,
  RequestLog,
} from "../server/types.ts";
export type State = {
  connections: PublicConnection[];
  keys: PublicKey[];
  requests: RequestLog[];
  publicUrl: string;
};
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      data.error?.message || `Request returned HTTP ${res.status}.`,
    );
  return data;
}
export function timeUntil(value: string | null) {
  if (!value) return "Reset unavailable";
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "Awaiting refresh";
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.max(1, Math.ceil((diff % 3600000) / 60000));
  return hours >= 24
    ? `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours
      ? `Resets in ${hours}h ${minutes}m`
      : `Resets in ${minutes}m`;
}
export function relative(value: string | null) {
  if (!value) return "Not yet synced";
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : `${Math.floor(minutes / 60)}h ago`;
}
