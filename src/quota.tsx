import { useEffect, useState } from "react";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  LabelList,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "./api.ts";
import { useHourCycle } from "./preferences.ts";
import {
  providerNames,
  providers,
  type Provider,
  type PublicConnection,
} from "./types.ts";
import { ErrorMessage, ProviderIcon } from "./ui.tsx";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// Each point is [unix seconds, remaining percent]. The top-level series is the
// account's longest account-wide window; scopes are model windows like "Fable 7d".
interface Series {
  label: string;
  points: [number, number][];
}
type History = Record<string, Series & { scopes?: Series[] }>;
interface Tracked {
  points: [number, number][];
  // Usage up to each point, so any window's usage is one subtraction.
  used: number[];
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
type View = "remaining" | "drain";
interface Options {
  now: number;
  burnHours: number;
  usage: number;
  start: number;
  end: number;
  view: View;
}

const HOUR = 3_600_000;
const STEP = 15 * 60_000;
// Stats look at least a week ahead, whatever range the chart shows.
const HORIZON = 7 * 24 * HOUR;
const burnWindows = [1, 3, 6];
const futureUsage = [
  ["0", "None"],
  ["0.5", "Half of now"],
  ["1", "Same as now"],
  ["2", "Double now"],
] as const;

const windowLength = (label: string) => {
  const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(label.split(" ").at(-1)!);
  return m ? Number(m[1]) * (m[2] === "d" ? 24 : 1) * HOUR : 0;
};
const scopeOf = (label: string) =>
  label.slice(0, label.lastIndexOf(" ") + 1).trim();
// Accounts without a limit for the scope are bound by their account-wide one.
const seriesFor = (h: History[string], scope: string) =>
  (scope && h.scopes?.find((s) => scopeOf(s.label) === scope)) || h;

// The chart shows two weeks from Monday; `offset` moves it by whole weeks.
function range(now: number, offset: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7) + offset * 7);
  const start = day.getTime();
  day.setDate(day.getDate() + 14);
  return { start, end: day.getTime() };
}

// Index of the last point at or before `at`, or -1.
function indexAt(points: [number, number][], at: number) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] * 1000 <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// Before an account's first point, hold its first value so a newly added
// account does not read as a reset.
const valueAt = (t: Tracked, at: number) =>
  t.points[Math.max(0, indexAt(t.points, at))][1];

// Percent per hour. Only drops count; rises are resets, not usage.
function burnRate(t: Tracked, at: number, hours: number) {
  const from = at - hours * HOUR;
  const span = at - Math.max(from, t.points[0][0] * 1000);
  const usedAt = (x: number) => t.used[indexAt(t.points, x)] ?? 0;
  return span >= STEP ? (usedAt(at) - usedAt(from)) / (span / HOUR) : 0;
}

function track(
  connection: PublicConnection,
  history: History,
  scope: string,
  now: number,
  burnHours: number,
) {
  return connection.accounts.flatMap((account): Tracked[] => {
    // Routing skips these accounts, so their quota is not capacity.
    if (account.status === "paused" || account.status === "signed_out")
      return [];
    const h = history[account.id];
    if (!h?.points.length) return [];
    const { label, points } = seriesFor(h, scope);
    const used = [0];
    for (let i = 1; i < points.length; i++)
      used.push(used[i - 1] + Math.max(0, points[i - 1][1] - points[i][1]));
    const reset = account.quotas.find((q) => q.label === label)?.resetsAt;
    const tracked: Tracked = {
      points,
      used,
      remaining: points[points.length - 1][1],
      resetsAt: reset ? new Date(reset).getTime() : null,
      window: windowLength(label),
      rate: 0,
    };
    tracked.rate = burnRate(tracked, now, burnHours);
    return [tracked];
  });
}

// Usage continues at the recent rate, scaled by `usage`. Each account keeps
// its share of the drain; when one empties, routing moves its share to the
// others.
function project(
  accounts: Tracked[],
  now: number,
  until: number,
  usage: number,
) {
  const state = accounts.map((a) => ({ ...a }));
  const total = usage * state.reduce((sum, s) => sum + s.rate, 0);
  const rows: { at: number; remaining: number; drain: number }[] = [];
  let firstEmpty: number | null = null;
  let poolEmpty: number | null = null;
  let nextReset: { at: number; gained: number } | null = null;
  for (let at = now + STEP; at <= until; at += STEP) {
    let gained = 0;
    for (const s of state)
      while (s.resetsAt !== null && s.window > 0 && s.resetsAt <= at) {
        gained += 100 - s.remaining;
        s.remaining = 100;
        s.resetsAt += s.window;
      }
    if (gained > 0) nextReset ??= { at, gained };
    const step = (total * STEP) / HOUR;
    let need = step;
    let live = state.filter((s) => s.remaining > 0);
    const wasLive = live.length > 0;
    // An account that empties mid-step passes what it could not cover on.
    while (need > 0 && live.length) {
      const weight = live.reduce((sum, s) => sum + s.rate, 0);
      let left = 0;
      for (const s of live) {
        const take = need * (weight ? s.rate / weight : 1 / live.length);
        const got = Math.min(take, s.remaining);
        s.remaining -= got;
        left += take - got;
        if (s.remaining === 0) firstEmpty ??= at;
      }
      need = left;
      live = live.filter((s) => s.remaining > 0);
    }
    const pool = state.reduce((sum, s) => sum + s.remaining, 0);
    if (pool === 0 && wasLive) poolEmpty ??= at;
    rows.push({ at, remaining: pool, drain: (step - need) / (STEP / HOUR) });
  }
  return { rows, firstEmpty, poolEmpty, nextReset };
}

