import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  LayoutTable01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { api } from "./api";
import type { RequestLog, PublicConnection, PublicKey } from "./types";
import { providerNames, providers, type Provider } from "./types";
import { PrivateText, usePrivacy } from "./privacy";
import { Dialog, ErrorMessage, ProviderIcon } from "./ui";
import { PlanBadge } from "./accounts";
import { compact, costLabel, money, TokenBreakdown } from "./metrics";
import {
  activityColumns,
  useHourCycle,
  usePreferences,
  type ActivityColumn,
} from "./preferences";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toggle, toggleVariants } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
} from "@/components/ui/select";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";

interface Result {
  items: RequestLog[];
  total: number;
  page: number;
  pages: number;
  models: string[];
}
interface Option {
  value: string;
  label: string;
  group?: string;
}
const duration = (ms?: number) =>
  !ms ? "-" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const speed = (r: RequestLog) =>
  r.tokens && r.durationMs > (r.ttftMs ?? 0)
    ? (
        (r.tokens.output + r.tokens.reasoning) /
        ((r.durationMs - (r.ttftMs ?? 0)) / 1000)
      ).toFixed(1)
    : "-";
// One figure for the table; the full range lives in the details dialog.
const costSummary = (r: RequestLog) =>
  !r.cost?.priced
    ? "Unpriced"
    : r.cost.max - r.cost.min <= 0.00001
      ? money(r.cost.min)
      : `≈${money((r.cost.min + r.cost.max) / 2)}`;
const dayLabel = (at: string) => {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
};

