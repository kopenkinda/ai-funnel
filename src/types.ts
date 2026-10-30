export type Provider = "codex" | "claude";
export const providers: Provider[] = ["codex", "claude"];
export const providerNames: Record<Provider, string> = {
  codex: "Codex",
  claude: "Claude",
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
  planTier?: string;
  status: string;
  quotas: Quota[];
  quotaError?: string;
  resetCredits?: {
    available: number;
    applicable: number | null;
    checkedAt?: string;
    error?: string;
    items?: {
      id: string;
      status: string;
      expires_at?: string;
      resets_left?: number;
      attempt?: { at: string; result: string; error?: string };
    }[];
  };
}
export interface PublicConnection {
  id: string;
  provider: Provider;
  name: string;
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
  subscriptionOnly?: boolean;
}
export interface PublicKey {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  archivedAt?: string | null;
  expiresAt: string | null;
  dailyLimit: number | null;
  grants: Grant[];
  imported: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  requestsToday: number;
  hasHubKey?: boolean;
  hubResets?: boolean;
}
export interface RequestLog {
  id: string;
  at: string;
  connectionId: string;
  keyId: string;
  keyName?: string;
  model: string | null;
  status: number;
  durationMs: number;
  accountId?: string;
  accountName?: string;
  plan?: string;
  provider?: string;
  transport?: string;
  upstreamTransport?: string;
  ttftMs?: number;
  tokens?: Tokens;
  cost?: Cost;
  reasoning?: string;
  errorCode?: string;
}
export interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  unclassified: number;
  total: number;
}
export interface Cost {
  min: number;
  max: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  priced: boolean;
  model?: string;
  tier?: string;
  version?: string;
  note?: string;
}
export interface UsageTotals {
  tokens: Tokens;
  cost: Cost;
  requests: number;
  unpriced: number;
}
export interface DailyUsage extends UsageTotals {
  day: string;
  hour?: string;
  provider: string;
}
export const routingStrategies = {
  capacity_weighted: "Capacity weighted",
  relative_availability: "Relative availability",
  usage_weighted: "Usage weighted",
  round_robin: "Round robin",
  fill_first: "Fill first",
  sequential_drain: "Sequential drain",
  reset_drain: "Reset drain",
  single_account: "Single account",
} as const;
export type RoutingStrategy = keyof typeof routingStrategies;
export interface Routing {
  strategy: RoutingStrategy;
  stickySessions: boolean;
  preferEarlierReset: boolean;
  resetWindow: "primary" | "secondary";
  power: number;
  topK: number;
  accountId?: string;
}
export interface Settings {
  autoUseResets: boolean;
  hasHubKey: boolean;
  routing?: Record<Provider, Routing>;
}
