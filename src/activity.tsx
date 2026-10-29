import { useEffect, useState } from "react";
import { api } from "./api";
import type { RequestLog, PublicConnection, PublicKey } from "./types";
import { providerNames } from "./types";
import { PrivateText } from "./privacy";
import { Dialog, ErrorMessage } from "./ui";
import { compact, costLabel, TokenBreakdown } from "./metrics";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
} from "@/components/ui/select";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";

interface Result {
  items: RequestLog[];
  total: number;
  page: number;
  pages: number;
  models: string[];
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
export function ActivityLog({
  connections,
  keys,
  refreshId,
}: {
  connections: PublicConnection[];
  keys: PublicKey[];
  refreshId?: string;
}) {
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
  const controls = [
    {
      key: "provider",
      label: "Providers",
      options: connections.map((c) => ({
        value: c.provider,
        label: providerNames[c.provider],
      })),
    },
    {
      key: "account",
      label: "Accounts",
      options: accounts.map((a) => ({ value: a.id, label: a.name })),
    },
    {
      key: "key",
      label: "API keys",
      options: keys.map((k) => ({ value: k.id, label: k.name })),
    },
    {
      key: "model",
      label: "Models",
      options: result.models.map((m) => ({ value: m, label: m })),
    },
    {
      key: "transport",
      label: "Transports",
      options: ["HTTP", "SSE", "WS"].map((v) => ({ value: v, label: v })),
    },
    {
      key: "status",
      label: "Status",
      options: [
        { value: "ok", label: "Successful" },
        { value: "error", label: "Errors" },
      ],
    },
  ];
  function filter(key: string, value: string) {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  }
  return (
    <section aria-label="Request logs" className="flex min-w-0 flex-col gap-3">
      <Field>
        <FieldLabel className="sr-only" htmlFor="request-search">
          Search requests
        </FieldLabel>
        <Input
          id="request-search"
          placeholder="Search request ID, account, API key, model, error…"
          value={filters.q ?? ""}
          onChange={(e) => filter("q", e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        {controls.map((control) => (
          <Select
            key={control.key}
            value={filters[control.key] || "all"}
            onValueChange={(v) =>
              filter(control.key, v === "all" ? "" : (v ?? ""))
            }
          >
            <SelectTrigger size="sm" aria-label={control.label}>
              <SelectValue>
                <PrivateText>
                  {control.options.find((o) => o.value === filters[control.key])
                    ?.label ?? control.label}
                </PrivateText>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">
                  All {control.label.toLowerCase()}
                </SelectItem>
                {control.options
                  .filter(
                    (o, i, all) =>
                      all.findIndex((x) => x.value === o.value) === i,
                  )
                  .map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      <PrivateText>{o.label}</PrivateText>
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setFilters({});
            setPage(1);
          }}
        >
          Reset filters
        </Button>
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div
        className="min-w-0 overflow-hidden rounded-2xl border"
        aria-busy={loading}
      >
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "Time",
                "Account",
                "API key",
                "Model",
                "Transport",
                "Status",
                "TTFT",
                "Tokens / s",
                "Tokens",
                "Est. cost",
                "",
              ].map((h, i) => (
                <TableHead key={i}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="tabular-nums">
                  <p>{new Date(r.at).toLocaleTimeString()}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.at).toLocaleDateString()}
                  </p>
                </TableCell>
                <TableCell>
                  <p className="max-w-40 truncate">
                    <PrivateText>
                      {r.accountName ||
                        accounts.find((a) => a.id === r.accountId)?.name ||
                        connections.find((c) => c.id === r.connectionId)
                          ?.name ||
                        "Removed account"}
                    </PrivateText>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.plan || r.provider || "-"}
                  </p>
                </TableCell>
                <TableCell>
                  <p className="max-w-28 truncate">
                    <PrivateText>
                      {r.keyName ||
                        keys.find((k) => k.id === r.keyId)?.name ||
                        "Removed key"}
                    </PrivateText>
                  </p>
                </TableCell>
                <TableCell>
                  <p className="max-w-44 truncate">
                    {r.model || "Model discovery"}
                  </p>
                  {r.reasoning && (
                    <p className="text-xs text-muted-foreground">
                      {r.reasoning}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{r.transport || "HTTP"}</Badge>
                  {r.upstreamTransport && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Up {r.upstreamTransport}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={r.status >= 400 ? "destructive" : "secondary"}
                  >
                    {r.status >= 400 ? r.status : "OK"}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">
                  {duration(r.ttftMs)}
                </TableCell>
                <TableCell className="tabular-nums">{speed(r)}</TableCell>
                <TableCell className="tabular-nums">
                  {r.tokens ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={<button type="button" className="text-left" />}
                      >
                        {compact(r.tokens.total)}
                        {r.tokens.cacheRead > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {compact(r.tokens.cacheRead)} cached
                          </p>
                        )}
                      </TooltipTrigger>
                      <TooltipContent>
                        <TokenBreakdown tokens={r.tokens} />
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  <p className="max-w-32 whitespace-normal">
                    {r.tokens ? costLabel(r.cost) : "-"}
                  </p>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDetail(r)}
                  >
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            ))}
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>{result.total.toLocaleString()} requests</span>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={result.page <= 1 || loading}
              onClick={() => setPage(result.page - 1)}
            >
              Previous
            </Button>
            <span>
              {result.page} / {result.pages}
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
        </div>
      </div>
      {detail && (
        <Dialog title="Request details" onClose={() => setDetail(null)}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-xs">
            {[
              ["Request ID", detail.id],
              ["Time", new Date(detail.at).toLocaleString()],
              ["Account", detail.accountName || detail.accountId || "-"],
              ["Plan", detail.plan || "-"],
              ["Model", detail.model || "Model discovery"],
              ["Priced model", detail.cost?.model || "-"],
              ["Service tier", detail.cost?.tier || "default"],
              ["Transport", detail.transport || "HTTP"],
              ["Upstream", detail.upstreamTransport || "-"],
              ["Status", String(detail.status)],
              ["Duration", duration(detail.durationMs)],
              ["Time to first token", duration(detail.ttftMs)],
              ["Output tokens / s", speed(detail)],
              [
                "Estimated API cost",
                detail.tokens ? costLabel(detail.cost) : "-",
              ],
              ...(detail.errorCode ? [["Error", detail.errorCode]] : []),
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 wrap-anywhere">
                  <PrivateText>{v}</PrivateText>
                </dd>
              </div>
            ))}
          </dl>
          {detail.tokens && <TokenBreakdown tokens={detail.tokens} />}
          <FieldDescription>
            {detail.cost?.note}{" "}
            {detail.cost?.version &&
              `Prices verified ${detail.cost.version}.`}{" "}
          </FieldDescription>
        </Dialog>
      )}
    </section>
  );
}
