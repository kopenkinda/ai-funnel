import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useRoutes } from "react-router";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  Activity01Icon,
  Add01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  Delete02Icon,
  Key01Icon,
  Layers01Icon,
  Link01Icon,
  Logout01Icon,
  Moon01Icon,
  PauseIcon,
  PlayIcon,
  Refresh01Icon,
  Sun01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import {
  providers,
  providerNames,
  type Provider,
  type PublicConnection,
} from "./types.ts";
import { cn } from "@/lib/utils";
import { api, type State } from "./api.ts";
import { ErrorMessage, ProviderIcon } from "./ui.tsx";
import { UsageMetrics } from "./metrics";
import { KeyManager, KeyUsageSummary } from "./keys";
import { ActivityLog } from "./activity";
import { DashboardSettings } from "./settings";
import { UsageOverview } from "./usage.tsx";
import { PrivacyButton, PrivateText } from "./privacy.tsx";
import { ConnectionDetails, ConnectionForm, KeyForm } from "./forms.tsx";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const tabs = [
  { id: "pool", path: "/usage", name: "Usage", icon: Layers01Icon },
  {
    id: "connections",
    path: "/connections",
    name: "Connections",
    icon: Link01Icon,
  },
  { id: "keys", path: "/keys", name: "API keys", icon: Key01Icon },
  { id: "activity", path: "/activity", name: "Activity", icon: Activity01Icon },
] as const;
type Tab = (typeof tabs)[number]["id"];
const empty: State = { connections: [], keys: [], requests: [], publicUrl: "" };

// Native upstreams in the embedded CLIProxyAPI version that Funnel has not integrated.
const unsupportedProviders: {
  name: string;
  logo?: string;
  darkLogo?: string;
}[] = [
  { name: "Gemini", logo: "gemini.svg" },
  { name: "Google AI Studio", logo: "google.svg" },
  { name: "Vertex AI", logo: "google-cloud.svg" },
  { name: "Antigravity", logo: "antigravity.svg" },
  { name: "Grok", logo: "grok-light.svg", darkLogo: "grok-dark.svg" },
  { name: "Kimi", logo: "kimi-icon.svg" },
  { name: "Devin", logo: "devin.svg" },
  { name: "Meta", logo: "meta.svg" },
  { name: "OpenAI compatible" },
];

export function App() {
  return useRoutes([
    ...tabs.map(({ id, path }) => ({ path, element: <Dashboard tab={id} /> })),
    { path: "*", element: <Navigate to="/usage" replace /> },
  ]);
}

