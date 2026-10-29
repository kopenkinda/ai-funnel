import { HugeiconsIcon as Icon } from "@hugeicons/react";
import { ArrowUpRight01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import {
  providerNames,
  type Account,
  type PublicConnection,
} from "../server/types.ts";
import { timeUntil } from "./api.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
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
}: {
  connections: PublicConnection[];
}) {
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
        className="min-w-[740px]"
      >
        <TableHeader>
          <TableRow className="[&>th]:h-9">
            <TableHead className="w-[32%]">Account</TableHead>
            <TableHead className="w-[15%]">Status</TableHead>
            <TableHead className="w-[12%]">Plan</TableHead>
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
                  <span className="font-medium" title={account.name}>
                    {account.email || account.name}
                  </span>
                  <span
                    className="text-xs text-muted-foreground"
                    title={account.id}
                  >
                    ID{" "}
                    {account.id.length > 18
                      ? `${account.id.slice(0, 8)}…${account.id.slice(-6)}`
                      : account.id}
                    {connections.length > 1 && ` · ${connection.name}`}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <AccountStatus account={account} connection={connection} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {account.plan ? sentenceCase(account.plan) : "-"}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1.5">
                  {account.quotas
                    .filter((q) => q.remaining !== null)
                    .map((quota, index) => (
                      <div
                        key={`${quota.label}/${index}`}
                        className="grid grid-cols-[2.75rem_2.5rem_3rem_1fr] items-center gap-2"
                      >
                        <span className="text-xs text-muted-foreground">
                          {quota.label === "7d"
                            ? "Weekly"
                            : quota.label === "30d"
                              ? "Monthly"
                              : quota.label}
                        </span>
                        <span className="text-right text-xs tabular-nums">
                          {Math.round(quota.remaining!)}%
                        </span>
                        <Progress
                          className="[&_[data-slot=progress-track]]:h-1.5"
                          value={quota.remaining!}
                          tone={
                            quota.remaining! < 20
                              ? "destructive"
                              : quota.remaining! < 80
                                ? "warning"
                                : "success"
                          }
                          aria-label={`${account.name} ${quota.label} remaining`}
                        />
                        {quota.resetsAt && (
                          <span
                            className="flex items-center gap-1.5 text-xs text-muted-foreground"
                            title={new Date(quota.resetsAt).toLocaleString()}
                          >
                            <Icon icon={Clock01Icon} size={14} />
                            {timeUntil(quota.resetsAt).replace(/^Resets /, "")}
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              </TableCell>
              <TableCell className="pr-4 text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Open provider for ${account.email || account.name}`}
                  title="Open provider dashboard"
                  nativeButton={false}
                  render={
                    <a href={connection.url} target="_blank" rel="noreferrer" />
                  }
                >
                  <Icon icon={ArrowUpRight01Icon} />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
  const active = ["active", "ready", "connected", "ok"].includes(
    account.status.toLowerCase(),
  );
  const label = !connection.enabled
    ? "Paused"
    : connection.error
      ? "Sync error"
      : active
        ? "Active"
        : sentenceCase(account.status);
  const variant = !connection.enabled
    ? "secondary"
    : connection.error
      ? "destructive"
      : active
        ? "success"
        : account.status.includes("limit")
          ? "warning"
          : "secondary";
  return (
    <Badge variant={variant}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