function poolChart(tracked: Tracked[], o: Options) {
  if (!tracked.length) return null;
  const pool = tracked.reduce((sum, t) => sum + t.remaining, 0);
  const burn = tracked.reduce((sum, t) => sum + t.rate, 0);
  const recorded = (at: number) =>
    tracked.reduce(
      (sum, t) =>
        sum +
        (o.view === "drain" ? burnRate(t, at, o.burnHours) : valueAt(t, at)),
      0,
    );
  const earliest = Math.min(...tracked.map((t) => t.points[0][0] * 1000));
  const rows: Row[] = [];
  const first = Math.floor(Math.max(o.start, earliest) / STEP) * STEP;
  for (let at = first; at < Math.min(o.now, o.end); at += STEP)
    rows.push({ at, recorded: recorded(at) });
  if (o.now >= o.start && o.now <= o.end) {
    const value = o.view === "drain" ? burn : pool;
    rows.push({ at: o.now, recorded: value, projected: value });
  }
  const until = Math.max(o.end, o.now + HORIZON);
  const { rows: future, ...stats } = project(tracked, o.now, until, o.usage);
  for (const r of future)
    if (r.at >= o.start && r.at <= o.end)
      rows.push({
        at: r.at,
        projected: o.view === "drain" ? r.drain : r.remaining,
      });
  if (o.view === "remaining")
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
    pool,
    capacity: tracked.length * 100,
    burn,
    until,
    ...stats,
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
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [view, setView] = useState<View>("remaining");
  const [burnHours, setBurnHours] = useState(3);
  const [usage, setUsage] = useState("1");
  const [offset, setOffset] = useState(0);
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
  const pools = providers.flatMap((p) => {
    const connection = connections.find((c) => c.provider === p);
    return connection &&
      track(connection, data.history, "", data.now, burnHours).length
      ? [connection]
      : [];
  });
  if (!pools.length)
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
  const { start, end } = range(data.now, offset);
  const oldest = Math.min(
    ...Object.values(data.history).flatMap((h) =>
      h.points.length ? [h.points[0][0] * 1000] : [],
    ),
  );
  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  // A refresh can remove the selected provider's pool; show all instead.
  const filtered = pools.filter((c) => c.provider === provider);
  const shown = filtered.length ? filtered : pools;
  const selected = filtered.length ? provider : "all";
  const count = (list: PublicConnection[]) =>
    list.reduce((sum, c) => sum + c.accounts.length, 0);
  return (
    <section aria-label="Quota pools" className="flex min-w-0 flex-col gap-4">
      {pools.length > 1 && (
        <ToggleGroup
          aria-label="Provider"
          value={[selected]}
          onValueChange={(value) => {
            if (value[0]) setProvider(value[0] as Provider | "all");
          }}
          size="sm"
          spacing={0}
          className="w-fit rounded-full bg-muted/50 p-1"
        >
          <ToggleGroupItem value="all">
            All
            <span className="text-muted-foreground tabular-nums">
              {count(pools)}
            </span>
          </ToggleGroupItem>
          {pools.map((c) => (
            <ToggleGroupItem key={c.provider} value={c.provider}>
              <ProviderIcon provider={c.provider} className="size-3.5" />
              {providerNames[c.provider]}
              <span className="text-muted-foreground tabular-nums">
                {count([c])}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <ToggleGroup
          aria-label="Chart"
          value={[view]}
          onValueChange={(value) => {
            if (value[0]) setView(value[0] as View);
          }}
          size="sm"
          spacing={0}
          className="rounded-full bg-muted/50 p-1"
        >
          <ToggleGroupItem value="remaining">Remaining</ToggleGroupItem>
          <ToggleGroupItem value="drain">Drain rate</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2">
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
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Future usage</span>
          <Select
            value={usage}
            onValueChange={(value) => value && setUsage(value)}
          >
            <SelectTrigger size="sm" aria-label="Future usage">
              <SelectValue>
                {futureUsage.find(([value]) => value === usage)?.[1]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {futureUsage.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1 sm:ml-auto">
          <span className="mr-2 text-muted-foreground tabular-nums">
            {day(start)} to {day(end - HOUR)}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Earlier week"
            disabled={start <= oldest}
            onClick={() => setOffset(offset - 1)}
          >
            <Icon icon={ArrowLeft01Icon} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(0)}
          >
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Later week"
            disabled={start > data.now}
            onClick={() => setOffset(offset + 1)}
          >
            <Icon icon={ArrowRight01Icon} />
          </Button>
        </div>
      </div>
      {shown.map((connection) => (
        <PoolCard
          key={connection.id}
          connection={connection}
          history={data.history}
          options={{
            now: data.now,
            burnHours,
            usage: Number(usage),
            start,
            end,
            view,
          }}
        />
      ))}
    </section>
  );
}

function PoolCard({
  connection,
  history,
  options,
}: {
  connection: PublicConnection;
  history: History;
  options: Options;
}) {
  const hourCycle = useHourCycle();
  const [selected, setSelected] = useState("");
  const { now, burnHours, start, end, view } = options;
  const scopes = [
    ...new Set(
      connection.accounts.flatMap(
        (a) => history[a.id]?.scopes?.map((s) => scopeOf(s.label)) ?? [],
      ),
    ),
  ].sort();
  const scope = scopes.includes(selected) ? selected : "";
  const chart = poolChart(
    track(connection, history, scope, now, burnHours),
    options,
  );
  if (!chart) return null;
  const color =
    connection.provider === "claude" ? "var(--chart-2)" : "var(--chart-1)";
  const config: ChartConfig = {
    recorded: { label: "Recorded", color },
    projected: { label: "Projected", color },
  };
  const format = (v: number) =>
    view === "drain" ? `${v.toFixed(1)}%/h` : `${Math.round(v)}%`;
  const when = (at: number) =>
    new Date(at).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hourCycle,
    });
  const notBy = `Not by ${new Date(chart.until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const ticks: number[] = [];
  for (const day = new Date(start); day.getTime() < end;) {
    ticks.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
  const stats = [
    ["Pool empty", chart.poolEmpty ? when(chart.poolEmpty) : notBy],
    ["First account empty", chart.firstEmpty ? when(chart.firstEmpty) : notBy],
    [
      "Next reset",
      chart.nextReset
        ? `+${Math.round(chart.nextReset.gained)}% ${when(chart.nextReset.at)}`
        : `None by ${new Date(chart.until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
    ],
    [`Burn, last ${burnHours}h`, `${chart.burn.toFixed(1)}%/h`],
  ];
  const accounts = chart.capacity / 100;
  const empty =
    view === "remaining" &&
    chart.poolEmpty !== null &&
    chart.poolEmpty >= start &&
    chart.poolEmpty <= end
      ? chart.poolEmpty
      : null;
  const poolOf = (s: string) =>
    track(connection, history, s, now, burnHours).reduce(
      (sum, t) => sum + t.remaining,
      0,
    );
  return (
    <Card
      role="region"
      aria-label={`${providerNames[connection.provider]} quota pool`}
    >
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <ProviderIcon provider={connection.provider} small />
          {providerNames[connection.provider]}
          <span className="font-normal text-muted-foreground">
            {accounts} {accounts === 1 ? "account" : "accounts"}
          </span>
        </CardTitle>
        {scopes.length > 0 && (
          <ToggleGroup
            aria-label={`${providerNames[connection.provider]} model`}
            value={[scope]}
            onValueChange={(value) => setSelected(value[0] ?? scope)}
            size="sm"
            spacing={0}
            className="rounded-full bg-muted/50 p-1"
          >
            {["", ...scopes].map((s) => (
              <ToggleGroupItem key={s} value={s}>
                {s || "All models"}
                <span className="text-muted-foreground tabular-nums">
                  {Math.round(poolOf(s))}%
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
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
              domain={[start, end]}
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
            {view === "remaining" ? (
              <YAxis
                domain={[0, chart.capacity]}
                ticks={[0, chart.capacity / 2, chart.capacity]}
                tickFormatter={(v) => `${v}%`}
                tickLine={false}
                axisLine={false}
                width={48}
              />
            ) : (
              <YAxis
                domain={[0, "auto"]}
                tickFormatter={(v) => `${v}%/h`}
                tickLine={false}
                axisLine={false}
                width={56}
              />
            )}
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    when(Number(payload[0]?.payload.at))
                  }
                  formatter={(value, name) => (
                    <div className="flex w-full justify-between gap-8">
                      <span>{config[name as keyof typeof config]?.label}</span>
                      <span className="font-mono">{format(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            {now >= start && now <= end && (
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
            )}
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
            {empty !== null && (
              <ReferenceDot
                x={empty}
                y={0}
                r={5}
                fill="var(--background)"
                stroke="var(--foreground)"
                strokeWidth={2}
                label={{
                  value: `Empty ${when(empty)}`,
                  position: "top",
                  fill: "var(--foreground)",
                  fontSize: 12,
                }}
              />
            )}
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
