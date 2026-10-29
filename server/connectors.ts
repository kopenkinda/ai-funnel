import type { Account, Connection, Quota } from "./types.ts";
import { HttpError } from "./validation.ts";

// Upstream payloads are deliberately kept at this boundary. Only display metadata is normalized.
type Row = Record<string, any>;
const field = (r: Row, snake: string): any =>
  r[snake] ?? r[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
const percent = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.max(0, Math.min(100, n))
    : null;
const date = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(typeof v === "number" ? v * 1000 : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function upstreamJson(
  url: string,
  init: RequestInit = {},
): Promise<{ data: any; response: Response }> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(
      502,
      "Could not reach the provider. Check its URL and network access.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      response.status === 401 || response.status === 403 ? 401 : 502,
      response.status === 401 || response.status === 403
        ? "Provider rejected the credentials. Reconnect with a valid key or dashboard session."
        : `Provider returned HTTP ${response.status}.`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, "Provider returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4 * 1024 * 1024) {
      await reader.cancel();
      throw new HttpError(502, "Provider metadata exceeds the size limit.");
    }
    chunks.push(value);
  }
  try {
    return { data: JSON.parse(Buffer.concat(chunks).toString()), response };
  } catch {
    throw new HttpError(
      502,
      "Provider returned an unexpected response. Check that the URL points to the API service.",
    );
  }
}

