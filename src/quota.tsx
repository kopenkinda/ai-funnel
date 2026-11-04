import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  LabelList,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "./api.ts";
import { useHourCycle } from "./preferences.ts";
import { providerNames, providers, type PublicConnection } from "./types.ts";
import { ErrorMessage, ProviderIcon } from "./ui.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// Each point is [unix seconds, remaining percent] of the account's longest
// account-wide window.
type History = Record<string, { label: string; points: [number, number][] }>;
interface Tracked {
  remaining: number;
  resetsAt: number | null;
  window: number;
  rate: number;
}
interface Row {
  at: number;
  recorded?: number;
  projected?: number;
  recordedJump?: string;
  projectedJump?: string;
}

const HOUR = 3_600_000;
const STEP = 15 * 60_000;
// The chart shows a week back and a week ahead.
const SPAN = 7 * 24 * HOUR;
const burnWindows = [1, 3, 6];

const windowLength = (label: string) => {
  const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(label);
  return m ? Number(m[1]) * (m[2] === "d" ? 24 : 1) * HOUR : 0;
};

// Before an account's first point, hold its first value so a newly added
// account does not read as a reset.
function valueAt(points: [number, number][], at: number) {
  let value = points[0][1];
  for (const [t, v] of points) {
    if (t * 1000 > at) break;
    value = v;
  }
  return value;
}

// Percent per hour. Only drops count; rises are resets, not usage.
function burnRate(points: [number, number][], now: number, hours: number) {
  const from = now - hours * HOUR;
  let used = 0;
  for (let i = 1; i < points.length; i++)
    if (points[i][0] * 1000 > from)
      used += Math.max(0, points[i - 1][1] - points[i][1]);
  const span = now - Math.max(from, points[0][0] * 1000);
  return span >= STEP ? used / (span / HOUR) : 0;
}

// Usage continues at the recent rate. Each account keeps its share of the
// drain; when one empties, routing moves its share to the others.
function project(accounts: Tracked[], now: number) {
  const state = accounts.map((a) => ({ ...a }));
  const total = state.reduce((sum, s) => sum + s.rate, 0);
  const rows: Row[] = [];
  let firstEmpty: number | null = null;
  let poolEmpty: number | null = null;
  let nextReset: { at: number; gained: number } | null = null;
  for (let at = now + STEP; at <= now + SPAN; at += STEP) {
    let gained = 0;
    for (const s of state)
      while (s.resetsAt !== null && s.window > 0 && s.resetsAt <= at) {
        gained += 100 - s.remaining;
        s.remaining = 100;
        s.resetsAt += s.window;
      }
    if (gained > 0) nextReset ??= { at, gained };
    const live = state.filter((s) => s.remaining > 0);
    const weight = live.reduce((sum, s) => sum + s.rate, 0);
    for (const s of live) {
      const share = weight ? s.rate / weight : 1 / live.length;
      s.remaining = Math.max(0, s.remaining - (total * share * STEP) / HOUR);
      if (s.remaining === 0) firstEmpty ??= at;
    }
    const pool = state.reduce((sum, s) => sum + s.remaining, 0);
    if (pool === 0 && live.length) poolEmpty ??= at;
    rows.push({ at, projected: pool });
  }
  return { rows, firstEmpty, poolEmpty, nextReset };
}

function poolChart(
  connection: PublicConnection,
  history: History,
  now: number,
  burnHours: number,
) {
  const tracked = connection.accounts.flatMap((account) => {
    const h = history[account.id];
    if (!h?.points.length) return [];
    const reset = account.quotas.find((q) => q.label === h.label)?.resetsAt;
    return [
      {
        points: h.points,
        remaining: h.points[h.points.length - 1][1],
        resetsAt: reset ? new Date(reset).getTime() : null,
        window: windowLength(h.label),
        rate: burnRate(h.points, now, burnHours),
      },
    ];
  });
  if (!tracked.length) return null;
  const earliest = Math.min(...tracked.map((t) => t.points[0][0] * 1000));
  const start = Math.floor(Math.max(now - SPAN, earliest) / STEP) * STEP;
  const rows: Row[] = [];
  for (let at = start; at < now; at += STEP)
    rows.push({
      at,
      recorded: tracked.reduce((sum, t) => sum + valueAt(t.points, at), 0),
    });
  const pool = tracked.reduce((sum, t) => sum + t.remaining, 0);
  rows.push({ at: now, recorded: pool, projected: pool });
  const { rows: projected, ...future } = project(tracked, now);
  rows.push(...projected);
  for (let i = 1; i < rows.length; i++) {
    const value = (r: Row) => r.recorded ?? r.projected ?? 0;
    const rise = value(rows[i]) - value(rows[i - 1]);
    if (rise >= 1)
      rows[i][
        rows[i].projected === undefined ? "recordedJump" : "projectedJump"
      ] = `+${Math.round(rise)}%`;
  }
  return {
    rows,
    start,
    pool,
    capacity: tracked.length * 100,
    burn: tracked.reduce((sum, t) => sum + t.rate, 0),
    ...future,
  };
}

