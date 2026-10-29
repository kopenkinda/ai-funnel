import { useId } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { providerNames, type Account, type PublicConnection } from "./types.ts";
import { timeUntil } from "./api.ts";
import { ErrorMessage, ProviderIcon } from "./ui.tsx";
import { AccountsTable } from "./accounts.tsx";
import { PrivateText } from "./privacy.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const formatPercent = (value: number) =>
  `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const windowName = (label: string) =>
  label === "5h"
    ? "5-hour usage"
    : label === "7d"
      ? "Weekly usage"
      : label === "30d" || label === "Monthly"
        ? "Monthly usage"
        : label.endsWith(" 7d")
          ? `${label.slice(0, -3)} weekly usage`
          : label.endsWith(" 5h")
            ? `${label.slice(0, -3)} 5-hour usage`
            : `${label} usage`;

export function UsageOverview({
  connections,
  onReconnect,
}: {
  connections: PublicConnection[];
  onReconnect: (connection: PublicConnection) => void;
}) {
  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-col gap-5">
        {[...new Set(connections.map((c) => c.provider))].map((provider) => {
          const providerConnections = connections.filter(
            (c) => c.provider === provider,
          );
          const accounts = providerConnections.flatMap((c) => c.accounts);
          const windows = [
            ...new Set(
              accounts.flatMap((a) =>
                a.quotas.filter((q) => q.remaining != null).map((q) => q.label),
              ),
            ),
          ];
          return (
            <section
              key={provider}
              aria-label={`${providerNames[provider]} usage`}
              className="flex min-w-0 flex-col gap-2"
            >
              <header className="flex flex-wrap items-center gap-2">
                <ProviderIcon provider={provider} small />
                <h2 className="text-sm font-medium">
                  {providerNames[provider]} usage
                </h2>
                {providerConnections.every((c) => !c.enabled) && (
                  <Badge variant="secondary">Paused</Badge>
                )}
                <BankedResets accounts={accounts} />
              </header>
              {providerConnections
                .filter((c) => c.error)
                .map((connection) => (
                  <div
                    key={connection.id}
                    className="flex flex-col items-start gap-2"
                  >
                    <ErrorMessage>{connection.error}</ErrorMessage>
                    {provider === "codex" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onReconnect(connection)}
                      >
                        Add account
                      </Button>
                    )}
                  </div>
                ))}
              {windows.length > 0 && (
                <div className="grid min-w-0 gap-3 sm:grid-cols-3">
                  {windows.map((label) => (
                    <QuotaCard key={label} label={label} accounts={accounts} />
                  ))}
                </div>
              )}
              <AccountsTable connections={providerConnections} />
            </section>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function BankedResets({ accounts }: { accounts: Account[] }) {
  const reporting = accounts.filter((account) => account.resetCredits != null);
  if (!reporting.length) return null;
  const available = reporting.reduce(
    (sum, account) => sum + account.resetCredits!.available,
    0,
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" tabIndex={0} />}>
        {available} banked {available === 1 ? "reset" : "resets"}
      </TooltipTrigger>
      <TooltipContent role="tooltip" side="bottom" align="start">
        <ul className="flex flex-col gap-2 py-1">
          {reporting.map((account) => (
            <li key={account.id} className="flex flex-col gap-0.5">
              <span>
                <PrivateText>{account.name}</PrivateText>
              </span>
              <span className="text-muted-foreground">
                {account.resetCredits!.available} banked
              </span>
              {account
                .resetCredits!.items?.filter(
                  (c) =>
                    c.status === "available" &&
                    new Date(c.expires_at).getTime() > Date.now(),
                )
                .map((credit) => (
                  <span key={credit.id} className="text-muted-foreground">
                    Use by {new Date(credit.expires_at).toLocaleString()}
                    {credit.attempt?.result === "nothing_to_reset"
                      ? " · Nothing to reset yet"
                      : credit.attempt?.error
                        ? " · Retry pending"
                        : ""}
                  </span>
                ))}
              {account.resetCredits!.error && (
                <span className="text-destructive">
                  {account.resetCredits!.error}
                </span>
              )}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function QuotaCard({
  label,
  accounts,
}: {
  label: string;
  accounts: Account[];
}) {
  const titleId = useId();
  const rows = accounts.map((account, index) => ({
    account,
    quota: account.quotas.find((q) => q.label === label),
    key: `account${index}`,
    color: `var(--chart-${(index % 5) + 1})`,
  }));
  const reporting = rows.filter((row) => row.quota?.remaining != null);
  if (!reporting.length) return null;
  const remaining =
    reporting.reduce((sum, row) => sum + row.quota!.remaining!, 0) /
    reporting.length;
  const used = 100 - remaining;
  const config: ChartConfig = {
    used: { label: "Used", color: "var(--quota-used)" },
  };
  const data: Record<string, string | number> = {
    window: label,
    used,
  };
  for (const row of reporting) {
    config[row.key] = { label: row.account.name, color: row.color };
    data[row.key] = row.quota!.remaining! / reporting.length;
  }
  const segments = [
    ...reporting
      .filter((row) => row.quota!.remaining! > 0)
      .map((row) => row.key),
    ...(used ? ["used"] : []),
  ];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="region"
            aria-label={windowName(label)}
            tabIndex={0}
            className="min-w-0 rounded-4xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <Card size="sm" className="gap-2 py-3">
          <CardHeader>
            <CardTitle>{windowName(label)}</CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
                {formatPercent(remaining)}
              </span>
              <span className="text-xs text-muted-foreground">remaining</span>
            </div>
            <ChartContainer
              config={config}
              className="h-2 w-full aspect-auto"
              aria-hidden="true"
            >
              <BarChart
                accessibilityLayer={false}
                data={[data]}
                layout="vertical"
                margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
                barSize={8}
              >
                <XAxis type="number" domain={[0, 100]} hide />
                <YAxis type="category" dataKey="window" hide />
                {segments.map((key, index) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="quota"
                    fill={`var(--color-${key})`}
                    isAnimationActive={false}
                    radius={[
                      index === 0 ? 4 : 0,
                      index === segments.length - 1 ? 4 : 0,
                      index === segments.length - 1 ? 4 : 0,
                      index === 0 ? 4 : 0,
                    ]}
                  />
                ))}
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </TooltipTrigger>
      <TooltipContent
        role="tooltip"
        side="bottom"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <div className="flex w-full flex-col gap-3 py-1">
          <p id={titleId} className="font-medium">
            {windowName(label)}
          </p>
          <ul aria-labelledby={titleId} className="flex flex-col gap-3">
            {reporting.map(({ account, quota, color, key }) => (
              <li key={key} className="flex min-w-0 items-start gap-2">
                <span
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{ background: color }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">
                    <PrivateText>{account.name}</PrivateText>
                  </span>
                  <span className="opacity-60">
                    {timeUntil(quota?.resetsAt ?? null)}
                  </span>
                </div>
                <span className="shrink-0 tabular-nums">
                  {formatPercent(quota!.remaining!)}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-current/15 pt-2 opacity-60">
            {`${formatPercent(used)} used · Average of ${reporting.length} reporting accounts`}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
