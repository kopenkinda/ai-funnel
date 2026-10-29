import { useState } from "react";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  Add01Icon,
  Archive01Icon,
  ArchiveRestoreIcon,
  Key01Icon,
} from "@hugeicons/core-free-icons";
import type { PublicConnection, PublicKey, UsageTotals } from "./types";
import { providerNames } from "./types";
import { relative } from "./api";
import { KeyForm } from "./forms";
import { PrivateText } from "./privacy";
import { ProviderIcon } from "./ui";
import { compact, costLabel, money } from "./metrics";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

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
  busy,
  onAdd,
  onSaved,
  onToggle,
  onArchive,
  onRestore,
}: {
  keys: PublicKey[];
  connections: PublicConnection[];
  busy: boolean;
  onAdd: () => void;
  onSaved: () => Promise<void>;
  onToggle: (key: PublicKey) => void;
  onArchive: (key: PublicKey) => void;
  onRestore: (key: PublicKey) => void;
}) {
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
                    ? new Date(selected.lastUsedAt).toLocaleString()
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
        return (
          <Card key={kind} size="sm" role="region" aria-label={title}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex min-w-0 flex-col gap-4">
                {[...entries]
                  .sort((a, b) => b[kind] - a[kind])
                  .map((entry) => {
                    const share = total > 0 ? (entry[kind] / total) * 100 : 0;
                    const percentage = `${approximate && share > 0 ? "≈" : ""}${share.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
                    const value =
                      kind === "cost"
                        ? costText(entry.totals)
                        : compact(entry.tokens);
                    return (
                      <li
                        key={entry.key.id}
                        className="flex min-w-0 flex-col gap-2"
                      >
                        <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
                          <span className="flex min-w-0 items-center gap-2 font-medium">
                            <span className="truncate">
                              <PrivateText>{entry.key.name}</PrivateText>
                            </span>
                            {entry.key.archivedAt && (
                              <Badge variant="secondary">Archived</Badge>
                            )}
                          </span>
                          <span
                            className="shrink-0 text-muted-foreground tabular-nums"
                            title={
                              kind === "tokens"
                                ? entry.tokens.toLocaleString()
                                : entry.totals?.unpriced
                                  ? `${entry.totals.unpriced} unpriced requests`
                                  : "Estimated API equivalent · USD"
                            }
                          >
                            {value}
                            {value !== "Unpriced" && ` · ${percentage}`}
                          </span>
                        </div>
                        <Progress
                          value={share}
                          aria-label={`${entry.key.name} ${kind} share`}
                          aria-valuetext={
                            value === "Unpriced"
                              ? value
                              : `${value} · ${percentage}`
                          }
                          className="[&_[data-slot=progress-track]]:h-1.5"
                        />
                      </li>
                    );
                  })}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}