export function QuotaManagement({
  connections,
}: {
  connections: PublicConnection[];
}) {
  const [data, setData] = useState<{ history: History; now: number } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [burnHours, setBurnHours] = useState(3);
  // The dashboard reloads connections after every refresh; follow it.
  useEffect(() => {
    api<History | null>("/quota-history")
      .then((history) => {
        setError("");
        setData({ history: history ?? {}, now: Date.now() });
      })
      .catch((e) => setError((e as Error).message));
  }, [connections]);
  if (error) return <ErrorMessage>{error}</ErrorMessage>;
  if (!data) return null;
  const cards = providers.flatMap((provider) => {
    const connection = connections.find((c) => c.provider === provider);
    const chart =
      connection && poolChart(connection, data.history, data.now, burnHours);
    return chart ? [{ connection, chart }] : [];
  });
  if (!cards.length)
    return (
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyTitle>No quota history yet</EmptyTitle>
          <EmptyDescription>
            Each account's weekly quota is recorded from its next refresh.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <section aria-label="Quota pools" className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-end gap-2 text-sm">
        <span className="text-muted-foreground">Burn rate</span>
        <ToggleGroup
          aria-label="Burn rate window"
          value={[String(burnHours)]}
          onValueChange={(value) => {
            if (value[0]) setBurnHours(Number(value[0]));
          }}
          size="sm"
          spacing={0}
          className="rounded-full bg-muted/50 p-1"
        >
          {burnWindows.map((hours) => (
            <ToggleGroupItem key={hours} value={String(hours)}>
              {hours}h
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {cards.map(({ connection, chart }) => (
        <PoolCard
          key={connection.id}
          connection={connection}
          chart={chart}
          now={data.now}
          burnHours={burnHours}
        />
      ))}
    </section>
  );
}

function PoolCard({
  connection,
  chart,
  now,
  burnHours,
}: {
  connection: PublicConnection;
  chart: NonNullable<ReturnType<typeof poolChart>>;
  now: number;
  burnHours: number;
}) {
  const hourCycle = useHourCycle();
  const color =
    connection.provider === "claude" ? "var(--chart-2)" : "var(--chart-1)";
  const config: ChartConfig = {
    recorded: { label: "Recorded", color },
    projected: { label: "Projected", color },
  };
  const end = now + SPAN;
  const when = (at: number) =>
    new Date(at).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hourCycle,
    });
  const notBy = `Not by ${new Date(end).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const ticks: number[] = [];
  for (const day = new Date(chart.start); day.getTime() <= end;) {
    day.setHours(24, 0, 0, 0);
    if (day.getTime() <= end) ticks.push(day.getTime());
  }
  const stats = [
    ["Pool empty", chart.poolEmpty ? when(chart.poolEmpty) : notBy],
    ["First account empty", chart.firstEmpty ? when(chart.firstEmpty) : notBy],
    [
      "Next reset",
      chart.nextReset
        ? `+${Math.round(chart.nextReset.gained)}% ${when(chart.nextReset.at)}`
        : "None this week",
    ],
    [`Burn, last ${burnHours}h`, `${chart.burn.toFixed(1)}%/h`],
  ];
  const accounts = chart.capacity / 100;
  return (
    <Card
      role="region"
      aria-label={`${providerNames[connection.provider]} quota pool`}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ProviderIcon provider={connection.provider} small />
          {providerNames[connection.provider]}
          <span className="font-normal text-muted-foreground">
            {accounts} {accounts === 1 ? "account" : "accounts"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <p className="font-heading text-5xl font-semibold tracking-tight tabular-nums">
            {Math.round(chart.pool)}%{" "}
            <span className="text-lg font-normal tracking-normal text-muted-foreground">
              of {chart.capacity}%
            </span>
          </p>
          <dl className="grid grid-cols-2 gap-x-10 gap-y-3 text-sm md:grid-cols-4">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        {/* Reset labels overlap on phone widths; the stats name the next one. */}
        <ChartContainer
          config={config}
          className="aspect-auto h-80 w-full max-sm:[&_.recharts-label-list]:hidden"
        >
          <ComposedChart
            data={chart.rows}
            margin={{ top: 28, right: 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="at"
              type="number"
              scale="time"
              domain={[chart.start, end]}
              ticks={ticks}
              tickFormatter={(at) => {
                const date = new Date(Number(at));
                return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.getDate()}`;
              }}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={16}
            />
            <YAxis
              domain={[0, chart.capacity]}
              ticks={[0, chart.capacity / 2, chart.capacity]}
              tickFormatter={(v) => `${v}%`}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    when(Number(payload[0]?.payload.at))
                  }
                  formatter={(value, name) => (
                    <div className="flex w-full justify-between gap-8">
                      <span>{config[name as keyof typeof config]?.label}</span>
                      <span className="font-mono">
                        {Math.round(Number(value))}%
                      </span>
                    </div>
                  )}
                />
              }
            />
            <ReferenceLine
              x={now}
              stroke="var(--muted-foreground)"
              strokeOpacity={0.5}
              label={{
                value: "Now",
                position: "top",
                fill: "var(--muted-foreground)",
                fontSize: 11,
              }}
            />
            <Area
              dataKey="recorded"
              type="linear"
              stroke="var(--color-recorded)"
              strokeWidth={2}
              fill="var(--color-recorded)"
              fillOpacity={0.15}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="recordedJump"
                position="top"
                fill="var(--muted-foreground)"
                fontSize={11}
              />
            </Area>
            <Area
              dataKey="projected"
              type="linear"
              stroke="var(--color-projected)"
              strokeWidth={2}
              strokeDasharray="5 4"
              fill="var(--color-projected)"
              fillOpacity={0.06}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="projectedJump"
                position="top"
                fill="var(--muted-foreground)"
                fontSize={11}
              />
            </Area>
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
