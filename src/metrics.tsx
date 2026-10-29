import { useState } from "react";
import { Area, AreaChart, XAxis } from "recharts";
import {
  providerNames,
  providers,
  type DailyUsage,
  type Tokens,
  type Cost,
  type Provider,
  type PublicConnection,
} from "./types";
import { ProviderIcon } from "./ui.tsx";
import { ResetTimeline } from "./timeline.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const compact = (n: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
export const money = (n: number, precision?: number) =>
  n > 0 && n < 0.0001
    ? "<$0.0001"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: precision ?? (n > 0 && n < 0.01 ? 4 : 2),
      }).format(n);
export function costLabel(c?: Cost) {
  if (!c?.priced) return "Unpriced";
  if (c.max - c.min <= 0.00001) return money(c.min);
  let low = money(c.min),
    high = money(c.max);
  if (low === high) {
    low = money(c.min, 4);
    high = money(c.max, 4);
  }
  return `${low} to ${high}`;
}
export const buckets = [
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "unclassified",
] as const;
const labels = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
  reasoning: "Reasoning",
  unclassified: "Unclassified",
};
const config: ChartConfig = Object.fromEntries(
  buckets.map((key, i) => [
    key,
    {
      label: labels[key],
      color: i < 5 ? `var(--chart-${i + 1})` : "var(--muted-foreground)",
    },
  ]),
);
const zeroTokens = (): Tokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  unclassified: 0,
  total: 0,
});
const periods = {
  today: "Today",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  year: "Year",
  all: "All time",
} as const;
type Period = keyof typeof periods;

function usageRows(
  period: Period,
  daily: Record<string, DailyUsage> = {},
  hourly: Record<string, DailyUsage> = {},
  include: (provider: string) => boolean = () => true,
) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today);
  const isHourly = period === "today";
  if (period === "all") {
    const first = Object.values(daily ?? {})
      .map((v) => v.day)
      .filter((day) => day <= today.toISOString().slice(0, 10))
      .sort()[0];
    if (first) start.setTime(new Date(first).getTime());
  } else if (!isHourly) {
    const days = period === "year" ? 365 : Number.parseInt(period);
    start.setUTCDate(start.getUTCDate() - days + 1);
  }
  const monthly =
    period === "year" || today.getTime() - start.getTime() >= 90 * 86400000;
  const key = (date: Date) =>
    date.toISOString().slice(0, isHourly ? 13 : monthly ? 7 : 10);
  const rows = new Map<
    string,
    {
      at: number;
      tokens: Tokens;
      cost: Record<(typeof buckets)[number], number>;
      min: number;
      max: number;
      unpriced: number;
      requests: number;
    }
  >();
  const end = isHourly ? new Date() : today;
  for (const date = new Date(start); date <= end;) {
    rows.set(key(date), {
      at: date.getTime(),
      tokens: zeroTokens(),
      cost: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        unclassified: 0,
      },
      min: 0,
      max: 0,
      unpriced: 0,
      requests: 0,
    });
    if (isHourly) date.setUTCHours(date.getUTCHours() + 1);
    else if (monthly) date.setUTCMonth(date.getUTCMonth() + 1, 1);
    else date.setUTCDate(date.getUTCDate() + 1);
  }
  for (const value of Object.values((isHourly ? hourly : daily) ?? {})) {
    if (!include(value.provider)) continue;
    const date = new Date(isHourly ? (value.hour ?? "") : value.day);
    if (Number.isNaN(date.getTime()) || date < start || date > end) continue;
    const row = rows.get(key(date));
    if (!row) continue;
    for (const k of [...buckets, "total"] as const)
      row.tokens[k] += value.tokens[k];
    for (const k of buckets)
      if (k !== "unclassified") row.cost[k] += value.cost[k];
    row.min += value.cost.min;
    row.max += value.cost.max;
    row.unpriced += value.unpriced;
    row.requests += value.requests;
  }
  return { rows: [...rows.values()], isHourly, monthly };
}

