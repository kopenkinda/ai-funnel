import { useState } from "react";
import { useHourCycle } from "./preferences.ts";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import {
  CreditCardIcon,
  MoneyNotFound04Icon,
  MultiplicationSignIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import {
  providerNames,
  type Account,
  type Provider,
  type PublicConnection,
  type Quota,
} from "./types.ts";
import { timeUntil } from "./api.ts";
import { PrivateText, usePrivacy } from "./privacy.tsx";
import { cn, compareQuotaLabels } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const sentenceCase = (text: string) =>
  text.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

export function AccountsTable({
  connections,
  onReset,
}: {
  connections: PublicConnection[];
  onReset: (account: Account, creditId: string) => Promise<void>;
}) {
  const privacy = usePrivacy((state) => state.enabled);
  const rows = connections.flatMap((connection) =>
    connection.accounts
      .filter((account) => account.quotas.some((q) => q.remaining !== null))
      .map((account) => ({ account, connection })),
  );
  if (!rows.length) return null;

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border">
      <Table
        aria-label={`${providerNames[connections[0]!.provider]} accounts`}
        className="min-w-[600px]"
      >
        <TableHeader>
          <TableRow className="[&>th]:h-9">
            <TableHead className="w-[45%]">Account</TableHead>
            <TableHead>Quota</TableHead>
            <TableHead className="pr-4 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ account, connection }) => (
            <TableRow
              key={`${connection.id}/${account.id}`}
              data-account-row
              className="[&>td]:py-2"
            >
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="font-medium"
                      title={privacy ? undefined : account.name}
                    >
                      <PrivateText>{account.email || account.name}</PrivateText>
                    </span>
                    <PlanBadge
                      plan={account.planTier || account.plan}
                      provider={connection.provider}
                    />
                  </div>
                  <AccountStatus account={account} connection={connection} />
                </div>
              </TableCell>
              <TableCell>
                <div className="grid grid-cols-[4.5rem_minmax(4rem,1fr)_2.75rem_4.5rem] items-center gap-x-3 gap-y-2">
                  {account.quotas
                    .filter((q) => q.remaining !== null)
                    .sort((a, b) => compareQuotaLabels(a.label, b.label))
                    .map((quota, index) => (
                      <QuotaRow
                        key={`${quota.label}/${index}`}
                        quota={quota}
                        name={privacy ? "Account" : account.name}
                      />
                    ))}
                </div>
              </TableCell>
              <TableCell className="pr-4 text-right">
                <AccountReset
                  account={account}
                  connection={connection}
                  onReset={onReset}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const windowHours = (label: string) => {
  if (label === "30d" || label === "Monthly") return 30 * 24;
  const match = /(\d+)([hd])$/.exec(label);
  return match ? Number(match[1]) * (match[2] === "d" ? 24 : 1) : null;
};

function QuotaRow({ quota, name }: { quota: Quota; name: string }) {
  const hourCycle = useHourCycle();
  const remaining = quota.remaining!;
  const hours = windowHours(quota.label);
  // Share of the window still ahead: what remains if usage were spread evenly.
  const pace =
    hours && quota.resetsAt
      ? Math.min(
          100,
          Math.max(
            0,
            ((Date.parse(quota.resetsAt) - Date.now()) / (hours * 3_600_000)) *
              100,
          ),
        )
      : null;
  const tone =
    remaining < 10 || (pace !== null && remaining < pace / 2)
      ? "destructive"
      : pace !== null
        ? remaining < pace - 10
          ? "warning"
          : null
        : remaining < 20
          ? "destructive"
          : remaining < 50
            ? "warning"
            : null;
  const reset = quota.resetsAt ? timeUntil(quota.resetsAt) : null;
  const label =
    quota.label === "7d"
      ? "Weekly"
      : quota.label === "30d"
        ? "Monthly"
        : quota.label;
  return (
    <>
      <span className="truncate text-xs text-muted-foreground" title={label}>
        {label}
      </span>
      <ProgressPrimitive.Root
        value={remaining}
        aria-label={`${name} ${quota.label} remaining`}
        title={
          pace === null
            ? undefined
            : `Even pace would leave ${Math.round(pace)}% now`
        }
        className="relative h-2.5"
      >
        <ProgressPrimitive.Track className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
          <ProgressPrimitive.Indicator
            className={cn(
              "h-full rounded-full transition-[width,background-color]",
              tone === "destructive"
                ? "bg-destructive"
                : tone === "warning"
                  ? "bg-warning"
                  : "bg-foreground/70",
            )}
          />
        </ProgressPrimitive.Track>
        {pace !== null && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_1.5px_var(--background)]"
            style={{ left: `${pace}%` }}
          />
        )}
      </ProgressPrimitive.Root>
      <span
        className={cn(
          "text-right text-xs font-medium tabular-nums",
          tone === "destructive"
            ? "text-destructive"
            : tone === "warning"
              ? "text-warning"
              : undefined,
        )}
      >
        {Math.round(remaining)}%
      </span>
      <span
        className="text-xs text-muted-foreground tabular-nums"
        title={
          quota.resetsAt
            ? new Date(quota.resetsAt).toLocaleString(undefined, { hourCycle })
            : undefined
        }
      >
        {reset?.startsWith("Resets in ") ? reset.slice(10) : reset && "Now"}
      </span>
    </>
  );
}

