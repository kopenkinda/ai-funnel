import { useEffect, useState, type FormEvent } from "react";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  Activity01Icon,
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
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
} from "@hugeicons/core-free-icons";
import type { PublicConnection, PublicKey } from "../server/types.ts";
import { api, relative, type State } from "./api.ts";
import { ErrorMessage, ProviderIcon } from "./ui.tsx";
import { UsageOverview } from "./usage.tsx";
import { ConnectionDetails, ConnectionForm, KeyForm } from "./forms.tsx";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  { id: "pool", name: "Usage", icon: Layers01Icon },
  { id: "connections", name: "Connections", icon: Link01Icon },
  { id: "keys", name: "API keys", icon: Key01Icon },
  { id: "activity", name: "Activity", icon: Activity01Icon },
] as const;
type Tab = (typeof tabs)[number]["id"];
const empty: State = { connections: [], keys: [], requests: [], publicUrl: "" };

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [state, setState] = useState<State>(empty);
  const [tab, setTab] = useState<Tab>("pool");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [modal, setModal] = useState<"connect" | "key" | null>(null);
  const [details, setDetails] = useState<PublicConnection | null>(null);
  const [reconnect, setReconnect] = useState<PublicConnection | null>(null);
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
  const openConnect = () => setModal("connect");
  const openKey = () => setModal("key");

  return (
    <div className="flex min-h-svh flex-col">
      <Navigation
        tab={tab}
        onTab={setTab}
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
              {tab !== "activity" && (
                <Button onClick={tab === "keys" ? openKey : openConnect}>
                  <Icon icon={Add01Icon} data-icon="inline-start" />
                  {tab === "keys" ? "Add shared key" : "Connect provider"}
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
          {tab === "pool" &&
            (connections.length ? (
              <UsageOverview
                connections={connections}
                onReconnect={setReconnect}
              />
            ) : (
              <EmptyPool onConnect={openConnect} />
            ))}
          {tab === "connections" &&
            (connections.length ? (
              <div className="grid min-w-0 gap-5 xl:grid-cols-2">
                {connections.map((c) => (
                  <Card key={c.id} size="sm">
                    <CardHeader>
                      <CardTitle className="min-w-0">
                        <span className="flex items-center gap-3">
                          <ProviderIcon provider={c.provider} />
                          <span className="min-w-0 wrap-anywhere">
                            {c.name}
                          </span>
                        </span>
                      </CardTitle>
                      <CardDescription className="mt-2 break-all">
                        {c.url}
                      </CardDescription>
                      <CardAction>
                        <Badge variant={c.error ? "destructive" : "secondary"}>
                          {!c.enabled
                            ? "Paused"
                            : c.error
                              ? "Needs attention"
                              : "Connected"}
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-5 text-sm">
                        <span>
                          <strong className="font-medium">
                            {c.accounts.length}
                          </strong>{" "}
                          <span className="text-muted-foreground">
                            accounts
                          </span>
                        </span>
                        <span>
                          <strong className="font-medium">
                            {c.models.length}
                          </strong>{" "}
                          <span className="text-muted-foreground">models</span>
                        </span>
                      </div>
                      {c.error && (
                        <div className="mt-4">
                          <ErrorMessage>{c.error}</ErrorMessage>
                          {c.provider === "codex" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-3"
                              onClick={() => setReconnect(c)}
                            >
                              Reconnect codex-lb
                            </Button>
                          )}
                        </div>
                      )}
                    </CardContent>
                    <CardFooter className="flex-wrap justify-between gap-3">
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
                      <div className="flex items-center gap-1">
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
                          <Icon icon={c.enabled ? PauseIcon : PlayIcon} />
                        </Button>
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
                      </div>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyPool onConnect={openConnect} />
            ))}
          {tab === "keys" &&
            (state.keys.length ? (
              <div className="flex flex-col gap-5">
                {state.keys.map((k) => (
                  <KeyRow
                    key={k.id}
                    clientKey={k}
                    connections={connections}
                    busy={!!busy}
                    onToggle={() =>
                      void action(k.id, () =>
                        api(`/keys/${k.id}`, "PATCH", { enabled: !k.enabled }),
                      )
                    }
                    onRemove={() =>
                      setRemove({ type: "keys", id: k.id, name: k.name })
                    }
                  />
                ))}
              </div>
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
            <section className="min-w-0 overflow-hidden rounded-2xl border">
              {state.requests.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Connection / model</TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Duration</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.requests.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <span title={new Date(r.at).toLocaleString()}>
                            {relative(r.at)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <p>
                            {connections.find((c) => c.id === r.connectionId)
                              ?.name || "Removed connection"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {r.model || "Model discovery"}
                          </p>
                        </TableCell>
                        <TableCell>
                          {state.keys.find((k) => k.id === r.keyId)?.name ||
                            "Removed key"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              r.status >= 400 ? "destructive" : "secondary"
                            }
                          >
                            {r.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {r.durationMs < 1000
                            ? `${r.durationMs} ms`
                            : `${(r.durationMs / 1000).toFixed(1)} s`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty className="min-h-80">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Icon icon={Activity01Icon} />
                    </EmptyMedia>
                    <EmptyTitle>No requests yet</EmptyTitle>
                    <EmptyDescription>
                      Requests made with your shared keys will appear here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              <div className="border-t px-4 py-3 text-xs text-muted-foreground">
                Only request metadata is stored. Prompt and response content is
                never logged.
              </div>
            </section>
          )}
        </div>
      </main>
      {modal === "connect" && (
        <ConnectionForm onClose={() => setModal(null)} onSaved={reload} />
      )}
      {reconnect && (
        <ConnectionForm
          reconnect={reconnect}
          onClose={() => setReconnect(null)}
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
                Remove {remove.type === "keys" ? "shared key" : "connection"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {remove.name}.{" "}
                {remove.type === "keys"
                  ? "This key will stop working through ai-funnel. Keys used directly with codex-lb stay unchanged."
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
                Remove {remove.type === "keys" ? "key" : "connection"}
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
  onTab,
  onExit,
}: {
  tab: Tab;
  onTab: (value: Tab) => void;
  onExit: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1500px] items-start justify-between gap-3 px-4 py-3 sm:items-center sm:px-7 lg:px-9">
        <nav
          aria-label="Main navigation"
          className="grid min-w-0 grid-cols-2 gap-1 sm:flex sm:flex-wrap"
        >
          {tabs.map((t) => (
            <Button
              key={t.id}
              variant={tab === t.id ? "secondary" : "ghost"}
              size="sm"
              className="justify-start sm:justify-center"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => onTab(t.id)}
            >
              <Icon
                icon={t.icon}
                data-icon="inline-start"
                className="hidden sm:block"
              />
              {t.name}
            </Button>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
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

function EmptyPool({ onConnect }: { onConnect: () => void }) {
  return (
    <Empty className="min-h-96 border">
      <EmptyHeader>
        <EmptyMedia>
          <div className="flex items-center gap-2">
            <ProviderIcon provider="codex" />
            <ProviderIcon provider="claude" />
            <ProviderIcon provider="go" />
          </div>
        </EmptyMedia>
        <EmptyTitle>Bring your accounts together.</EmptyTitle>
        <EmptyDescription>
          Connect your Codex pool, Claude subscriptions, or OpenCode credentials
          to see their accounts and limits.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onConnect}>
          <Icon icon={Add01Icon} data-icon="inline-start" />
          Connect your first provider
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function KeyRow({
  clientKey: k,
  connections,
  busy,
  onToggle,
  onRemove,
}: {
  clientKey: PublicKey;
  connections: PublicConnection[];
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const expired = !!k.expiresAt && Date.parse(k.expiresAt) < Date.now();
  return (
    <Card size="sm" aria-label={`Key ${k.name}`}>
      <CardHeader>
        <CardTitle className="min-w-0 wrap-anywhere">{k.name}</CardTitle>
        <CardDescription>
          <code>{k.prefix}••••••••</code>
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Badge variant={expired || !k.enabled ? "secondary" : "outline"}>
              {expired ? "Expired" : k.enabled ? "Active" : "Paused"}
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label={`${k.enabled ? "Pause" : "Resume"} ${k.name}`}
              onClick={onToggle}
            >
              <Icon icon={k.enabled ? PauseIcon : PlayIcon} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${k.name}`}
              onClick={onRemove}
            >
              <Icon icon={Delete02Icon} />
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {k.grants.map((g) => {
              const c = connections.find((c) => c.id === g.connectionId);
              return (
                <Badge key={g.connectionId} variant="secondary">
                  {c?.name || "Removed connection"}
                </Badge>
              );
            })}
          </div>
          <p className="text-sm tabular-nums">
            {k.requestsToday}
            {k.dailyLimit ? ` / ${k.dailyLimit}` : ""}{" "}
            <span className="text-muted-foreground">requests today</span>
          </p>
        </div>
      </CardContent>
      <CardFooter className="block">
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Last used {k.lastUsedAt ? relative(k.lastUsedAt) : "never"}
              {k.expiresAt
                ? ` · Expires ${new Date(k.expiresAt).toLocaleDateString()}`
                : " · No expiration"}
            </p>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              {expanded ? "Hide access" : "View access"}
              <Icon
                icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
                data-icon="inline-end"
              />
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div
              className="flex flex-col gap-4 pt-4"
              aria-label={`Access for ${k.name}`}
            >
              <Separator />
              {k.grants.map((g) => {
                const c = connections.find((c) => c.id === g.connectionId);
                return (
                  <div key={g.connectionId} className="flex flex-col gap-1">
                    <p className="text-sm font-medium">
                      {c?.name || "Removed connection"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {g.accountIds
                        ? g.accountIds
                            .map(
                              (id) =>
                                c?.accounts.find((a) => a.id === id)?.name ||
                                "Missing account",
                            )
                            .join(", ")
                        : k.imported && c?.provider === "codex"
                          ? "Account access inherited from codex-lb"
                          : "Whole connection pool"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {g.models
                        ? `Models: ${g.models.join(", ")}`
                        : "All permitted upstream models"}
                    </p>
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardFooter>
    </Card>
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
