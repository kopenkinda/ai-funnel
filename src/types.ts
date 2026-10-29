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
  quotaError?: string;
  resetCredits?: { available: number; applicable: number | null };
}
export interface PublicConnection {
  id: string;
  provider: Provider;
  name: string;
  url: string;
  enabled: boolean;
  accounts: Account[];
  models: string[];
  syncedAt: string | null;
  error: string | null;
  createdAt: string;
  hasApiKey: boolean;
  hasManagementAccess: boolean;
}
export interface Grant {
  connectionId: string;
  accountIds: string[] | null;
  models: string[] | null;
}
export interface PublicKey {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  expiresAt: string | null;
  dailyLimit: number | null;
  grants: Grant[];
  imported: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  requestsToday: number;
}
export interface RequestLog {
  id: string;
  at: string;
  connectionId: string;
  keyId: string;
  model: string | null;
  status: number;
  durationMs: number;
}
