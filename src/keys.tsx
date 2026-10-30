import { useEffect, useState, type ReactNode } from "react";
import { useHourCycle } from "./preferences.ts";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  Add01Icon,
  Archive01Icon,
  ArchiveRestoreIcon,
  ArrowRight01Icon,
  Key01Icon,
} from "@hugeicons/core-free-icons";
import type { PublicConnection, PublicKey, UsageTotals } from "./types";
import { providerNames } from "./types";
import { api, relative } from "./api";
import { KeyForm } from "./forms";
import { PrivateText } from "./privacy";
import { CopyButton, ErrorMessage, ProviderIcon } from "./ui";
import { compact, costLabel, money } from "./metrics";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const status = (key: PublicKey) =>
  key.archivedAt
    ? "Archived"
    : key.expiresAt && Date.parse(key.expiresAt) <= Date.now()
      ? "Expired"
      : key.enabled
        ? "Active"
        : "Paused";

export function KeyManager({
  keys,
  connections,
  origin,
  busy,
  onAdd,
  onSaved,
  onToggle,
  onArchive,
  onRestore,
}: {
  keys: PublicKey[];
  connections: PublicConnection[];
  origin: string;
  busy: boolean;
  onAdd: () => void;
  onSaved: () => Promise<void>;
  onToggle: (key: PublicKey) => void;
  onArchive: (key: PublicKey) => void;
  onRestore: (key: PublicKey) => void;
}) {
  const hourCycle = useHourCycle();
  const [view, setView] = useState("current");
  const [selectedId, setSelectedId] = useState(keys[0]?.id);
  const [revision, setRevision] = useState(0);
  const visible = keys.filter(
    (key) => !!key.archivedAt === (view === "archived"),
  );
  const selected = visible.find((key) => key.id === selectedId) ?? visible[0];
  const archivedCount = keys.filter((key) => key.archivedAt).length;
  return (
    <section
      aria-label="API key management"
      className="grid min-w-0 overflow-hidden rounded-2xl border md:h-[calc(100svh-12rem)] md:min-h-[36rem] md:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)]"
    >
      <aside
        aria-label="API key list"
        className="flex min-w-0 flex-col border-b bg-muted/15 md:min-h-0 md:border-r md:border-b-0"
      >
        <div className="border-b p-3">
          <ToggleGroup
            value={[view]}
            onValueChange={(value) => {
              if (value[0]) setView(value[0]);
            }}
            size="sm"
            spacing={0}
            className="w-full"
            aria-label="Key status"
          >
            <ToggleGroupItem value="current" className="flex-1">
              Current
            </ToggleGroupItem>
            <ToggleGroupItem value="archived" className="flex-1">
              Archived{archivedCount > 0 && ` (${archivedCount})`}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex max-h-64 flex-col overflow-y-auto overscroll-contain md:max-h-none md:flex-1">
          {visible.map((key) => {
            const active = key.id === selected?.id;
            return (
              <div
                key={key.id}
                className={cn(
                  "flex shrink-0 items-center gap-3 border-b pr-5",
                  active && "bg-muted/70",
                )}
              >
                <button
                  type="button"
                  aria-label={`Select ${key.name}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => setSelectedId(key.id)}
                  className="flex min-w-0 flex-1 flex-col gap-2 px-5 py-4 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="w-full truncate text-sm font-medium">
                    <PrivateText>{key.name}</PrivateText>
                  </span>
                  <span className="flex w-full flex-wrap items-center gap-1.5">
                    {key.grants.map((grant) => {
                      const connection = connections.find(
                        (c) => c.id === grant.connectionId,
                      );
                      if (!connection) return null;
                      const all = grant.accountIds === null;
                      const count = connection.accounts.filter((account) =>
                        grant.accountIds?.includes(account.id),
                      ).length;
                      const label = `${providerNames[connection.provider]}: ${all ? "All accounts" : `${count} of ${connection.accounts.length} accounts`}`;
                      return (
                        <Badge
                          key={connection.id}
                          variant="outline"
                          className="h-6 gap-1.5 px-2 [&>[aria-hidden]]:size-3.5"
                          aria-label={label}
                          title={label}
                        >
                          <ProviderIcon provider={connection.provider} small />
                          <span className="tabular-nums">
                            {all ? "*" : count}
                          </span>
                        </Badge>
                      );
                    })}
                  </span>
                </button>
                {!key.archivedAt && (
                  <Switch
                    checked={key.enabled}
                    disabled={busy}
                    size="sm"
                    aria-label={`${key.enabled ? "Pause" : "Resume"} ${key.name}`}
                    onCheckedChange={() => onToggle(key)}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="p-3">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={onAdd}
          >
            <Icon icon={Add01Icon} data-icon="inline-start" />
            Add key
          </Button>
        </div>
      </aside>
      {selected ? (
        <div className="flex min-w-0 flex-col overflow-y-auto overscroll-contain">
          <header className="flex items-start justify-between gap-4 px-5 py-5 sm:px-7 sm:py-6">
            <div className="flex min-w-0 items-start gap-3">
              <Icon
                icon={Key01Icon}
                size={22}
                className="mt-1 shrink-0 text-muted-foreground"
              />
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="font-heading text-xl font-semibold wrap-anywhere">
                    <PrivateText>{selected.name}</PrivateText>
                  </h2>
                  <Badge
                    variant={
                      status(selected) === "Active" ? "outline" : "secondary"
                    }
                  >
                    {status(selected)}
                  </Badge>
                </div>
                <code className="text-xs text-muted-foreground">
                  {selected.prefix}••••••••
                </code>
              </div>
            </div>
            <Button
              variant="ghost"
              size={selected.archivedAt ? "sm" : "icon-sm"}
              aria-label={`${selected.archivedAt ? "Restore" : "Archive"} ${selected.name}`}
              disabled={busy}
              onClick={() =>
                selected.archivedAt ? onRestore(selected) : onArchive(selected)
              }
            >
              <Icon
                icon={selected.archivedAt ? ArchiveRestoreIcon : Archive01Icon}
                data-icon={selected.archivedAt ? "inline-start" : undefined}
              />
              {selected.archivedAt && "Restore"}
            </Button>
          </header>
          <dl
            aria-label={`Usage for ${selected.name}`}
            className="grid grid-cols-3 gap-3 px-5 pb-6 sm:gap-6 sm:px-7"
          >
            <div className="flex min-w-0 flex-col gap-2">
              <dt className="text-xs text-muted-foreground">Requests today</dt>
              <dd className="text-xl font-medium tabular-nums">
                {selected.requestsToday.toLocaleString()}
                {selected.dailyLimit && (
                  <span className="text-sm text-muted-foreground">
                    {" "}
                    / {selected.dailyLimit.toLocaleString()}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <dt className="text-xs text-muted-foreground">Last used</dt>
              <dd
                className="text-sm font-medium"
                title={
                  selected.lastUsedAt
                    ? new Date(selected.lastUsedAt).toLocaleString(undefined, {
                        hourCycle,
                      })
                    : undefined
                }
              >
                {selected.lastUsedAt ? relative(selected.lastUsedAt) : "Never"}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <dt className="text-xs text-muted-foreground">Created</dt>
              <dd className="text-sm font-medium">
                {date(selected.createdAt)}
              </dd>
            </div>
          </dl>
          <Separator />
          <div className="flex flex-1 flex-col px-5 pt-6 sm:px-7">
            <KeyForm
              key={`${selected.id}:${revision}`}
              clientKey={selected}
              connections={connections}
              inline
              onClose={() => setRevision((value) => value + 1)}
              onSaved={onSaved}
            />
          </div>
          {!selected.archivedAt && (
            <KeyHubAccess
              key={selected.id}
              clientKey={selected}
              origin={origin}
              onSaved={onSaved}
            />
          )}
        </div>
      ) : (
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyTitle>
              {view === "archived" ? "No archived keys" : "No current keys"}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}

type HubSetting = "hubResets" | "hubEmails";
const hubSettings: { id: HubSetting; label: string; description: string }[] = [
  {
    id: "hubEmails",
    label: "Show account emails",
    description:
      "Off: accounts appear as Codex account 1a2b3c and similar labels.",
  },
  {
    id: "hubResets",
    label: "Allow reset redemption",
    description:
      "Lets the hub redeem banked Codex resets while this key and its connection are active.",
  },
];

function KeyHubAccess({
  clientKey,
  origin,
  onSaved,
}: {
  clientKey: PublicKey;
  origin: string;
  onSaved: () => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Mirror saved values locally so a failed refresh can't show a stale setting.
  const [hasKey, setHasKey] = useState(clientKey.hasHubKey ?? false);
  const [saved, setSaved] = useState({
    hubResets: clientKey.hubResets ?? false,
    hubEmails: clientKey.hubEmails ?? false,
  });
  useEffect(
    () => setHasKey(clientKey.hasHubKey ?? false),
    [clientKey.hasHubKey],
  );
  useEffect(
    () =>
      setSaved({
        hubResets: clientKey.hubResets ?? false,
        hubEmails: clientKey.hubEmails ?? false,
      }),
    [clientKey.hubResets, clientKey.hubEmails],
  );
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const path = `/keys/${clientKey.id}/hub-token`;
  const expired =
    !!clientKey.expiresAt && Date.parse(clientKey.expiresAt) <= Date.now();
  return (
    <section
      aria-label="Usage hub"
      className="flex flex-col gap-4 border-t px-5 py-6 sm:px-7"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Usage hub</h3>
        <p className="text-sm text-muted-foreground">
          A management key for a CLIProxyAPI usage hub, such as T3 Code. It
          shows cached quota for the accounts assigned to this key and can't
          send requests. Usage stays visible while the key is paused.
        </p>
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor={`hub-url-${clientKey.id}`}>Hub URL</FieldLabel>
        <div className="flex gap-2">
          <Input id={`hub-url-${clientKey.id}`} readOnly value={origin} />
          <CopyButton value={origin} onError={setError} />
        </div>
      </div>
      {token && (
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor={`hub-key-${clientKey.id}`}>
            Management key
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id={`hub-key-${clientKey.id}`}
              readOnly
              type="password"
              value={token}
            />
            <CopyButton value={token} onError={setError} />
          </div>
          <FieldDescription>
            Copy the key now. It isn't shown again.
          </FieldDescription>
        </div>
      )}
      {expired && (
        <FieldDescription>
          This key has expired. Extend its expiration to use a hub key.
        </FieldDescription>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || expired}
          onClick={() =>
            void run(async () => {
              setToken((await api<{ token: string }>(path, "POST")).token);
              setHasKey(true);
            })
          }
        >
          {hasKey ? "Replace hub key" : "Generate hub key"}
        </Button>
        {hasKey && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(path, "DELETE");
                setToken("");
                setHasKey(false);
              })
            }
          >
            Revoke
          </Button>
        )}
      </div>
      {hubSettings.map((setting) => (
        <div
          key={setting.id}
          className="flex items-start justify-between gap-4"
        >
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor={`${setting.id}-${clientKey.id}`}>
              {setting.label}
            </FieldLabel>
            <FieldDescription>{setting.description}</FieldDescription>
          </div>
          <Switch
            id={`${setting.id}-${clientKey.id}`}
            checked={saved[setting.id]}
            disabled={busy}
            onCheckedChange={(checked) =>
              void run(async () => {
                const key = await api<PublicKey>(
                  `/keys/${clientKey.id}`,
                  "PATCH",
                  { [setting.id]: checked },
                );
                setSaved((prev) => ({
                  ...prev,
                  [setting.id]: key[setting.id] ?? false,
                }));
              })
            }
          />
        </div>
      ))}
    </section>
  );
}

export function KeyUsageSummary({
  keys,
  usage = {},
}: {
  keys: PublicKey[];
  usage?: Record<string, UsageTotals>;
}) {
  const entries = keys.map((key) => {
    const totals = usage[key.id];
    return {
      key,
      totals,
      tokens: totals?.tokens.total ?? 0,
      cost: totals ? (totals.cost.min + totals.cost.max) / 2 : 0,
    };
  });
  const costText = (totals?: UsageTotals) => {
    if (!totals) return money(0);
    if (totals.unpriced && totals.unpriced === totals.requests)
      return "Unpriced";
    return `${costLabel({ ...totals.cost, priced: true })}${totals.unpriced ? " +" : ""}`;
  };
  return (
    <section
      aria-label="Lifetime API key usage"
      className="grid min-w-0 gap-4 lg:grid-cols-2"
    >
      {(["cost", "tokens"] as const).map((kind) => {
        const total = entries.reduce((sum, entry) => sum + entry[kind], 0);
        const approximate =
          kind === "cost" &&
          entries.some(
            ({ totals }) =>
              totals &&
              (totals.cost.max - totals.cost.min > 0.00001 ||
                totals.unpriced > 0),
          );
        const title =
          kind === "cost"
            ? "Lifetime cost by API key"
            : "Lifetime tokens by API key";
        const percent = (value: number) => {
          const share = total > 0 ? (value / total) * 100 : 0;
          return {
            share,
            text: `${approximate && share > 0 ? "≈" : ""}${share.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
          };
        };
        const row = (
          name: ReactNode,
          label: string,
          amount: number,
          value: string,
          title: string,
        ) => {
          const { share, text } = percent(amount);
          return (
            <>
              <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  {name}
                </span>
                <span
                  className="shrink-0 text-muted-foreground tabular-nums"
                  title={title}
                >
                  {value}
                  {value !== "Unpriced" && ` · ${text}`}
                </span>
              </div>
              <Progress
                value={share}
                aria-label={`${label} ${kind} share`}
                aria-valuetext={
                  value === "Unpriced" ? value : `${value} · ${text}`
                }
                className="[&_[data-slot=progress-track]]:h-1.5"
              />
            </>
          );
        };
        const item = (entry: (typeof entries)[number]) => (
          <li key={entry.key.id} className="flex min-w-0 flex-col gap-2">
            {row(
              <span className="truncate">
                <PrivateText>{entry.key.name}</PrivateText>
              </span>,
              entry.key.name,
              entry[kind],
              kind === "cost" ? costText(entry.totals) : compact(entry.tokens),
              kind === "tokens"
                ? entry.tokens.toLocaleString()
                : entry.totals?.unpriced
                  ? `${entry.totals.unpriced} unpriced requests`
                  : "Estimated API equivalent · USD",
            )}
          </li>
        );
        const sorted = [...entries].sort((a, b) => b[kind] - a[kind]);
        const archived = sorted.filter((entry) => entry.key.archivedAt);
        const archivedTotals = archived.reduce<UsageTotals | undefined>(
          (sum, { totals }) =>
            !totals
              ? sum
              : !sum
                ? totals
                : {
                    tokens: {
                      ...sum.tokens,
                      total: sum.tokens.total + totals.tokens.total,
                    },
                    cost: {
                      ...sum.cost,
                      min: sum.cost.min + totals.cost.min,
                      max: sum.cost.max + totals.cost.max,
                    },
                    requests: sum.requests + totals.requests,
                    unpriced: sum.unpriced + totals.unpriced,
                  },
          undefined,
        );
        return (
          <Card key={kind} size="sm" role="region" aria-label={title}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              <ul className="flex min-w-0 flex-col gap-4">
                {sorted.filter((entry) => !entry.key.archivedAt).map(item)}
              </ul>
              {archived.length > 0 && (
                <Collapsible className="group/archived flex min-w-0 flex-col gap-4 border-t pt-4">
                  <CollapsibleTrigger className="-mx-2 flex min-w-0 flex-col gap-2 rounded-xl px-2 py-1 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
                    {row(
                      <>
                        <Icon
                          icon={ArrowRight01Icon}
                          size={14}
                          className="shrink-0 text-muted-foreground transition-transform group-data-open/archived:rotate-90"
                        />
                        <span className="text-muted-foreground">
                          Archived keys
                        </span>
                        <Badge variant="secondary">{archived.length}</Badge>
                      </>,
                      "Archived keys",
                      archived.reduce((sum, entry) => sum + entry[kind], 0),
                      kind === "cost"
                        ? costText(archivedTotals)
                        : compact(archivedTotals?.tokens.total ?? 0),
                      "Combined usage of archived keys",
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="flex min-w-0 flex-col gap-4">
                      {archived.map(item)}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}
