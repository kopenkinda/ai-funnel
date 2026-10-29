import type { State } from "./api.ts";
import type { PublicConnection, Provider } from "../server/types.ts";

const reset = (hours: number) =>
  new Date(Date.now() + hours * 3600000).toISOString();
export function sampleState(): State {
  const make = (
    provider: Provider,
    name: string,
    accounts: PublicConnection["accounts"],
  ): PublicConnection => ({
    id: `sample-${provider}`,
    provider,
    name,
    url: "https://example.ts.net",
    enabled: true,
    hasApiKey: true,
    hasManagementAccess: true,
    models: [],
    accounts,
    syncedAt: new Date().toISOString(),
    error: null,
    createdAt: new Date().toISOString(),
  });
  return {
    publicUrl: "https://funnel.example.ts.net",
    keys: [],
    requests: [],
    connections: [
      make("codex", "Home Codex pool", [
        {
          id: "codex-1",
          name: "Daily driver",
          email: "account-1@example.com",
          plan: "Pro",
          status: "active",
          quotas: [
            { label: "5h", remaining: 82, resetsAt: reset(2.4) },
            { label: "7d", remaining: 64, resetsAt: reset(52) },
          ],
        },
        {
          id: "codex-2",
          name: "Projects",
          email: "account-2@example.com",
          plan: "Pro",
          status: "active",
          quotas: [
            { label: "5h", remaining: 56, resetsAt: reset(1.3) },
            { label: "7d", remaining: 79, resetsAt: reset(90) },
          ],
        },
        {
          id: "codex-3",
          name: "Long runs",
          email: "account-3@example.com",
          plan: "Plus",
          status: "limited",
          quotas: [
            { label: "5h", remaining: 0, resetsAt: reset(0.7) },
            { label: "7d", remaining: 38, resetsAt: reset(33) },
          ],
        },
        {
          id: "codex-4",
          name: "Reserve",
          email: "account-4@example.com",
          plan: "Pro",
          status: "active",
          quotas: [
            { label: "5h", remaining: 98, resetsAt: reset(4.1) },
            { label: "7d", remaining: 91, resetsAt: reset(132) },
          ],
        },
      ]),
      make("claude", "Claude subscriptions", [
        {
          id: "claude-1",
          name: "Main Claude",
          email: "claude-1@example.com",
          plan: "Max",
          status: "ready",
          quotas: [
            { label: "5h", remaining: 71, resetsAt: reset(3.2) },
            { label: "7d", remaining: 43, resetsAt: reset(65) },
          ],
        },
        {
          id: "claude-2",
          name: "Second Claude",
          email: "claude-2@example.com",
          plan: "Pro",
          status: "ready",
          quotas: [
            { label: "5h", remaining: 94, resetsAt: reset(4.6) },
            { label: "7d", remaining: 86, resetsAt: reset(110) },
          ],
        },
      ]),
      make("go", "OpenCode Go", [
        {
          id: "go-1",
          name: "Personal Go",
          email: "",
          plan: "Go subscription",
          status: "connected",
          quotas: [],
          quotaError: "Live quota is not available from this connection.",
        },
      ]),
      make("zen", "OpenCode Zen", [
        {
          id: "zen-1",
          name: "Personal Zen",
          email: "",
          plan: "Pay as you go",
          status: "connected",
          quotas: [],
          quotaError: "Balance is available in OpenCode Console.",
        },
      ]),
    ],
  };
}
