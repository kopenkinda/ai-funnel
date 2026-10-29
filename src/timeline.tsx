import { Fragment, useEffect, useState } from "react";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  Calendar03Icon,
  Calendar04Icon,
  Clock01Icon,
  TimerResetIcon,
} from "@hugeicons/core-free-icons";
import {
  providerNames,
  providers,
  type Provider,
  type PublicConnection,
} from "./types.ts";
import { PrivateText } from "./privacy.tsx";
import { ProviderIcon } from "./ui.tsx";
import { usePreferences } from "./preferences.ts";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const HOUR = 3_600_000;
const BEFORE = 2 * HOUR;
const SPAN = 24 * HOUR;
// Events closer than this share one marker.
const MERGE = 20 * 60_000;

type Kind = "5h" | "weekly" | "monthly" | "banked";
const kinds: Record<
  Kind,
  { name: string; icon: typeof Clock01Icon; color: string }
> = {
  "5h": { name: "5-hour reset", icon: Clock01Icon, color: "text-foreground" },
  weekly: { name: "Weekly reset", icon: Calendar03Icon, color: "text-chart-1" },
  monthly: {
    name: "Monthly reset",
    icon: Calendar04Icon,
    color: "text-chart-4",
  },
  banked: {
    name: "Banked reset expires",
    icon: TimerResetIcon,
    color: "text-warning",
  },
};

const kindOf = (label: string): Kind | null =>
  label === "5h" || label.endsWith(" 5h")
    ? "5h"
    : label === "7d" || label.endsWith(" 7d")
      ? "weekly"
      : label === "30d" || label === "Monthly"
        ? "monthly"
        : null;

interface Event {
  kind: Kind;
  at: number;
  who: { provider: Provider; account: string; detail: string }[];
}

function events(connections: PublicConnection[], start: number, end: number) {
  const raw: {
    kind: Kind;
    at: number;
    provider: Provider;
    account: string;
    detail: string;
  }[] = [];
  for (const connection of connections)
    for (const account of connection.accounts) {
      const name = account.email || account.name;
      const provider = providerNames[connection.provider];
      for (const quota of account.quotas) {
        const kind = kindOf(quota.label);
        const at = quota.resetsAt ? Date.parse(quota.resetsAt) : NaN;
        if (kind && at >= start && at <= end)
          raw.push({
            kind,
            at,
            provider: connection.provider,
            account: name,
            detail:
              `${provider} ${quota.label.replace(/^(5h|7d|30d|Monthly)$| (5h|7d)$/, "")}`.trim(),
          });
      }
      for (const credit of account.resetCredits?.items ?? []) {
        const at = credit.expires_at ? Date.parse(credit.expires_at) : NaN;
        if (
          credit.status === "available" &&
          (credit.resets_left ?? 1) > 0 &&
          at >= start &&
          at <= end
        )
          raw.push({
            kind: "banked",
            at,
            provider: connection.provider,
            account: name,
            detail: provider,
          });
      }
    }
  const merged: Event[] = [];
  for (const item of raw.sort((a, b) => a.at - b.at)) {
    const last = merged.findLast(
      (e) => e.kind === item.kind && item.at - e.at <= MERGE,
    );
    const who = {
      provider: item.provider,
      account: item.account,
      detail: item.detail,
    };
    if (last) last.who.push(who);
    else merged.push({ kind: item.kind, at: item.at, who: [who] });
  }
  return merged;
}

const clock = (at: number, hour12: boolean, minutes = true) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: hour12 ? "numeric" : "2-digit",
    // 24-hour ticks keep minutes so "18" isn't read as a count.
    ...(minutes || !hour12 ? { minute: "2-digit" } : {}),
    hourCycle: hour12 ? "h12" : "h23",
  });

export function ResetTimeline({
  connections,
}: {
  connections: PublicConnection[];
}) {
  const hour12 = usePreferences((state) => state.hour12);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const start = now - BEFORE;
  const end = start + SPAN;
  const x = (at: number) => `${((at - start) / SPAN) * 100}%`;
  const hours: number[] = [];
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  for (let at = first.getTime() + HOUR; at < end; at += HOUR) hours.push(at);
  const list = events(connections, start, end);

  return (
    <div
      role="group"
      aria-label="Resets in the next 22 hours"
      className="relative h-10 min-w-0 flex-1 basis-full overflow-hidden rounded-full bg-muted/50 sm:basis-0"
    >
      <div className="absolute inset-x-4 inset-y-0">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 -left-4 bg-background/50"
          style={{ width: `calc(${x(now)} + 1rem)` }}
        />
        {hours.map((at) => {
          const label = new Date(at).getHours() % 6 === 0;
          return (
            <div
              key={at}
              aria-hidden="true"
              className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center"
              style={{ left: x(at) }}
            >
              {label && (
                <span className="mb-0.5 text-[10px] leading-none text-muted-foreground tabular-nums">
                  {clock(at, hour12, false)}
                </span>
              )}
              <span
                className={cn("w-px bg-foreground/15", label ? "h-1.5" : "h-1")}
              />
            </div>
          );
        })}
        <div
          aria-hidden="true"
          className="absolute inset-y-1.5 w-px -translate-x-1/2 bg-foreground/60"
          style={{ left: x(now) }}
        />
        {list.map((event) => {
          const { name, icon, color } = kinds[event.kind];
          const count = event.who.length;
          const sources = providers.filter((p) =>
            event.who.some((who) => who.provider === p),
          );
          return (
            <Fragment key={`${event.kind}/${event.at}`}>
              <div
                aria-hidden="true"
                className={cn(
                  "absolute top-5 bottom-0 w-px -translate-x-1/2 bg-current opacity-60",
                  color,
                )}
                style={{ left: x(event.at) }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${name} at ${clock(event.at, hour12)}, ${count} ${count === 1 ? "account" : "accounts"}`}
                      className="absolute top-[11px] flex h-4.5 -translate-1/2 items-center gap-1 rounded-full bg-background py-0.5 pr-1.5 pl-1 shadow-[0_0_0_1px_var(--color-border)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      style={{ left: x(event.at) }}
                    />
                  }
                >
                  <span className="flex gap-0.5">
                    {sources.map((provider) => (
                      <ProviderIcon
                        key={provider}
                        provider={provider}
                        className="size-3.5"
                      />
                    ))}
                  </span>
                  <Icon
                    icon={icon}
                    strokeWidth={2}
                    className={cn("size-3", color)}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex flex-col gap-1.5 py-1">
                    <p className="flex items-center gap-2 font-medium">
                      <Icon
                        icon={icon}
                        strokeWidth={2}
                        className={cn("size-3.5", color)}
                      />
                      {name} at {clock(event.at, hour12)}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {event.who.map((who, index) => (
                        <li key={index} className="flex justify-between gap-6">
                          <span className="flex items-center gap-1.5">
                            <ProviderIcon
                              provider={who.provider}
                              className="size-3.5"
                            />
                            <PrivateText>{who.account}</PrivateText>
                          </span>
                          <span className="text-muted-foreground">
                            {who.detail}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </TooltipContent>
              </Tooltip>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
