import { useState } from "react";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon, Key01Icon } from "@hugeicons/core-free-icons";
import type { PublicConnection, PublicKey } from "./types";
import { providerNames } from "./types";
import { relative } from "./api";
import { KeyForm } from "./forms";
import { PrivateText } from "./privacy";
import { ProviderIcon } from "./ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const status = (key: PublicKey) =>
  key.expiresAt && Date.parse(key.expiresAt) <= Date.now()
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
  onRemove,
}: {
  keys: PublicKey[];
  connections: PublicConnection[];
  busy: boolean;
  onAdd: () => void;
  onSaved: () => Promise<void>;
  onToggle: (key: PublicKey) => void;
  onRemove: (key: PublicKey) => void;
}) {
  const [selectedId, setSelectedId] = useState(keys[0]?.id);
  const [revision, setRevision] = useState(0);
  const selected = keys.find((key) => key.id === selectedId) ?? keys[0];
  if (!selected) return null;
  return (
    <section
      aria-label="API key management"
      className="grid min-w-0 overflow-hidden rounded-2xl border md:h-[calc(100svh-12rem)] md:min-h-[36rem] md:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)]"
    >
      <aside
        aria-label="API key list"
        className="flex min-w-0 flex-col border-b bg-muted/15 md:min-h-0 md:border-r md:border-b-0"
      >
        <div className="flex max-h-64 flex-col overflow-y-auto overscroll-contain md:max-h-none md:flex-1">
          {keys.map((key) => {
            const active = key.id === selected.id;
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
                <Switch
                  checked={key.enabled}
                  disabled={busy}
                  size="sm"
                  aria-label={`${key.enabled ? "Pause" : "Resume"} ${key.name}`}
                  onCheckedChange={() => onToggle(key)}
                />
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
            size="icon-sm"
            aria-label={`Remove ${selected.name}`}
            disabled={busy}
            onClick={() => onRemove(selected)}
          >
            <Icon icon={Delete02Icon} />
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
            <dd className="text-sm font-medium">{date(selected.createdAt)}</dd>
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
    </section>
  );
}
