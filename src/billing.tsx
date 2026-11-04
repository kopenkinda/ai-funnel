import { useState, type FormEvent } from "react";
import type { Account, Billing, PublicConnection } from "./types.ts";
import { api } from "./api.ts";
import { ErrorMessage } from "./ui.tsx";
import { PrivateText } from "./privacy.tsx";
import { PlanBadge } from "./accounts.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const currencies = ["USD", "EUR", "GBP"];
const day = 24 * 60 * 60 * 1000;

// Repeats the anchor date each cycle, clamping to month end (Jan 31 -> Feb 28 -> Mar 31).
export function nextPayment(billing: Billing, from = new Date()): Date {
  const [y, m, d] = billing.anchor.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const step = billing.interval === "year" ? 12 : 1;
  const at = (i: number) => {
    const month = m - 1 + i * step;
    return new Date(y, month, Math.min(d, new Date(y, month + 1, 0).getDate()));
  };
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const months = (today.getFullYear() - y) * 12 + today.getMonth() - (m - 1);
  let i = Math.max(0, Math.floor(months / step));
  while (at(i) < today) i++;
  return at(i);
}

export const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    amount,
  );

// Sums per currency because Funnel has no exchange rates to convert with.
export function monthlyCost(accounts: Account[]) {
  const totals = new Map<string, number>();
  for (const { billing: b } of accounts) {
    if (!b) continue;
    const monthly = b.interval === "year" ? b.amount / 12 : b.amount;
    totals.set(b.currency, (totals.get(b.currency) ?? 0) + monthly);
  }
  return [...totals].map(([currency, amount]) => money(amount, currency));
}

function due(date: Date) {
  const days = Math.round(
    (date.getTime() - new Date(new Date().toDateString()).getTime()) / day,
  );
  const label = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() && {
      year: "numeric",
    }),
  });
  if (days === 0) return `${label}, today`;
  if (days === 1) return `${label}, tomorrow`;
  return `${label}, in ${days} days`;
}

export function AccountsPanel({
  connection: c,
  onSaved,
}: {
  connection: PublicConnection;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function patch(account: Account, body: object) {
    setBusy(account.id);
    setError("");
    try {
      await api(`/accounts/${encodeURIComponent(account.id)}`, "PATCH", body);
      await onSaved();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  }
  const upcoming = c.accounts
    .filter((a) => a.billing)
    .map((a) => ({ account: a, at: nextPayment(a.billing!) }))
    .sort((x, y) => x.at.getTime() - y.at.getTime())[0];
  const total = monthlyCost(c.accounts);
  const lastCurrency = c.accounts.find((a) => a.billing)?.billing!.currency;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col" aria-label="Manage accounts">
        {c.accounts.map((account) => {
          const paused = account.status === "paused";
          const b = account.billing;
          return (
            <div
              key={account.id}
              className="flex flex-col gap-3 border-b py-3 last:border-0"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      <PrivateText>{account.email || account.name}</PrivateText>
                    </span>
                    <PlanBadge
                      plan={account.planTier || account.plan}
                      provider={c.provider}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {paused && <span className="text-warning">Paused · </span>}
                    {b
                      ? `${money(b.amount, b.currency)} ${b.interval === "year" ? "yearly" : "monthly"} · next ${due(nextPayment(b))}`
                      : "No payment cycle"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {editing !== account.id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${b ? "Edit" : "Set"} payment for ${account.email || account.name}`}
                      onClick={() => {
                        setError("");
                        setEditing(account.id);
                      }}
                    >
                      {b ? "Edit payment" : "Set payment"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === account.id}
                    onClick={() => void patch(account, { enabled: paused })}
                  >
                    {paused ? "Resume" : "Pause"}
                  </Button>
                </div>
              </div>
              {editing === account.id && (
                <BillingForm
                  billing={b}
                  defaultCurrency={lastCurrency}
                  busy={busy === account.id}
                  onCancel={() => setEditing(null)}
                  onSave={async (billing) => {
                    if (await patch(account, { billing })) setEditing(null);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {upcoming && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-2xl bg-muted/40 px-4 py-3 text-sm">
          <span>
            <span className="text-muted-foreground">Next payment </span>
            <span className="font-medium">
              {money(
                upcoming.account.billing!.amount,
                upcoming.account.billing!.currency,
              )}
            </span>
            <span className="text-muted-foreground">
              {" "}
              on {due(upcoming.at)}
            </span>
          </span>
          <span>
            <span className="font-medium">{total.join(" + ")}</span>
            <span className="text-muted-foreground"> per month</span>
          </span>
        </div>
      )}
    </div>
  );
}

function BillingForm({
  billing,
  defaultCurrency = "USD",
  busy,
  onCancel,
  onSave,
}: {
  billing?: Billing;
  defaultCurrency?: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (billing: Billing | null) => Promise<void>;
}) {
  const [interval, setCycle] = useState(billing?.interval ?? "month");
  const [currency, setCurrency] = useState(
    billing?.currency ?? defaultCurrency,
  );
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void onSave({
      amount: Number(form.get("amount")),
      currency,
      interval,
      anchor: String(form.get("anchor")),
    });
  }
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-2xl border p-4"
    >
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="billing-amount">Amount</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="billing-amount"
              name="amount"
              type="number"
              min="0"
              step="0.01"
              required
              autoFocus
              defaultValue={billing?.amount}
              disabled={busy}
            />
            <Select
              value={currency}
              onValueChange={(v) => v && setCurrency(v)}
              disabled={busy}
            >
              <SelectTrigger aria-label="Currency" className="w-24 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...currencies, currency])].map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="billing-anchor">Payment date</FieldLabel>
          <Input
            id="billing-anchor"
            name="anchor"
            type="date"
            required
            defaultValue={billing?.anchor}
            disabled={busy}
          />
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel>Billed</FieldLabel>
          <ToggleGroup
            aria-label="Billing interval"
            value={[interval]}
            onValueChange={(v) => v[0] && setCycle(v[0] as typeof interval)}
            variant="outline"
            spacing={0}
            disabled={busy}
            className="w-full"
          >
            <ToggleGroupItem value="month" className="flex-1">
              Monthly
            </ToggleGroupItem>
            <ToggleGroupItem value="year" className="flex-1">
              Yearly
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>
      <p className="text-xs text-muted-foreground">
        Use your last or next charge date. Funnel repeats it every cycle.
      </p>
      <div className="flex items-center gap-2">
        {billing && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto text-destructive"
            disabled={busy}
            onClick={() => void onSave(null)}
          >
            Remove
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={billing ? "" : "ml-auto"}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