function AccountReset({
  account,
  connection,
  onReset,
}: {
  account: Account;
  connection: PublicConnection;
  onReset: (account: Account, creditId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const hourCycle = useHourCycle();
  const credit = account.resetCredits?.items
    ?.filter(
      (credit) =>
        credit.status === "available" &&
        (credit.resets_left ?? 1) > 0 &&
        (!credit.expires_at || Date.parse(credit.expires_at) > Date.now()),
    )
    .sort(
      (a, b) =>
        (a.expires_at ? Date.parse(a.expires_at) : Infinity) -
        (b.expires_at ? Date.parse(b.expires_at) : Infinity),
    )[0];
  if (!credit) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="xs"
        disabled={busy || !connection.enabled || account.status === "paused"}
        onClick={async () => {
          setBusy(true);
          try {
            await onReset(account, credit.id);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Icon icon={Refresh01Icon} data-icon="inline-start" />
        )}
        Use reset
      </Button>
      <span
        className="text-xs text-muted-foreground"
        title={
          credit.expires_at
            ? new Date(credit.expires_at).toLocaleString(undefined, {
                hourCycle,
              })
            : undefined
        }
      >
        {credit.expires_at
          ? timeUntil(credit.expires_at).replace(/^Resets/, "Expires")
          : "No expiry"}
      </span>
    </div>
  );
}

function AccountStatus({
  account,
  connection,
}: {
  account: Account;
  connection: PublicConnection;
}) {
  const status = account.status.toLowerCase();
  const active = ["active", "ready", "connected", "ok"].includes(status);
  const label = !connection.enabled
    ? "Paused"
    : connection.error
      ? "Sync error"
      : account.quotaError
        ? "Quota unavailable"
        : active
          ? null
          : sentenceCase(account.status);
  if (!label) return null;
  const warning =
    label === "Paused" ||
    label === "Quota unavailable" ||
    label.toLowerCase().includes("limit");
  return (
    <span
      className={cn("text-xs", warning ? "text-warning" : "text-destructive")}
    >
      {label}
    </span>
  );
}

export function PlanBadge({
  plan: raw,
  provider,
}: {
  plan: string;
  provider: Provider;
}) {
  const plan = raw.toLowerCase().replace(/[\s_-]+/g, "");
  const free = [
    "free",
    "freeworkspace",
    "claudefree",
    "defaultclaudefree",
  ].includes(plan);
  const tiers: Record<string, [string, number]> =
    provider === "codex"
      ? {
          plus: ["Plus", 1],
          team: ["Business", 1],
          business: ["Business", 1],
          prolite: ["Pro 100", 5],
          pro100: ["Pro 100", 5],
          pro: ["Pro 200", 10],
          pro200: ["Pro 200", 10],
          promax: ["Pro 500", 20],
          pro500: ["Pro 500", 20],
        }
      : {
          pro: ["Pro", 1],
          claudepro: ["Pro", 1],
          defaultclaudepro: ["Pro", 1],
          team: ["Team", 1],
          claudeteam: ["Team", 1],
          max5x: ["Max", 5],
          claudemax5x: ["Max", 5],
          defaultclaudemax5x: ["Max", 5],
          max20x: ["Max", 20],
          claudemax20x: ["Max", 20],
          defaultclaudemax20x: ["Max", 20],
        };
  const tier = tiers[plan];
  const label = free
    ? "Free"
    : tier
      ? `${tier[0]} · ${tier[1]}×`
      : sentenceCase(raw || "Unknown plan");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            tabIndex={0}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-xs text-muted-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {tier ? <span aria-hidden="true">{tier[1]}</span> : null}
        <Icon
          icon={
            free
              ? MoneyNotFound04Icon
              : tier
                ? MultiplicationSignIcon
                : CreditCardIcon
          }
          size={tier ? 12 : 16}
          aria-hidden="true"
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