function Dashboard({ tab }: { tab: Tab }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [state, setState] = useState<State>(empty);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [modal, setModal] = useState<"key" | "settings" | null>(null);
  const [details, setDetails] = useState<PublicConnection | null>(null);
  const [accountProvider, setAccountProvider] = useState<Provider | null>(null);
  const [remove, setRemove] = useState<{
    type: "connections" | "keys";
    id: string;
    name: string;
  } | null>(null);

  const reload = async () => {
    setState(await api<State>("/state"));
  };
  useEffect(() => {
    api<{ authenticated: boolean }>("/session")
      .then((s) => setAuthenticated(s.authenticated))
      .catch((e) => {
        setError(e.message);
        setAuthenticated(false);
      });
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const load = () => {
      void reload().catch((e) => setError(e.message));
    };
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [authenticated]);
  const connections = state.connections;
  const connected = connections.filter((c) => c.accounts.length > 0);
  const providerEntries = providers.map((provider) => {
    const connection = connections.find((c) => c.provider === provider);
    return {
      provider,
      connection,
      enabled: !!connection?.enabled && connection.accounts.length > 0,
    };
  });
  const origin = state.publicUrl || window.location.origin;
  async function action(id: string, task: () => Promise<unknown>) {
    setBusy(id);
    setError("");
    try {
      await task();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function refresh() {
    await action("refresh", async () => {
      const results = await Promise.allSettled(
        connections
          .filter((c) => c.enabled)
          .map((c) =>
            api<PublicConnection>(`/connections/${c.id}/sync`, "POST"),
          ),
      );
      const failed = results.find(
        (r) => r.status === "rejected" || r.value.error,
      );
      if (failed?.status === "rejected") throw failed.reason;
      if (failed?.status === "fulfilled") throw new Error(failed.value.error!);
    });
  }
  if (authenticated === null)
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-8">
        <div
          className="flex w-64 flex-col gap-3"
          aria-label="Loading dashboard"
        >
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </div>
    );
  if (!authenticated)
    return (
      <Login
        error={error}
        onLogin={() => {
          setError("");
          setAuthenticated(true);
        }}
      />
    );

  const title = tabs.find((t) => t.id === tab)!.name;
  const openKey = () => setModal("key");

  return (
    <div className="flex min-h-svh flex-col">
      <Navigation
        tab={tab}
        onSettings={() => setModal("settings")}
        onExit={() => {
          void action("logout", async () => {
            await api("/session", "DELETE");
            setAuthenticated(false);
            setState(empty);
          });
        }}
      />
      <main className="min-w-0 flex-1">
        <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-7 px-4 py-6 sm:px-7 sm:py-8 lg:px-9">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="font-heading text-3xl font-bold tracking-tight">
              {title}
            </h1>
            <div className="flex items-center gap-2">
              {tab === "pool" && (
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void refresh()}
                >
                  {busy === "refresh" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Icon icon={Refresh01Icon} data-icon="inline-start" />
                  )}
                  Refresh
                </Button>
              )}
            </div>
          </header>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
              <AlertAction>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Dismiss error"
                  onClick={() => setError("")}
                >
                  <Icon icon={Cancel01Icon} />
                </Button>
              </AlertAction>
            </Alert>
          )}
          {tab === "pool" && (
            <UsageMetrics daily={state.daily} hourly={state.hourly} />
          )}
          {tab === "pool" &&
            (connected.length ? (
              <UsageOverview
                connections={connected}
                onReconnect={(c) => setAccountProvider(c.provider)}
                onReset={(account, creditId) =>
                  action(`reset:${account.id}`, async () => {
                    const { result } = await api<{ result: string }>(
                      `/accounts/${encodeURIComponent(account.id)}/reset`,
                      "POST",
                      { creditId, requestId: crypto.randomUUID() },
                    );
                    if (result === "nothing_to_reset" || result === "no_credit")
                      await reload();
                    if (result === "nothing_to_reset")
                      throw new Error("Nothing to reset for this account.");
                    if (result === "no_credit")
                      throw new Error(
                        "This banked reset is no longer available.",
                      );
                  })
                }
              />
            ) : (
              <Empty className="min-h-80 border">
                <EmptyHeader>
                  <EmptyTitle>No usage yet</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ))}
          {tab === "connections" && (
            <div className="flex min-w-0 flex-col gap-6">
              {[true, false].map((enabled) => {
                const entries = providerEntries.filter(
                  (p) => p.enabled === enabled,
                );
                if (!entries.length) return null;
                const group = enabled ? "Enabled" : "Disabled";
                return (
                  <section
                    key={group}
                    aria-label={`${group} providers`}
                    className="flex min-w-0 flex-col gap-3"
                  >
                    <h2 className="text-sm font-medium text-muted-foreground">
                      {group}
                    </h2>
                    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                      {entries.map(({ provider, connection: c }) => (
                        <Card
                          key={provider}
                          size="sm"
                          role="region"
                          aria-label={`${providerNames[provider]} connection`}
                        >
                          <CardHeader>
                            <CardTitle
                              className={cn(
                                "min-w-0",
                                !enabled && "opacity-50",
                              )}
                            >
                              <span className="flex items-center gap-3">
                                <ProviderIcon provider={provider} />
                                <span className="min-w-0 wrap-anywhere">
                                  <PrivateText>
                                    {c?.name || providerNames[provider]}
                                  </PrivateText>
                                </span>
                              </span>
                            </CardTitle>
                            {(c?.error ||
                              (c && !c.enabled && c.accounts.length > 0)) && (
                              <CardAction>
                                <Badge
                                  variant={
                                    c.error ? "destructive" : "secondary"
                                  }
                                >
                                  {c.error ? "Needs attention" : "Paused"}
                                </Badge>
                              </CardAction>
                            )}
                          </CardHeader>
                          <CardContent>
                            <div
                              className={cn(
                                "flex items-center gap-5 text-sm",
                                !enabled && "opacity-50",
                              )}
                            >
                              <span>
                                <strong className="font-medium">
                                  {c?.accounts.length ?? 0}
                                </strong>{" "}
                                <span className="text-muted-foreground">
                                  accounts
                                </span>
                              </span>
                              <span>
                                <strong className="font-medium">
                                  {c?.models.length ?? 0}
                                </strong>{" "}
                                <span className="text-muted-foreground">
                                  models
                                </span>
                              </span>
                            </div>
                            {c?.error && (
                              <div className="mt-4">
                                <ErrorMessage>{c.error}</ErrorMessage>
                              </div>
                            )}
                          </CardContent>
                          <CardFooter className="flex-wrap justify-between gap-3">
                            {c && c.accounts.length > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setDetails(c)}
                              >
                                URL & setup
                                <Icon
                                  icon={ArrowUpRight01Icon}
                                  data-icon="inline-end"
                                />
                              </Button>
                            )}
                            <div className="flex items-center gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setAccountProvider(provider)}
                              >
                                Add account
                              </Button>
                              {c && c.accounts.length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Refresh ${c.name}`}
                                  disabled={!!busy}
                                  onClick={() =>
                                    void action(c.id, () =>
                                      api(`/connections/${c.id}/sync`, "POST"),
                                    )
                                  }
                                >
                                  {busy === c.id ? (
                                    <Spinner />
                                  ) : (
                                    <Icon icon={Refresh01Icon} />
                                  )}
                                </Button>
                              )}
                              {c && c.accounts.length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`${c.enabled ? "Pause" : "Resume"} ${c.name}`}
                                  disabled={!!busy}
                                  onClick={() =>
                                    void action(c.id, () =>
                                      api(`/connections/${c.id}`, "PATCH", {
                                        enabled: !c.enabled,
                                      }),
                                    )
                                  }
                                >
                                  <Icon
                                    icon={c.enabled ? PauseIcon : PlayIcon}
                                  />
                                </Button>
                              )}
                              {c && c.accounts.length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Remove ${c.name}`}
                                  onClick={() =>
                                    setRemove({
                                      type: "connections",
                                      id: c.id,
                                      name: c.name,
                                    })
                                  }
                                >
                                  <Icon icon={Delete02Icon} />
                                </Button>
                              )}
                            </div>
                          </CardFooter>
                        </Card>
                      ))}
                    </div>
                  </section>
                );
              })}
              <section
                aria-label="Unsupported providers"
                className="flex min-w-0 flex-col gap-3"
              >
                <h2 className="text-sm font-medium text-muted-foreground">
                  Unsupported
                </h2>
                <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                  {unsupportedProviders.map(({ name, logo, darkLogo }) => (
                    <Card key={name} size="sm" aria-disabled="true">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-3 opacity-50">
                          <span
                            aria-hidden="true"
                            className="flex size-7 shrink-0 items-center justify-center"
                          >
                            {logo ? (
                              <>
                                <img
                                  src={`/providers/${logo}`}
                                  alt=""
                                  className={cn(
                                    "size-full object-contain",
                                    darkLogo && "dark:hidden",
                                    logo === "devin.svg" && "dark:invert",
                                  )}
                                />
                                {darkLogo && (
                                  <img
                                    src={`/providers/${darkLogo}`}
                                    alt=""
                                    className="hidden size-full object-contain dark:block"
                                  />
                                )}
                              </>
                            ) : (
                              <Icon icon={Link01Icon} size={24} />
                            )}
                          </span>
                          {name}
                        </CardTitle>
                      </CardHeader>
                    </Card>
                  ))}
                </div>
              </section>
            </div>
          )}
          {tab === "keys" &&
            (state.keys.length ? (
              <KeyManager
                keys={state.keys}
                connections={connections}
                busy={!!busy}
                onAdd={openKey}
                onSaved={reload}
                onToggle={(k) =>
                  void action(k.id, () =>
                    api(`/keys/${k.id}`, "PATCH", { enabled: !k.enabled }),
                  )
                }
                onArchive={(k) =>
                  setRemove({ type: "keys", id: k.id, name: k.name })
                }
                onRestore={(k) =>
                  void action(k.id, () =>
                    api(`/keys/${k.id}`, "PATCH", { archived: false }),
                  )
                }
              />
            ) : (
              <Empty className="min-h-80 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Icon icon={Key01Icon} />
                  </EmptyMedia>
                  <EmptyTitle>No shared keys yet</EmptyTitle>
                  <EmptyDescription>
                    Create a key, choose its account access, and use it on your
                    devices.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={openKey}>
                    Add your first key
                    <Icon icon={Add01Icon} data-icon="inline-end" />
                  </Button>
                </EmptyContent>
              </Empty>
            ))}
          {tab === "activity" && (
            <ActivityLog
              connections={connections}
              keys={state.keys}
              refreshId={state.requests[0]?.id}
            />
          )}
          {tab === "keys" && state.keys.length > 0 && (
            <KeyUsageSummary keys={state.keys} usage={state.keyUsage} />
          )}
        </div>
      </main>
      {modal === "settings" && (
        <DashboardSettings
          settings={state.settings}
          origin={origin}
          onSaved={reload}
          onClose={() => setModal(null)}
        />
      )}
      {accountProvider && (
        <ConnectionForm
          provider={accountProvider}
          connection={connections.find((c) => c.provider === accountProvider)}
          onClose={() => setAccountProvider(null)}
          onSaved={reload}
        />
      )}
      {modal === "key" && (
        <KeyForm
          connections={connections}
          onClose={() => setModal(null)}
          onSaved={reload}
        />
      )}
      {details && (
        <ConnectionDetails
          connection={details}
          origin={origin}
          onClose={() => setDetails(null)}
        />
      )}
      {remove && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setRemove(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {remove.type === "keys" ? "Archive key?" : "Remove connection?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                <PrivateText>{remove.name}</PrivateText>.{" "}
                {remove.type === "keys"
                  ? "Access stops. Usage history is kept."
                  : "Clients using this URL will stop working. Upstream accounts stay in their original service."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={!!busy}
                onClick={() =>
                  void action("remove", async () => {
                    await api(`/${remove.type}/${remove.id}`, "DELETE");
                    setRemove(null);
                  })
                }
              >
                {busy === "remove" && <Spinner data-icon="inline-start" />}
                {remove.type === "keys" ? "Archive key" : "Remove connection"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function Navigation({
  tab,
  onExit,
  onSettings,
}: {
  tab: Tab;
  onExit: () => void;
  onSettings: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1500px] items-start justify-between gap-3 px-4 py-3 sm:items-center sm:px-7 lg:px-9">
        <nav
          aria-label="Main navigation"
          className="grid min-w-0 grid-cols-2 gap-1 sm:flex sm:flex-wrap"
        >
          {tabs.map((t) => (
            <Link
              key={t.id}
              to={t.path}
              className={cn(
                buttonVariants({
                  variant: tab === t.id ? "secondary" : "ghost",
                  size: "sm",
                }),
                "justify-start sm:justify-center",
              )}
              aria-current={tab === t.id ? "page" : undefined}
            >
              <Icon
                icon={t.icon}
                data-icon="inline-start"
                className="hidden sm:block"
              />
              {t.name}
            </Link>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Settings"
            onClick={onSettings}
          >
            <Icon icon={Settings01Icon} />
          </Button>
          <PrivacyButton />
          <ThemeSwitch />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Lock dashboard"
            title="Lock dashboard"
            onClick={onExit}
          >
            <Icon icon={Logout01Icon} />
          </Button>
        </div>
      </div>
    </header>
  );
}

function ThemeSwitch() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("ai-funnel-theme");
    return saved
      ? saved === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(style);
    document.documentElement.classList.toggle("dark", dark);
    void document.body.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
  }, [dark]);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        setDark(!dark);
        localStorage.setItem("ai-funnel-theme", dark ? "light" : "dark");
      }}
    >
      <Icon icon={dark ? Sun01Icon : Moon01Icon} />
    </Button>
  );
}

function Login({
  onLogin,
  error: initialError,
}: {
  onLogin: () => void;
  error: string;
}) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/session", "POST", { token: data.get("token") });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-svh flex-col bg-sidebar">
      <header className="flex justify-end px-6 py-5">
        <ThemeSwitch />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Open your dashboard</CardTitle>
            <CardDescription>
              Manage your accounts and provider connections.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit}>
              <FieldGroup>
                <Field data-invalid={!!error}>
                  <FieldLabel htmlFor="dashboard-key">Dashboard key</FieldLabel>
                  <Input
                    id="dashboard-key"
                    name="token"
                    type="password"
                    required
                    autoComplete="current-password"
                    autoFocus
                    aria-invalid={!!error}
                  />
                  <FieldDescription>
                    Your key is saved in the server's{" "}
                    <code>data/admin-token</code> file.
                  </FieldDescription>
                </Field>
                {error && <ErrorMessage>{error}</ErrorMessage>}
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Icon icon={Key01Icon} data-icon="inline-start" />
                  )}
                  Unlock dashboard
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
