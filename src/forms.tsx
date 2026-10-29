import { useState, type FormEvent } from "react";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  Key01Icon,
  ShieldCheckIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  providers,
  providerNames,
  type Grant,
  type Provider,
  type PublicConnection,
  type PublicKey,
} from "../server/types.ts";
import { api } from "./api.ts";
import { CopyButton, Dialog, ErrorMessage, ProviderIcon } from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DialogFooter } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";

export function ConnectionForm({
  onClose,
  onSaved,
  reconnect,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
  reconnect?: PublicConnection;
}) {
  const [provider, setProvider] = useState<Provider>(
    reconnect?.provider || "codex",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(
        reconnect ? `/connections/${reconnect.id}/login` : "/connections",
        "POST",
        { ...values, provider },
      );
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const defaults = {
    codex: "",
    claude: "http://127.0.0.1:8317",
    zen: "https://opencode.ai/inference",
    go: "https://opencode.ai/inference/go",
  };
  return (
    <Dialog
      title={reconnect ? "Reconnect codex-lb" : "Connect a provider"}
      description="Connect the service that manages your accounts."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} key={provider} className="flex flex-col gap-6">
        <FieldGroup>
          {!reconnect && (
            <>
              <Field>
                <FieldLabel>Provider</FieldLabel>
                <ToggleGroup
                  aria-label="Provider"
                  value={[provider]}
                  onValueChange={(values) => {
                    if (values[0]) setProvider(values[0] as Provider);
                  }}
                  variant="outline"
                  spacing={0}
                  className="w-full"
                >
                  {providers.map((p) => (
                    <ToggleGroupItem
                      key={p}
                      value={p}
                      className="flex-1"
                      disabled={busy}
                    >
                      {p === "zen"
                        ? "Zen"
                        : p === "go"
                          ? "Go"
                          : providerNames[p]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="connection-name">
                  Connection name
                </FieldLabel>
                <Input
                  id="connection-name"
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={
                    provider === "codex"
                      ? "Home Codex pool"
                      : provider === "claude"
                        ? "Claude subscriptions"
                        : providerNames[provider]
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="connection-url">Server URL</FieldLabel>
                <Input
                  id="connection-url"
                  name="url"
                  type="url"
                  required
                  defaultValue={defaults[provider]}
              placeholder="https://codex.example.com"
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </Field>
            </>
          )}
          {provider === "codex" ? (
            <>
              <Alert>
                <Icon icon={ShieldCheckIcon} />
                <AlertDescription>
                  Sign in to codex-lb to load accounts and quotas. Account
                  tokens stay in codex-lb.
                </AlertDescription>
              </Alert>
              <FieldGroup className="sm:flex-row">
                <Field>
                  <FieldLabel htmlFor="connection-username">
                    Username
                  </FieldLabel>
                  <Input
                    id="connection-username"
                    name="username"
                    autoComplete="username"
                    placeholder="Optional"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="connection-code">
                    Two-factor code
                  </FieldLabel>
                  <Input
                    id="connection-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="If enabled"
                  />
                </Field>
              </FieldGroup>
              <Field>
                <FieldLabel htmlFor="connection-password">
                  codex-lb password
                </FieldLabel>
                <Input
                  id="connection-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="If enabled"
                />
                <FieldDescription>
                  Used once to create an encrypted session. Your password is
                  never saved.
                </FieldDescription>
              </Field>
              {!reconnect && (
                <Field>
                  <FieldLabel htmlFor="connection-api-key">
                    codex-lb API key
                  </FieldLabel>
                  <Input
                    id="connection-api-key"
                    name="apiKey"
                    type="password"
                    autoComplete="off"
                    placeholder="sk-clb-…"
                  />
                  <FieldDescription>
                    Optional. Used for model discovery.
                  </FieldDescription>
                </Field>
              )}
            </>
          ) : provider === "claude" ? (
            <>
              <Field>
                <FieldLabel htmlFor="connection-management-key">
                  CLIProxyAPI management key
                </FieldLabel>
                <Input
                  id="connection-management-key"
                  name="managementKey"
                  type="password"
                  required
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="connection-api-key">
                  CLIProxyAPI client key
                </FieldLabel>
                <Input
                  id="connection-api-key"
                  name="apiKey"
                  type="password"
                  required
                  autoComplete="off"
                />
                <FieldDescription>
                  Claude subscription logins stay in CLIProxyAPI. Management API
                  v8 is required.
                </FieldDescription>
              </Field>
            </>
          ) : (
            <Field>
              <FieldLabel htmlFor="connection-api-key">
                OpenCode API key
              </FieldLabel>
              <Input
                id="connection-api-key"
                name="apiKey"
                type="password"
                required
                autoComplete="off"
              />
              <FieldDescription>
                Each credential is a separate connection.{" "}
                {provider === "go" ? "Go subscription usage" : "Zen balance"}{" "}
                stays with OpenCode.
              </FieldDescription>
            </Field>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Spinner data-icon="inline-start" />}
            {busy
              ? "Connecting…"
              : reconnect
                ? "Reconnect"
                : "Connect provider"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function KeyForm({
  connections,
  onClose,
  onSaved,
}: {
  connections: PublicConnection[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    token: string | null;
    key: PublicKey;
  } | null>(null);
  function update(id: string, value: Partial<Grant>) {
    setGrants((prev) =>
      prev.map((g) => (g.connectionId === id ? { ...g, ...value } : g)),
    );
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const result = await api<{ token: string | null; key: PublicKey }>(
        "/keys",
        "POST",
        {
          name: data.name,
          grants,
          dailyLimit: data.dailyLimit ? Number(data.dailyLimit) : null,
          expiresAt: data.expiresAt
            ? new Date(String(data.expiresAt)).toISOString()
            : null,
          existingKey: mode === "import" ? data.existingKey : "",
        },
      );
      setCreated(result);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (created)
    return (
      <Dialog
        title={created.token ? "Your key is ready" : "Existing key registered"}
        description={
          created.token
            ? "Copy this key now. You will only see it once."
            : "Use your existing key with the allowed provider URLs."
        }
        onClose={onClose}
      >
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary">
            <Icon icon={Tick02Icon} size={20} />
          </span>
          <div>
            <p className="font-medium">{created.key.name}</p>
            <p className="text-sm text-muted-foreground">
              {created.key.grants.length} provider connection
              {created.key.grants.length === 1 ? "" : "s"} allowed
            </p>
          </div>
        </div>
        {created.token && (
          <div
            className="flex flex-col items-start gap-3 rounded-2xl border bg-muted/40 p-4"
            aria-label="New API key"
          >
            <code className="break-all text-sm select-all">
              {created.token}
            </code>
            <CopyButton
              value={created.token}
              label="Copy key"
              onError={setError}
            />
          </div>
        )}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </Dialog>
    );
  return (
    <Dialog
      title="Add a shared key"
      description="One key for the providers and accounts you choose."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel>Key source</FieldLabel>
            <ToggleGroup
              value={[mode]}
              onValueChange={(v) => {
                if (!v[0]) return;
                setMode(v[0] as "create" | "import");
                if (v[0] === "import")
                  setGrants((prev) =>
                    prev.map((g) =>
                      connections.find((c) => c.id === g.connectionId)
                        ?.provider === "codex"
                        ? { ...g, accountIds: null }
                        : g,
                    ),
                  );
              }}
              variant="outline"
              spacing={0}
              className="w-full"
              aria-label="Key source"
            >
              <ToggleGroupItem value="create" className="flex-1">
                Create key
              </ToggleGroupItem>
              <ToggleGroupItem value="import" className="flex-1">
                Use existing Codex key
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="key-name">Key name</FieldLabel>
            <Input
              id="key-name"
              name="name"
              required
              maxLength={80}
              placeholder="Personal devices"
            />
          </Field>
          {mode === "import" && (
            <Field>
              <FieldLabel htmlFor="existing-key">
                Existing codex-lb key
              </FieldLabel>
              <Input
                id="existing-key"
                name="existingKey"
                type="password"
                required
                autoComplete="off"
                placeholder="sk-clb-…"
              />
              <FieldDescription>
                Codex restrictions stay enforced by codex-lb. Choose access to
                other providers below.
              </FieldDescription>
            </Field>
          )}
          <FieldSet>
            <FieldLegend variant="label">Provider access</FieldLegend>
            <FieldGroup>
              {connections.length ? (
                connections.map((c) => {
                  const grant = grants.find((g) => g.connectionId === c.id);
                  return (
                    <FieldSet key={c.id} className="rounded-2xl border p-4">
                      <Field orientation="horizontal">
                        <Checkbox
                          id={`grant-${c.id}`}
                          checked={!!grant}
                          onCheckedChange={(checked) =>
                            setGrants((prev) =>
                              checked
                                ? [
                                    ...prev,
                                    {
                                      connectionId: c.id,
                                      accountIds: null,
                                      models: null,
                                    },
                                  ]
                                : prev.filter((g) => g.connectionId !== c.id),
                            )
                          }
                        />
                        <FieldContent>
                          <FieldLabel htmlFor={`grant-${c.id}`}>
                            {c.name}
                          </FieldLabel>
                          <FieldDescription>
                            {providerNames[c.provider]}
                          </FieldDescription>
                        </FieldContent>
                        <ProviderIcon provider={c.provider} small />
                      </Field>
                      {grant && (
                        <FieldGroup>
                          {c.provider === "codex" && mode === "import" ? (
                            <FieldDescription>
                              Account access inherited from the existing key.
                            </FieldDescription>
                          ) : c.provider === "codex" ||
                            c.provider === "claude" ? (
                            <FieldSet>
                              <FieldLegend variant="label" className="sr-only">
                                Accounts for {c.name}
                              </FieldLegend>
                              <FieldGroup data-slot="checkbox-group">
                                <Field orientation="horizontal">
                                  <Checkbox
                                    id={`pool-${c.id}`}
                                    checked={grant.accountIds === null}
                                    onCheckedChange={(checked) =>
                                      update(c.id, {
                                        accountIds: checked ? null : [],
                                      })
                                    }
                                  />
                                  <FieldLabel htmlFor={`pool-${c.id}`}>
                                    Allow the whole account pool
                                  </FieldLabel>
                                </Field>
                                {grant.accountIds !== null &&
                                  c.accounts.map((a) => (
                                    <Field
                                      key={a.id}
                                      orientation="horizontal"
                                      data-disabled={
                                        c.provider === "claude" && !a.prefix
                                      }
                                    >
                                      <Checkbox
                                        id={`account-${c.id}-${a.id}`}
                                        checked={grant.accountIds!.includes(
                                          a.id,
                                        )}
                                        disabled={
                                          c.provider === "claude" && !a.prefix
                                        }
                                        onCheckedChange={(checked) =>
                                          update(c.id, {
                                            accountIds: checked
                                              ? [...grant.accountIds!, a.id]
                                              : grant.accountIds!.filter(
                                                  (id) => id !== a.id,
                                                ),
                                          })
                                        }
                                      />
                                      <FieldContent>
                                        <FieldLabel
                                          htmlFor={`account-${c.id}-${a.id}`}
                                        >
                                          {a.name}
                                        </FieldLabel>
                                        {c.provider === "claude" &&
                                          !a.prefix && (
                                            <FieldDescription>
                                              Configure a routing prefix in
                                              CLIProxyAPI first.
                                            </FieldDescription>
                                          )}
                                      </FieldContent>
                                    </Field>
                                  ))}
                              </FieldGroup>
                            </FieldSet>
                          ) : (
                            <FieldDescription>
                              Uses this connection's OpenCode credential.
                            </FieldDescription>
                          )}
                          <Field>
                            <FieldLabel htmlFor={`models-${c.id}`}>
                              Allowed models
                            </FieldLabel>
                            <Input
                              id={`models-${c.id}`}
                              placeholder="All models"
                              onChange={(e) =>
                                update(c.id, {
                                  models: e.target.value.trim()
                                    ? e.target.value
                                        .split(",")
                                        .map((s) => s.trim())
                                        .filter(Boolean)
                                    : null,
                                })
                              }
                            />
                            <FieldDescription>
                              Separate model IDs with commas. Leave empty to
                              allow all.
                            </FieldDescription>
                          </Field>
                        </FieldGroup>
                      )}
                    </FieldSet>
                  );
                })
              ) : (
                <FieldDescription>
                  Connect a provider before creating a key.
                </FieldDescription>
              )}
            </FieldGroup>
          </FieldSet>
          <FieldGroup className="sm:flex-row">
            <Field>
              <FieldLabel htmlFor="daily-limit">Requests per day</FieldLabel>
              <Input
                id="daily-limit"
                name="dailyLimit"
                type="number"
                min="1"
                step="1"
                placeholder="No limit"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="key-expiry">Expires on</FieldLabel>
              <Input
                id="key-expiry"
                name="expiresAt"
                type="date"
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
              />
            </Field>
          </FieldGroup>
          <FieldDescription>
            Optional request caps reset at midnight UTC. Upstream subscription
            limits still apply.
          </FieldDescription>
          {error && <ErrorMessage>{error}</ErrorMessage>}
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !grants.length}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Icon icon={Key01Icon} data-icon="inline-start" />
            )}
            {busy
              ? "Saving…"
              : mode === "import"
                ? "Register existing key"
                : "Create key"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function ConnectionDetails({
  connection: c,
  origin,
  onClose,
}: {
  connection: PublicConnection;
  origin: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"openai" | "anthropic">("openai");
  const [error, setError] = useState("");
  const root = `${origin}/providers/${c.provider}/${c.id}`;
  const base =
    c.provider === "codex"
      ? `${root}/backend-api/codex`
      : c.provider === "claude"
        ? root
        : `${root}/${format}/v1`;
  const model = c.models.find((m) => !m.includes("/")) || "YOUR_MODEL_ID";
  const snippet =
    c.provider === "codex"
      ? `model_provider = "ai-funnel"\nmodel = "${model}"\n\n[model_providers.ai-funnel]\nname = "ai-funnel"\nbase_url = "${base}"\nwire_api = "responses"\nenv_key = "AI_FUNNEL_KEY"\nrequires_openai_auth = false\nsupports_websockets = false`
      : c.provider === "claude"
        ? `export ANTHROPIC_BASE_URL='${base}'\nexport ANTHROPIC_AUTH_TOKEN="$AI_FUNNEL_KEY"\nclaude`
        : `curl '${base}/${format === "anthropic" ? "messages" : "chat/completions"}' \\\n  -H "Authorization: Bearer $AI_FUNNEL_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ model, ...(format === "anthropic" ? { max_tokens: 1024 } : {}), messages: [{ role: "user", content: "Hello" }] })}'`;
  return (
    <Dialog
      title={c.name}
      description="Use a shared key that allows this connection."
      onClose={onClose}
    >
      <div className="flex items-center gap-3">
        <ProviderIcon provider={c.provider} />
        <div>
          <p className="font-medium">{providerNames[c.provider]}</p>
          <p className="text-sm text-muted-foreground">
            {c.provider === "codex"
              ? "Native Codex Responses"
              : c.provider === "claude"
                ? "Native Anthropic Messages"
                : "Choose your client's API format"}
          </p>
        </div>
        <Badge variant="secondary" className="ml-auto">
          {c.models.length} models
        </Badge>
      </div>
      {(c.provider === "zen" || c.provider === "go") && (
        <ToggleGroup
          value={[format]}
          onValueChange={(v) => {
            if (v[0]) setFormat(v[0] as "openai" | "anthropic");
          }}
          variant="outline"
          spacing={0}
          aria-label="API format"
        >
          <ToggleGroupItem value="openai">OpenAI format</ToggleGroupItem>
          <ToggleGroupItem value="anthropic">Anthropic format</ToggleGroupItem>
        </ToggleGroup>
      )}
      <FieldGroup>
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>Base URL</FieldLabel>
            <CopyButton value={base} label="Copy URL" onError={setError} />
          </div>
          <code className="rounded-2xl border bg-muted/40 p-3 text-xs leading-relaxed break-all select-all">
            {base}
          </code>
        </Field>
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>
              {c.provider === "codex"
                ? "Codex config.toml"
                : c.provider === "claude"
                  ? "Claude Code"
                  : "Example request"}
            </FieldLabel>
            <CopyButton
              value={snippet}
              label="Copy config"
              onError={setError}
            />
          </div>
          <pre className="overflow-x-auto rounded-2xl border bg-muted/40 p-4 text-xs leading-6">
            <code>{snippet}</code>
          </pre>
          <FieldDescription>
            Set AI_FUNNEL_KEY to your client key on this device.
          </FieldDescription>
        </Field>
        {c.provider === "codex" && (
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>Compatible clients</FieldLabel>
              <CopyButton
                value={`${root}/v1`}
                label="Copy compatible URL"
                onError={setError}
              />
            </div>
            <code className="rounded-2xl border bg-muted/40 p-3 text-xs leading-relaxed break-all select-all">{`${root}/v1`}</code>
            <FieldDescription>
              HTTP streaming is supported. Keep WebSocket transport disabled.
            </FieldDescription>
          </Field>
        )}
      </FieldGroup>
      <Separator />
      <Button
        variant="outline"
        nativeButton={false}
        render={
          <a
            href={
              c.provider === "zen" || c.provider === "go"
                ? "https://opencode.ai"
                : c.provider === "claude"
                  ? `${c.url}/management.html`
                  : c.url
            }
            target="_blank"
            rel="noreferrer"
          />
        }
      >
        Manage upstream accounts
        <Icon icon={ArrowUpRight01Icon} data-icon="inline-end" />
      </Button>
      {error && <ErrorMessage>{error}</ErrorMessage>}
    </Dialog>
  );
}