export async function codexAdmin(
  c: Connection,
  path: string,
  method = "GET",
  body?: unknown,
) {
  return (
    await upstreamJson(`${c.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(c.cookie ? { cookie: c.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).data;
}
export async function loginCodex(
  c: Connection,
  password: string,
  username?: string,
  code?: string,
) {
  const { response, data } = await upstreamJson(
    `${c.url}/api/dashboard-auth/password/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, ...(username ? { username } : {}) }),
    },
  );
  const cookies = response.headers.getSetCookie().map((v) => v.split(";")[0]);
  c.cookie = cookies.join("; ");
  if (field(data, "totp_required_on_login") || field(data, "totp_required")) {
    if (!code)
      throw new HttpError(
        400,
        "Enter your current two-factor code to connect codex-lb.",
      );
    const verified = await upstreamJson(
      `${c.url}/api/dashboard-auth/totp/verify`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: c.cookie },
        body: JSON.stringify({ code }),
      },
    );
    const next = verified.response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0]);
    if (next.length) c.cookie = next.join("; ");
  }
}
export async function claudeAdmin(
  c: Connection,
  path: string,
  method = "GET",
  body?: unknown,
) {
  if (!c.managementKey)
    throw new HttpError(
      400,
      "Add a CLIProxyAPI management key to load your Claude accounts.",
    );
  return (
    await upstreamJson(`${c.url}/v8/management${path}`, {
      method,
      headers: {
        authorization: `Bearer ${c.managementKey}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).data;
}

export function codexAccounts(rows: Row[]): Account[] {
  return rows.map((r) => {
    const usage = r.usage || {};
    const windows: Quota[] = ["primary", "secondary", "monthly"].flatMap(
      (name, index) => {
        const minutes = field(r, `window_minutes_${name}`);
        const label = minutes
          ? minutes < 1440
            ? `${minutes / 60}h`
            : `${minutes / 1440}d`
          : ["5h", "7d", "Monthly"][index];
        const remaining = percent(field(usage, `${name}_remaining_percent`));
        if (
          name === "monthly" &&
          remaining === null &&
          !field(r, "reset_at_monthly")
        )
          return [];
        return [
          { label, remaining, resetsAt: date(field(r, `reset_at_${name}`)) },
        ];
      },
    );
    return {
      id: String(field(r, "account_id")),
      name: r.alias || field(r, "display_name") || r.email || "Codex account",
      email: r.email || "",
      plan: field(r, "plan_type") || "Subscription",
      status: r.status || "unknown",
      quotas: windows,
    };
  });
}

export async function syncConnection(c: Connection): Promise<Connection> {
  const next = { ...c };
  try {
    if (c.provider === "codex") {
      const data = await codexAdmin(c, "/api/accounts");
      if (!Array.isArray(data.accounts))
        throw new HttpError(502, "codex-lb did not return an account list.");
      next.accounts = codexAccounts(data.accounts);
      if (c.apiKey) {
        const catalog = await upstreamJson(`${c.url}/v1/models`, {
          headers: { authorization: `Bearer ${c.apiKey}` },
        });
        next.models = (catalog.data.data || catalog.data.models || [])
          .map((m: Row) => m.id || m.slug)
          .filter(Boolean);
      }
    } else if (c.provider === "claude") {
      const data = await claudeAdmin(c, "/credentials");
      if (!Array.isArray(data.files))
        throw new HttpError(
          502,
          "CLIProxyAPI did not return a credential list.",
        );
      const rows = data.files.filter(
        (r: Row) => (r.provider || r.type) === "claude",
      );
      next.accounts = [];
      // Keep quota calls sequential to avoid bursting the subscription usage endpoint.
      for (const r of rows) {
        const account: Account = {
          id: r.id || r.name,
          name: r.label || r.email || r.name,
          email: r.email || "",
          plan: r.account_type || "Subscription",
          status: r.disabled
            ? "paused"
            : r.unavailable
              ? "limited"
              : r.status || "ready",
          prefix:
            r.prefix &&
            data.files.filter((other: Row) => other.prefix === r.prefix)
              .length === 1
              ? r.prefix
              : "",
          authIndex: r.auth_index,
          quotas: [
            { label: "5h", remaining: null, resetsAt: null },
            { label: "7d", remaining: null, resetsAt: null },
          ],
        };
        try {
          if (!account.authIndex)
            throw new Error("Credential has no quota lookup identifier.");
          const result = await claudeAdmin(c, "/requests/api-call", "POST", {
            auth_index: account.authIndex,
            method: "GET",
            url: "https://api.anthropic.com/api/oauth/usage",
            header: {
              Authorization: "Bearer $TOKEN$",
              "anthropic-beta": "oauth-2025-04-20",
            },
          });
          if (result.status_code !== 200)
            throw new Error(
              `Quota endpoint returned HTTP ${result.status_code}.`,
            );
          const usage =
            typeof result.body === "string"
              ? JSON.parse(result.body)
              : result.body;
          account.quotas = [
            ["five_hour", "5h"],
            ["seven_day", "7d"],
          ].map(([name, label]) => ({
            label,
            remaining:
              typeof usage?.[name]?.utilization === "number"
                ? percent(100 - usage[name].utilization)
                : null,
            resetsAt: date(usage?.[name]?.resets_at),
          }));
        } catch {
          account.quotaError =
            "Quota is unavailable from this account. Account discovery succeeded.";
        }
        next.accounts.push(account);
      }
      if (c.apiKey) {
        const { data: catalog } = await upstreamJson(`${c.url}/v1/models`, {
          headers: { authorization: `Bearer ${c.apiKey}` },
        });
        next.models = (catalog.data || [])
          .map((m: Row) => m.id)
          .filter((id: string) => id.includes("claude"));
      }
    } else {
      if (!c.apiKey) throw new HttpError(400, "Add your OpenCode API key.");
      const { data } = await upstreamJson(`${c.url}/v1/models`, {
        headers: { authorization: `Bearer ${c.apiKey}` },
      });
      if (!Array.isArray(data.data) && !Array.isArray(data.models))
        throw new HttpError(502, "OpenCode did not return a model catalog.");
      next.models = (data.data || data.models)
        .map((m: Row) => m.id || m.slug)
        .filter(Boolean);
      next.accounts = [
        {
          id: c.id,
          name: c.name,
          email: "",
          plan: c.provider === "go" ? "Go subscription" : "Pay as you go",
          status: "connected",
          quotas: [],
          quotaError:
            "This connection does not expose a verified balance or reset API. View limits in OpenCode Console.",
        },
      ];
    }
    next.syncedAt = new Date().toISOString();
    next.error = null;
  } catch (error) {
    next.error =
      error instanceof HttpError
        ? error.message
        : "Provider metadata could not be loaded.";
  }
  return next;
}