export function ActivityLog({
  connections,
  keys,
  refreshId,
}: {
  connections: PublicConnection[];
  keys: PublicKey[];
  refreshId?: string;
}) {
  const hourCycle = useHourCycle();
  const columns = usePreferences((state) => state.columns);
  const setColumns = usePreferences((state) => state.setColumns);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Result>({
    items: [],
    total: 0,
    page: 1,
    pages: 1,
    models: [],
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<RequestLog | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      const query = new URLSearchParams({ ...filters, page: String(page) });
      api<Result>(`/requests?${query}`)
        .then((r) => {
          if (active) {
            setResult(r);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filters, page, refreshId]);
  const accounts = connections.flatMap((c) => c.accounts);
  const connected = providers.filter((p) =>
    connections.some((c) => c.provider === p),
  );
  const show = (column: ActivityColumn) => columns.includes(column);
  function filter(key: string, value: string) {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  }
  const filtered = Object.entries(filters).some(([k, v]) => k !== "q" && v);
  const accountName = (r: RequestLog) =>
    r.accountName ||
    accounts.find((a) => a.id === r.accountId)?.name ||
    connections.find((c) => c.id === r.connectionId)?.name ||
    "Removed account";
  // The live account knows its current tier; the log keeps the plan at request time.
  const planOf = (r: RequestLog) => {
    const account = accounts.find((a) => a.id === r.accountId);
    return account?.planTier || account?.plan || r.plan || "";
  };
  const keyName = (r: RequestLog) =>
    r.keyName || keys.find((k) => k.id === r.keyId)?.name || "Removed key";
  const providerOf = (r: RequestLog) =>
    (r.provider ||
      connections.find((c) => c.id === r.connectionId)?.provider) as
      Provider | undefined;
  // Tokens, speed and cost collapse into one error cell on failed requests.
  const metricColumns = 2 + (show("speed") ? 1 : 0);
  const columnCount =
    4 + metricColumns + (show("key") ? 1 : 0) + (show("transport") ? 1 : 0);

  return (
    <section aria-label="Request logs" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Field className="w-full sm:w-72">
          <FieldLabel className="sr-only" htmlFor="request-search">
            Search requests
          </FieldLabel>
          <Input
            id="request-search"
            className="h-8"
            placeholder="Search ID, account, model, error"
            value={filters.q ?? ""}
            onChange={(e) => filter("q", e.target.value)}
          />
        </Field>
        {connected.length > 1 && (
          <ToggleGroup
            aria-label="Provider"
            value={filters.provider ? [filters.provider] : []}
            onValueChange={(value) => {
              const provider = value[0] ?? "";
              setPage(1);
              setFilters((f) => ({
                ...f,
                provider,
                // An account from the other provider would match nothing.
                account:
                  provider &&
                  !connections.some(
                    (c) =>
                      c.provider === provider &&
                      c.accounts.some((a) => a.id === f.account),
                  )
                    ? ""
                    : (f.account ?? ""),
              }));
            }}
            size="sm"
            spacing={0}
            className="rounded-full bg-muted/50 p-0.5"
          >
            {connected.map((provider) => (
              <ToggleGroupItem
                key={provider}
                value={provider}
                aria-label={providerNames[provider]}
                title={providerNames[provider]}
                className="h-7 w-7 min-w-7 px-0"
              >
                <ProviderIcon provider={provider} small />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <FilterSelect
          label="Account"
          value={filters.account}
          onChange={(v) => filter("account", v)}
          options={connections
            .filter((c) => !filters.provider || c.provider === filters.provider)
            .flatMap((c) =>
              c.accounts.map((a) => ({
                value: a.id,
                label: a.email || a.name,
                group: providerNames[c.provider],
              })),
            )}
        />
        {show("key") && (
          <FilterSelect
            label="API key"
            value={filters.key}
            onChange={(v) => filter("key", v)}
            options={[
              ...keys.filter((k) => !k.archivedAt),
              ...keys.filter((k) => k.archivedAt),
            ].map((k) => ({
              value: k.id,
              label: k.name,
              group: k.archivedAt ? "Archived" : "Active",
            }))}
          />
        )}
        <FilterSelect
          label="Model"
          value={filters.model}
          onChange={(v) => filter("model", v)}
          options={result.models.map((m) => ({ value: m, label: m }))}
        />
        {show("transport") && (
          <FilterSelect
            label="Transport"
            value={filters.transport}
            onChange={(v) => filter("transport", v)}
            options={["HTTP", "SSE", "WS"].map((v) => ({ value: v, label: v }))}
          />
        )}
        <Toggle
          size="sm"
          className="text-muted-foreground aria-pressed:bg-destructive/15 aria-pressed:text-destructive"
          pressed={filters.status === "error"}
          onPressedChange={(pressed) =>
            filter("status", pressed ? "error" : "")
          }
        >
          Errors only
        </Toggle>
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilters((f) => ({ q: f.q ?? "" }));
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        )}
        <Menu.Root modal={false}>
          <Menu.Trigger
            className={cn(
              toggleVariants({ size: "sm" }),
              "ml-auto gap-1.5 text-muted-foreground data-popup-open:bg-muted",
            )}
          >
            <Icon icon={LayoutTable01Icon} size={16} />
            Columns
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              side="bottom"
              align="end"
              sideOffset={6}
              className="isolate z-50"
            >
              <Menu.Popup className="min-w-40 origin-(--transform-origin) rounded-3xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 dark:ring-foreground/10">
                {(Object.keys(activityColumns) as ActivityColumn[]).map(
                  (column) => (
                    <Menu.CheckboxItem
                      key={column}
                      checked={show(column)}
                      onCheckedChange={(checked) => {
                        setColumns(
                          checked
                            ? [...columns, column]
                            : columns.filter((c) => c !== column),
                        );
                        if (!checked && column !== "speed") filter(column, "");
                      }}
                      className="relative flex cursor-default items-center rounded-2xl py-2 pr-8 pl-3 text-sm font-medium outline-none select-none data-highlighted:bg-foreground/10"
                    >
                      {activityColumns[column]}
                      <Menu.CheckboxItemIndicator className="absolute right-2.5 flex">
                        <Icon icon={Tick02Icon} size={16} />
                      </Menu.CheckboxItemIndicator>
                    </Menu.CheckboxItem>
                  ),
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div
        className="min-w-0 overflow-hidden rounded-2xl border"
        aria-busy={loading}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Time</TableHead>
              <TableHead>Account</TableHead>
              {show("key") && <TableHead>API key</TableHead>}
              <TableHead>Model</TableHead>
              {show("transport") && <TableHead>Transport</TableHead>}
              <TableHead className="text-right">Tokens</TableHead>
              {show("speed") && (
                <TableHead className="text-right">Speed</TableHead>
              )}
              <TableHead className="text-right">Est. cost</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.map((r, index) => {
              const day = dayLabel(r.at);
              const failed = r.status >= 400;
              const provider = providerOf(r);
              return (
                <Fragment key={r.id}>
                  {(index === 0 ||
                    dayLabel(result.items[index - 1]!.at) !== day) && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={columnCount}
                        className="bg-muted/30 py-1.5 text-xs font-medium text-muted-foreground"
                      >
                        {day}
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setDetail(r)}
                  >
                    <TableCell className="text-muted-foreground tabular-nums">
                      {new Date(r.at).toLocaleTimeString(undefined, {
                        hourCycle,
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {provider && <ProviderIcon provider={provider} small />}
                        <p className="max-w-48 truncate">
                          <PrivateText>{accountName(r)}</PrivateText>
                        </p>
                        {provider && planOf(r) && (
                          <PlanBadge plan={planOf(r)} provider={provider} />
                        )}
                      </div>
                    </TableCell>
                    {show("key") && (
                      <TableCell>
                        <p className="max-w-32 truncate">
                          <PrivateText>{keyName(r)}</PrivateText>
                        </p>
                      </TableCell>
                    )}
                    <TableCell>
                      <p className="max-w-48 truncate">
                        {r.model || "Model discovery"}
                      </p>
                      {r.reasoning && (
                        <p className="text-xs text-muted-foreground">
                          {r.reasoning} reasoning
                        </p>
                      )}
                    </TableCell>
                    {show("transport") && (
                      <TableCell>
                        <p>{r.transport || "HTTP"}</p>
                        {r.upstreamTransport && (
                          <p className="text-xs text-muted-foreground">
                            Upstream {r.upstreamTransport}
                          </p>
                        )}
                      </TableCell>
                    )}
                    {failed ? (
                      <TableCell colSpan={metricColumns} className="text-right">
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {r.errorCode?.replaceAll("_", " ")}
                          </span>
                          <Badge variant="destructive">{r.status}</Badge>
                        </span>
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="text-right tabular-nums">
                          <p>{r.tokens ? compact(r.tokens.total) : "-"}</p>
                          {!!r.tokens?.cacheRead && (
                            <p className="text-xs text-muted-foreground">
                              {compact(r.tokens.cacheRead)} cached
                            </p>
                          )}
                        </TableCell>
                        {show("speed") && (
                          <TableCell className="text-right tabular-nums">
                            <p>{duration(r.ttftMs)}</p>
                            {speed(r) !== "-" && (
                              <p className="text-xs text-muted-foreground">
                                {speed(r)} tok/s
                              </p>
                            )}
                          </TableCell>
                        )}
                        <TableCell
                          className="text-right tabular-nums"
                          title={r.tokens ? costLabel(r.cost) : undefined}
                        >
                          {r.tokens ? costSummary(r) : "-"}
                        </TableCell>
                      </>
                    )}
                    <TableCell className="pr-2">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Details"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetail(r);
                        }}
                      >
                        <Icon icon={ArrowRight01Icon} />
                      </Button>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
        {!result.items.length && (
          <Empty className="min-h-52">
            <EmptyHeader>
              <EmptyTitle>
                {loading ? "Loading requests" : "No matching requests"}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>{result.total.toLocaleString()} requests</span>
          {result.pages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={result.page <= 1 || loading}
                onClick={() => setPage(result.page - 1)}
              >
                Previous
              </Button>
              <span className="px-1 tabular-nums">
                Page {result.page} of {result.pages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={result.page >= result.pages || loading}
                onClick={() => setPage(result.page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      </div>
      {detail && (
        <RequestDetails
          request={detail}
          account={accountName(detail)}
          apiKey={keyName(detail)}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  const privacy = usePrivacy((state) => state.enabled);
  const unique = options.filter(
    (o, i, all) => all.findIndex((x) => x.value === o.value) === i,
  );
  const groups = [...new Set(unique.map((o) => o.group))];
  const selected = unique.find((o) => o.value === value);
  const item = (o: Option) => (
    <SelectItem
      key={o.value}
      value={o.value}
      // Only names long enough to hit the menu's max width get a hover title.
      title={
        o.label.length < 40 || (privacy && o.label.includes("@"))
          ? undefined
          : o.label
      }
      className="*:first:min-w-0 *:first:shrink"
    >
      <span className="truncate">
        <PrivateText>{o.label}</PrivateText>
      </span>
    </SelectItem>
  );
  return (
    <Select
      value={value || "all"}
      onValueChange={(v) => onChange(v === "all" ? "" : (v ?? ""))}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn(
          "max-w-56",
          selected
            ? "bg-foreground/10 text-foreground"
            : "bg-transparent text-muted-foreground hover:bg-muted",
        )}
      >
        <SelectValue>
          {selected ? (
            <span className="truncate">
              <PrivateText>{selected.label}</PrivateText>
            </span>
          ) : (
            label
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="w-max max-w-[min(24rem,var(--available-width))] min-w-(--anchor-width)"
      >
        <SelectGroup>
          <SelectItem value="all">
            Any {label === "API key" ? label : label.toLowerCase()}
          </SelectItem>
        </SelectGroup>
        {groups.map((group) => (
          <SelectGroup key={group ?? ""}>
            {group && groups.length > 1 && <SelectLabel>{group}</SelectLabel>}
            {unique.filter((o) => o.group === group).map(item)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function RequestDetails({
  request: r,
  account,
  apiKey,
  onClose,
}: {
  request: RequestLog;
  account: string;
  apiKey: string;
  onClose: () => void;
}) {
  const hourCycle = useHourCycle();
  const sections: [string, [string, ReactNode][]][] = [
    [
      "Request",
      [
        ["ID", r.id],
        ["Time", new Date(r.at).toLocaleString(undefined, { hourCycle })],
        [
          "Status",
          r.status >= 400
            ? `${r.status}${r.errorCode ? ` ${r.errorCode}` : ""}`
            : `${r.status} OK`,
        ],
      ],
    ],
    [
      "Routing",
      [
        ["Account", account],
        ["Plan", r.plan || "-"],
        ["API key", apiKey],
        [
          "Transport",
          `${r.transport || "HTTP"}${r.upstreamTransport ? `, upstream ${r.upstreamTransport}` : ""}`,
        ],
      ],
    ],
    [
      "Model",
      [
        ["Requested", r.model || "Model discovery"],
        ["Priced as", r.cost?.model || "-"],
        ["Reasoning", r.reasoning || "-"],
        ["Service tier", r.cost?.tier || "default"],
      ],
    ],
    [
      "Performance",
      [
        ["Duration", duration(r.durationMs)],
        ["Time to first token", duration(r.ttftMs)],
        ["Output speed", speed(r) === "-" ? "-" : `${speed(r)} tok/s`],
        ["Estimated API cost", r.tokens ? costLabel(r.cost) : "-"],
      ],
    ],
  ];
  return (
    <Dialog title="Request details" onClose={onClose}>
      <div className="flex flex-col gap-4 text-xs">
        {sections.map(([title, rows]) => (
          <section key={title} className="flex flex-col gap-1.5">
            <h3 className="font-medium">{title}</h3>
            <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 wrap-anywhere">
                    {typeof v === "string" ? <PrivateText>{v}</PrivateText> : v}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        {r.tokens && (
          <section className="flex flex-col gap-1.5">
            <h3 className="font-medium">Tokens</h3>
            <TokenBreakdown tokens={r.tokens} />
          </section>
        )}
      </div>
      {(r.cost?.note || r.cost?.version) && (
        <FieldDescription>
          {r.cost?.note}{" "}
          {r.cost?.version && `Prices verified ${r.cost.version}.`}
        </FieldDescription>
      )}
    </Dialog>
  );
}