export function TokenBreakdown({ tokens }: { tokens: Tokens }) {
  return (
    <div className="flex min-w-48 flex-col gap-2">
      {buckets
        .filter((k) => tokens[k] > 0)
        .map((k, i) => (
          <div
            key={k}
            className="flex items-center justify-between gap-8 text-xs"
          >
            <span className="flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{
                  background:
                    i < 5 ? config[k].color : "var(--muted-foreground)",
                }}
              />
              {labels[k]}
            </span>
            <span className="tabular-nums">
              {tokens[k].toLocaleString()}{" "}
              <span className="text-muted-foreground">
                {tokens.total
                  ? Math.round((tokens[k] / tokens.total) * 100)
                  : 0}
                %
              </span>
            </span>
          </div>
        ))}
      <div className="flex justify-between gap-8 border-t pt-2 text-xs">
        <span>Total</span>
        <span className="tabular-nums">{tokens.total.toLocaleString()}</span>
      </div>
    </div>
  );
}
export function UsageMetrics({
  daily,
  hourly,
  connections,
}: {
  daily?: Record<string, DailyUsage>;
  hourly?: Record<string, DailyUsage>;
  connections: PublicConnection[];
}) {
  const [period, setPeriod] = useState<Period>("7d");
  const [selected, setSelected] = useState<Provider[]>([]);
  const connected = providers.filter((p) =>
    connections.some((c) => c.provider === p),
  );
  // No provider selected means no filter.
  const active = selected.filter((p) => connected.includes(p));
  const shown = (provider: string) =>
    !active.length || active.includes(provider as Provider);
  const { rows, isHourly, monthly } = usageRows(period, daily, hourly, shown);
  const scope = [periods[period], ...active.map((p) => providerNames[p])].join(
    " · ",
  );
  const dateLabel = (at: number, detailed = false) =>
    new Date(at).toLocaleString(undefined, {
      timeZone: "UTC",
      ...(isHourly
        ? { hour: "numeric" }
        : monthly
          ? { month: "short", ...(detailed ? { year: "numeric" } : {}) }
          : period === "7d" && !detailed
            ? { weekday: "short" }
            : { month: "short", day: "numeric" }),
    });
  const total = zeroTokens();
  let min = 0,
    max = 0,
    unpriced = 0,
    requests = 0;
  for (const r of rows) {
    for (const k of [...buckets, "total"] as const) total[k] += r.tokens[k];
    min += r.min;
    max += r.max;
    unpriced += r.unpriced;
    requests += r.requests;
  }
  const cost: Cost = {
    min,
    max,
    priced: true,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  };
  for (const r of rows)
    for (const k of buckets) if (k !== "unclassified") cost[k] += r.cost[k];
  return (
    <section
      aria-label="API usage summary"
      className="grid min-w-0 gap-3 sm:grid-cols-2"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:col-span-2">
        <ResetTimeline
          connections={connections.filter((c) => shown(c.provider))}
        />
        {connected.length > 1 && (
          <ToggleGroup
            aria-label="Providers"
            multiple
            value={active}
            onValueChange={(value) => setSelected(value as Provider[])}
            size="sm"
            spacing={0}
            className="rounded-full bg-muted/50 p-1"
          >
            {connected.map((provider) => (
              <ToggleGroupItem
                key={provider}
                value={provider}
                aria-label={providerNames[provider]}
                title={providerNames[provider]}
                className="w-8 px-0"
              >
                <ProviderIcon provider={provider} small />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <ToggleGroup
          aria-label="Usage period"
          value={[period]}
          onValueChange={(value) => {
            if (value[0]) setPeriod(value[0] as Period);
          }}
          size="sm"
          spacing={0}
          className="rounded-full bg-muted/50 p-1"
        >
          {Object.entries(periods).map(([value, label]) => (
            <ToggleGroupItem key={value} value={value}>
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {["tokens", "cost"].map((kind) => (
        <Card key={kind} size="sm" className="gap-2 py-3">
          <CardHeader>
            <CardTitle>
              {kind === "tokens" ? "Tokens" : "Estimated API cost"}{" "}
              <span className="text-muted-foreground">· {scope}</span>
            </CardTitle>
            <CardDescription>
              {kind === "tokens"
                ? `${compact(total.cacheRead)} cache read · ${total.total ? Math.round((total.cacheRead / total.total) * 100) : 0}% of tokens`
                : `USD${unpriced ? ` · ${unpriced} unpriced ${unpriced === 1 ? "request" : "requests"}` : ""}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="w-fit text-left font-heading text-3xl font-semibold tracking-tight tabular-nums"
                    aria-label={
                      kind === "tokens" ? "Token breakdown" : "Cost breakdown"
                    }
                  />
                }
              >
                {kind === "tokens"
                  ? compact(total.total)
                  : requests === 0
                    ? money(0)
                    : unpriced === requests
                      ? "Unpriced"
                      : `${costLabel(cost)}${unpriced ? " +" : ""}`}
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                {kind === "tokens" ? (
                  <TokenBreakdown tokens={total} />
                ) : (
                  <div className="flex max-w-80 flex-col gap-2">
                    <p>USD · API equivalent</p>
                    {buckets
                      .filter(
                        (k) =>
                          k !== "unclassified" &&
                          cost[k as Exclude<typeof k, "unclassified">] > 0,
                      )
                      .map((k) => (
                        <div key={k} className="flex justify-between gap-8">
                          <span>{labels[k]}</span>
                          <span>
                            {money(
                              cost[k as Exclude<typeof k, "unclassified">],
                            )}
                          </span>
                        </div>
                      ))}
                    {max > min && (
                      <p>Cache writes: short-to-long retention range</p>
                    )}
                    <p className="text-muted-foreground">
                      Prices · Oct 29, 2026
                    </p>
                    <div className="flex gap-3">
                      <a
                        className="underline"
                        href="https://developers.openai.com/api/docs/pricing"
                        target="_blank"
                        rel="noreferrer"
                      >
                        OpenAI prices
                      </a>
                      <a
                        className="underline"
                        href="https://platform.claude.com/docs/en/about-claude/pricing"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Claude prices
                      </a>
                    </div>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
            <ChartContainer config={config} className="h-28 w-full aspect-auto">
              <AreaChart
                data={rows.map((r) => ({
                  at: r.at,
                  ...r[kind === "tokens" ? "tokens" : "cost"],
                }))}
                margin={{ top: 6, right: 6, bottom: 0, left: 6 }}
              >
                <XAxis
                  dataKey="at"
                  tickFormatter={(at) => dateLabel(Number(at))}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        dateLabel(Number(payload[0]?.payload.at), true)
                      }
                      formatter={(value, name) => {
                        const k = name as keyof typeof labels;
                        return (
                          <div className="flex w-full justify-between gap-8">
                            <span>{labels[k]}</span>
                            <span className="font-mono">
                              {kind === "tokens"
                                ? compact(Number(value))
                                : money(Number(value))}
                            </span>
                          </div>
                        );
                      }}
                    />
                  }
                />
                {buckets
                  .filter((k) =>
                    rows.some(
                      (r) => r[kind === "tokens" ? "tokens" : "cost"][k] > 0,
                    ),
                  )
                  .map((k) => (
                    <Area
                      key={k}
                      dataKey={k}
                      stackId="total"
                      type="monotone"
                      stroke={`var(--color-${k})`}
                      strokeWidth={1.75}
                      fill={`var(--color-${k})`}
                      fillOpacity={0.15}
                      dot={rows.length === 1 ? { r: 3 } : false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                  ))}
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
