import { useEffect, useId, useState, type FormEvent } from "react";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  Key01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  providerNames,
  type Grant,
  type Provider,
  type PublicConnection,
  type PublicKey,
} from "./types.ts";
import { api } from "./api.ts";
import { CopyButton, Dialog, ErrorMessage, ProviderIcon } from "./ui.tsx";
import { PrivateText, usePrivacy } from "./privacy.tsx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
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
import { DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@/components/ui/combobox";

export function ConnectionForm({
  onClose,
  onSaved,
  provider,
  connection,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
  provider: Provider;
  connection?: PublicConnection;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [method, setMethod] = useState<"oauth" | "token" | "file">("oauth");
  const [authFile, setAuthFile] = useState<File | null>(null);
  const [login, setLogin] = useState<{
    url: string;
    state: string;
    connectionId: string;
  } | null>(null);
  const [callback, setCallback] = useState("");
  useEffect(() => {
    if (!login) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<{ status: string }>(
          `/oauth/status?state=${encodeURIComponent(login!.state)}`,
        );
        if (!active) return;
        if (result.status === "ok") {
          await api(`/connections/${login!.connectionId}/sync`, "POST");
          if (!active) return;
          await onSaved();
          onClose();
          return;
        }
        if (result.status === "error") {
          setError(
            "Sign-in failed or expired. Close this dialog and try again.",
          );
          return;
        }
        timer = setTimeout(poll, 2000);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
      void api(
        `/oauth/session?state=${encodeURIComponent(login.state)}`,
        "DELETE",
      ).catch(() => {});
    };
  }, [login]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (method !== "oauth") {
        let auth: unknown;
        if (method === "file") {
          if (!authFile || authFile.size > 64 * 1024)
            throw new Error("Choose a JSON credential file under 64 KB.");
          try {
            auth = JSON.parse(await authFile.text());
          } catch {
            throw new Error("Choose a valid JSON credential file.");
          }
        }
        const connection = await api<PublicConnection>(
          "/accounts/import",
          "POST",
          {
            provider,
            ...(method === "file"
              ? { auth }
              : { token: values.token, accountId: values.accountId }),
          },
        );
        await api(`/connections/${connection.id}/sync`, "POST");
        await onSaved();
        onClose();
        return;
      }
      const pool =
        connection ||
        (await api<PublicConnection>("/connections", "POST", {
          provider,
          name: providerNames[provider],
        }));
      const result = await api<{
        url?: string;
        authorization_url?: string;
        state: string;
      }>("/oauth", "POST", { provider });
      const url = result.authorization_url || result.url;
      if (!url || !result.state)
        throw new Error("Sign-in did not return an authorization URL.");
      setLogin({ url, state: result.state, connectionId: pool.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        login
          ? `Sign in to ${providerNames[provider]}`
          : `Add ${providerNames[provider]} account`
      }
      description={
        login
          ? "Complete sign-in in your browser, then return here."
          : undefined
      }
      onClose={onClose}
    >
      {login ? (
        <div className="flex flex-col gap-5">
          <Button
            render={<a href={login.url} target="_blank" rel="noreferrer" />}
          >
            Open sign-in <Icon icon={ArrowUpRight01Icon} />
          </Button>
          <p className="text-sm text-muted-foreground">
            If the browser finishes on an unreachable localhost page, paste that
            page's complete URL below.
          </p>
          <Field>
            <FieldLabel htmlFor="oauth-callback">Callback URL</FieldLabel>
            <Input
              id="oauth-callback"
              value={callback}
              onChange={(e) => setCallback(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Button
            variant="outline"
            disabled={!callback || busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api("/oauth/callback", "POST", {
                  redirect_url: callback,
                });
                setCallback("");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Complete sign-in
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            Waiting for sign-in…
          </p>
          {error && <ErrorMessage>{error}</ErrorMessage>}
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel>Account source</FieldLabel>
              <ToggleGroup
                aria-label="Account source"
                value={[method]}
                onValueChange={(v) => {
                  if (v[0]) {
                    setMethod(v[0] as typeof method);
                    setAuthFile(null);
                    setError("");
                  }
                }}
                variant="outline"
                spacing={0}
                disabled={busy}
                className="w-full"
              >
                <ToggleGroupItem value="oauth" className="flex-1">
                  OAuth
                </ToggleGroupItem>
                <ToggleGroupItem value="token" className="flex-1">
                  Auth token
                </ToggleGroupItem>
                <ToggleGroupItem value="file" className="flex-1">
                  JSON file
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            {method === "token" && (
              <>
                <Field>
                  <FieldLabel htmlFor="account-token">Auth token</FieldLabel>
                  <Input
                    id="account-token"
                    key={provider}
                    name="token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    disabled={busy}
                  />
                  <FieldDescription>
                    {provider === "claude"
                      ? "Paste an OAuth access token or Claude setup token."
                      : "Paste the access_token from your Codex login."}{" "}
                    To keep automatic refresh, import the credential file
                    instead.
                  </FieldDescription>
                </Field>
                {provider === "codex" && (
                  <Field>
                    <FieldLabel htmlFor="account-id">
                      Account ID (optional)
                    </FieldLabel>
                    <Input
                      id="account-id"
                      name="accountId"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                    />
                    <FieldDescription>
                      Usually read from the token automatically.
                    </FieldDescription>
                  </Field>
                )}
              </>
            )}
            {method === "file" && (
              <Field>
                <FieldLabel htmlFor="account-file">
                  {provider === "codex" ? "auth.json" : "Credential JSON"}
                </FieldLabel>
                <Input
                  key={provider}
                  id="account-file"
                  type="file"
                  accept=".json,application/json"
                  required
                  disabled={busy}
                  onChange={(e) => setAuthFile(e.target.files?.[0] ?? null)}
                />
                <FieldDescription>
                  {provider === "codex"
                    ? "Choose ~/.codex/auth.json or a CLIProxyAPI credential file."
                    : "Choose a CLIProxyAPI credential file or Claude Code's .credentials.json."}{" "}
                  Credentials are encrypted after import.
                </FieldDescription>
              </Field>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {method === "oauth" ? "Continue to sign-in" : "Import account"}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

export function KeyForm({
  connections,
  clientKey,
  inline = false,
  onClose,
  onSaved,
}: {
  connections: PublicConnection[];
  clientKey?: PublicKey;
  inline?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const formId = useId();
  const privacy = usePrivacy((state) => state.enabled);
  const [name, setName] = useState(clientKey?.name ?? "");
  const [dailyLimit, setDailyLimit] = useState(
    String(clientKey?.dailyLimit ?? ""),
  );
  const [expiresAt, setExpiresAt] = useState(
    clientKey?.expiresAt?.slice(0, 10) ?? "",
  );
  const [mode, setMode] = useState<"create" | "import">("create");
  const [grants, setGrants] = useState<Grant[]>(() =>
    structuredClone(clientKey?.grants ?? []),
  );
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
      const settings = {
        name: data.name,
        grants,
        dailyLimit: data.dailyLimit ? Number(data.dailyLimit) : null,
        ...(clientKey &&
        data.expiresAt === (clientKey.expiresAt?.slice(0, 10) ?? "")
          ? {}
          : {
              expiresAt: data.expiresAt
                ? new Date(String(data.expiresAt)).toISOString()
                : null,
            }),
      };
      if (clientKey) {
        await api(`/keys/${clientKey.id}`, "PATCH", settings);
        await onSaved();
        if (!inline) onClose();
        return;
      }
      const result = await api<{ token: string | null; key: PublicKey }>(
        "/keys",
        "POST",
        {
          ...settings,
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
            <p className="font-medium">
              <PrivateText>{created.key.name}</PrivateText>
            </p>
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
  const dirty =
    !clientKey ||
    name !== clientKey.name ||
    dailyLimit !== String(clientKey.dailyLimit ?? "") ||
    expiresAt !== (clientKey.expiresAt?.slice(0, 10) ?? "") ||
    JSON.stringify(grants) !== JSON.stringify(clientKey.grants);
  const Footer = inline ? "div" : DialogFooter;
  const rowLayout = inline
    ? "@md/field-group:grid @md/field-group:grid-cols-[minmax(0,1fr)_20rem] @md/field-group:items-center"
    : undefined;
  const form = (
    <form
      onSubmit={submit}
      aria-label={clientKey ? "API key settings" : undefined}
      className={cn("flex min-w-0 flex-col gap-6", inline && "flex-1")}
    >
      <FieldGroup className={cn(inline && "gap-6")}>
        {!clientKey && (
          <Field>
            <FieldLabel>Key source</FieldLabel>
            <ToggleGroup
              value={[mode]}
              onValueChange={(v) => {
                if (!v[0]) return;
                setMode(v[0] as "create" | "import");
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
                Use existing key
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        )}
        <Field className={rowLayout}>
          <FieldLabel htmlFor={`${formId}-key-name`}>Key name</FieldLabel>
          <Input
            id={`${formId}-key-name`}
            name="name"
            required
            maxLength={80}
            placeholder="Personal devices"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className={cn(
              inline && privacy && name.includes("@") && "not-focus:blur-sm",
            )}
          />
        </Field>
        {!clientKey && mode === "import" && (
          <Field>
            <FieldLabel htmlFor={`${formId}-existing-key`}>
              Existing API key
            </FieldLabel>
            <Input
              id={`${formId}-existing-key`}
              name="existingKey"
              type="password"
              required
              autoComplete="off"
              placeholder="Your existing device key"
            />
            <FieldDescription>
              Choose the providers and accounts this key can use.
            </FieldDescription>
          </Field>
        )}
        <FieldGroup className={cn(inline ? "gap-6" : "sm:flex-row")}>
          <Field className={rowLayout}>
            <FieldLabel htmlFor={`${formId}-daily-limit`}>
              Requests per day
            </FieldLabel>
            <Input
              id={`${formId}-daily-limit`}
              name="dailyLimit"
              type="number"
              min="1"
              step="1"
              placeholder="No limit"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field className={rowLayout}>
            <FieldLabel htmlFor={`${formId}-key-expiry`}>Expires on</FieldLabel>
            <Input
              id={`${formId}-key-expiry`}
              name="expiresAt"
              type="date"
              min={
                clientKey
                  ? undefined
                  : new Date(Date.now() + 86400000).toISOString().slice(0, 10)
              }
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={busy}
            />
          </Field>
        </FieldGroup>
        {inline && <Separator />}
        <FieldSet>
          <FieldLegend variant="label">Provider access</FieldLegend>
          <FieldGroup>
            {connections.length ? (
              connections.map((c) => {
                const grant = grants.find((g) => g.connectionId === c.id);
                return (
                  <FieldSet
                    key={c.id}
                    className={cn(
                      "gap-3",
                      inline
                        ? "border-b pb-5 last:border-0 last:pb-0"
                        : "rounded-2xl border p-4",
                    )}
                  >
                    <Field orientation="horizontal">
                      <Checkbox
                        id={`${formId}-grant-${c.id}`}
                        checked={!!grant}
                        disabled={busy}
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
                        <FieldLabel htmlFor={`${formId}-grant-${c.id}`}>
                          <PrivateText>{c.name}</PrivateText>
                        </FieldLabel>
                        {c.name !== providerNames[c.provider] && (
                          <FieldDescription>
                            {providerNames[c.provider]}
                          </FieldDescription>
                        )}
                      </FieldContent>
                      <ProviderIcon provider={c.provider} small />
                    </Field>
                    {grant && (
                      <FieldGroup className={cn("gap-4", inline && "pl-7")}>
                        {c.provider === "codex" && (
                          <Field orientation="horizontal">
                            <Checkbox
                              id={`${formId}-subscription-${c.id}`}
                              checked={grant.subscriptionOnly ?? false}
                              disabled={busy}
                              onCheckedChange={(checked) =>
                                update(c.id, { subscriptionOnly: checked })
                              }
                            />
                            <FieldLabel
                              htmlFor={`${formId}-subscription-${c.id}`}
                            >
                              Subscription only
                            </FieldLabel>
                          </Field>
                        )}
                        <FieldSet>
                          <FieldLegend variant="label" className="sr-only">
                            Accounts for <PrivateText>{c.name}</PrivateText>
                          </FieldLegend>
                          <FieldGroup data-slot="checkbox-group">
                            <Field orientation="horizontal">
                              <Checkbox
                                id={`${formId}-pool-${c.id}`}
                                checked={grant.accountIds === null}
                                disabled={busy}
                                onCheckedChange={(checked) =>
                                  update(c.id, {
                                    accountIds: checked ? null : [],
                                  })
                                }
                              />
                              <FieldLabel htmlFor={`${formId}-pool-${c.id}`}>
                                Allow the whole account pool
                              </FieldLabel>
                            </Field>
                            {grant.accountIds !== null &&
                              c.accounts.map((a) => (
                                <Field key={a.id} orientation="horizontal">
                                  <Checkbox
                                    id={`${formId}-account-${c.id}-${a.id}`}
                                    checked={grant.accountIds!.includes(a.id)}
                                    disabled={busy}

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
                                      htmlFor={`${formId}-account-${c.id}-${a.id}`}
                                    >
                                      <PrivateText>{a.name}</PrivateText>
                                    </FieldLabel>
                                  </FieldContent>
                                </Field>
                              ))}
                          </FieldGroup>
                        </FieldSet>
                        <ModelAccess
                          connection={c}
                          value={grant.models}
                          disabled={busy}
                          onChange={(models) => update(c.id, { models })}
                        />
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
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </FieldGroup>
      <Footer
        className={cn(
          inline &&
            "sticky bottom-0 mt-auto flex justify-end gap-2 border-t bg-background py-4",
        )}
      >
        <Button
          type="button"
          variant="outline"
          disabled={busy || (inline && !dirty)}
          onClick={onClose}
        >
          {inline ? "Reset" : "Cancel"}
        </Button>
        <Button
          type="submit"
          disabled={
            busy ||
            (inline && !dirty) ||
            !grants.length ||
            grants.some(
              (g) => g.models?.length === 0 || g.accountIds?.length === 0,
            )
          }
        >
          {busy ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Icon icon={Key01Icon} data-icon="inline-start" />
          )}
          {busy
            ? "Saving…"
            : clientKey
              ? "Save changes"
              : mode === "import"
                ? "Register existing key"
                : "Create key"}
        </Button>
      </Footer>
    </form>
  );
  return inline ? (
    form
  ) : (
    <Dialog
      title={clientKey ? "Edit API key" : "Add a shared key"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {form}
    </Dialog>
  );
}

function ModelAccess({
  connection,
  value,
  disabled,
  onChange,
}: {
  connection: PublicConnection;
  value: string[] | null;
  disabled: boolean;
  onChange: (models: string[] | null) => void;
}) {
  const formId = useId();
  const [models, setModels] = useState(connection.models);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<{ data: { id: string }[] }>(`/connections/${connection.id}/models`)
      .then((result) => {
        if (active) setModels(result.data.map((model) => model.id));
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connection.id, attempt]);
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">Models</FieldLegend>
      <FieldGroup className="gap-3">
        <Field orientation="horizontal">
          <Checkbox
            id={`${formId}-all-models-${connection.id}`}
            checked={value === null}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked ? null : [])}
          />
          <FieldLabel htmlFor={`${formId}-all-models-${connection.id}`}>
            All models
          </FieldLabel>
        </Field>
        {value !== null && (
          <Field>
            <FieldLabel
              htmlFor={`${formId}-models-${connection.id}`}
              className="sr-only"
            >
              {providerNames[connection.provider]} models
            </FieldLabel>
            <Combobox
              items={models}
              multiple
              value={value}
              onValueChange={onChange}
              disabled={disabled}
            >
              {value.length > 0 && (
                <ComboboxChips aria-label="Selected models">
                  <ComboboxValue>
                    {(selected: string[]) =>
                      selected.map((model) => (
                        <ComboboxChip
                          key={model}
                          aria-label={model}
                          removeLabel={`Remove ${model}`}
                          className="max-w-full"
                        >
                          <span className="truncate">{model}</span>
                        </ComboboxChip>
                      ))
                    }
                  </ComboboxValue>
                </ComboboxChips>
              )}
              <ComboboxInput
                id={`${formId}-models-${connection.id}`}
                placeholder={loading ? "Loading models…" : "Select models…"}
                disabled={disabled || loading || !!error}
              />
              <ComboboxContent>
                <ComboboxEmpty>No models found</ComboboxEmpty>
                <ComboboxList>
                  {(model: string) => (
                    <ComboboxItem key={model} value={model}>
                      {model}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </Field>
        )}
        {error && (
          <div className="flex flex-col items-start gap-2">
            <ErrorMessage>{error}</ErrorMessage>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setAttempt((v) => v + 1)}
            >
              Retry models
            </Button>
          </div>
        )}
      </FieldGroup>
    </FieldSet>
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
  const [accountStates, setAccountStates] = useState<Record<string, boolean>>(
    {},
  );
  const [error, setError] = useState("");
  const root = `${origin}/providers/${c.provider}/${c.id}`;
  const base = c.provider === "codex" ? `${root}/backend-api/codex` : root;
  const model = c.models.find((m) => !m.includes("/")) || "YOUR_MODEL_ID";
  const snippet =
    c.provider === "codex"
      ? `model_provider = "ai-funnel"\nmodel = "${model}"\n\n[model_providers.ai-funnel]\nname = "ai-funnel"\nbase_url = "${base}"\nwire_api = "responses"\nenv_key = "AI_FUNNEL_KEY"\nrequires_openai_auth = false\nsupports_websockets = true`
      : `export ANTHROPIC_BASE_URL='${base}'\nexport ANTHROPIC_AUTH_TOKEN="$AI_FUNNEL_KEY"\nclaude`;
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
              : "Native Anthropic Messages"}
          </p>
        </div>
        <Badge variant="secondary" className="ml-auto">
          {c.models.length} models
        </Badge>
      </div>
      {c.accounts.length > 0 && (
        <div className="flex flex-col gap-2" aria-label="Manage accounts">
          {c.accounts.map((account) => {
            const enabled =
              accountStates[account.id] ?? account.status !== "paused";
            return (
              <div
                key={account.id}
                className="flex items-center justify-between gap-3 border-b py-2 last:border-0"
              >
                <span className="truncate text-sm">
                  <PrivateText>{account.email || account.name}</PrivateText>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await api(
                        `/accounts/${encodeURIComponent(account.id)}`,
                        "PATCH",
                        { enabled: !enabled },
                      );
                      setAccountStates((previous) => ({
                        ...previous,
                        [account.id]: !enabled,
                      }));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {enabled ? "Pause" : "Resume"}
                </Button>
              </div>
            );
          })}
        </div>
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
              {c.provider === "codex" ? "Codex config.toml" : "Claude Code"}
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
      {error && <ErrorMessage>{error}</ErrorMessage>}
    </Dialog>
  );
}
