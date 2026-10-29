export type Provider = "codex" | "claude" | "zen" | "go";
export const providers: Provider[] = ["codex", "claude", "zen", "go"];
export const providerNames: Record<Provider, string> = {
  codex: "Codex",
  claude: "Claude",
  zen: "OpenCode Zen",
  go: "OpenCode Go",
};

export interface Quota {
  label: string;
  remaining: number | null;
  resetsAt: string | null;
}
export interface Account {
  id: string;
  name: string;
  email: string;
  plan: string;
  status: string;
  quotas: Quota[];
  prefix?: string;
  authIndex?: string;
  quotaError?: string;
}
export interface Connection {
  id: string;
  provider: Provider;
  name: string;
  url: string;
  enabled: boolean;
  apiKey: string;
  managementKey: string;
  cookie: string;
  accounts: Account[];
  models: string[];
  syncedAt: string | null;
  error: string | null;
  createdAt: string;
}
export type PublicConnection = Omit<
  Connection,
  "apiKey" | "managementKey" | "cookie"
> & { hasApiKey: boolean; hasManagementAccess: boolean };
export interface Grant {
  connectionId: string;
  accountIds: string[] | null;
  models: string[] | null;
}
export interface ClientKey {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  enabled: boolean;
  expiresAt: string | null;
  dailyLimit: number | null;
  grants: Grant[];
  upstreamKeys: Record<string, string>;
  upstreamIds: Record<string, string>;
  imported: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}
export type PublicKey = Omit<
  ClientKey,
  "hash" | "upstreamKeys" | "upstreamIds"
> & { requestsToday: number };
export interface RequestLog {
  id: string;
  at: string;
  connectionId: string;
  keyId: string;
  model: string | null;
  status: number;
  durationMs: number;
}
export function publicConnection(c: Connection): PublicConnection {
  const { apiKey, managementKey, cookie, ...rest } = c;
  return {
    ...rest,
    hasApiKey: !!apiKey,
    hasManagementAccess: !!(managementKey || cookie),
  };
}
