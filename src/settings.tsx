import { useEffect, useState } from "react";
import {
  providerNames,
  providers,
  routingStrategies,
  type Account,
  type Provider,
  type PublicConnection,
  type Routing,
  type RoutingStrategy,
  type Settings,
} from "./types";
import { api } from "./api";
import { Dialog, CopyButton, ErrorMessage } from "./ui";
import { usePreferences } from "./preferences";
import { PrivateText } from "./privacy";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const resetStrategies: RoutingStrategy[] = [
  "capacity_weighted",
  "usage_weighted",
  "fill_first",
];

function RoutingSettings({
  provider,
  routing,
  accounts,
  onSaved,
}: {
  provider: Provider;
  routing: Routing;
  accounts: Account[];
  onSaved: () => Promise<void>;
}) {
  const name = providerNames[provider];
  const saved = JSON.stringify(routing);
  const [value, setValue] = useState(routing);
  const [power, setPower] = useState(String(routing.power));
  const [topK, setTopK] = useState(String(routing.topK));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const next: Routing = JSON.parse(saved);
    setValue(next);
    setPower(String(next.power));
    setTopK(String(next.topK));
  }, [saved]);
  async function save(next: Routing) {
    setValue(next);
    setError("");
    // Single-account routing is saved once an account is chosen.
    if (next.strategy === "single_account" && !next.accountId) return;
    setBusy(true);
    try {
      await api(`/routing/${provider}`, "PUT", next);
      await onSaved();
    } catch (e) {
      setValue(JSON.parse(saved));
      setPower(String(routing.power));
      setTopK(String(routing.topK));
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const account = accounts.find((a) => a.id === value.accountId);
  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label" className="mb-0">
        {name} routing
      </FieldLegend>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="flex flex-wrap gap-2">
        <Select
          value={value.strategy}
          disabled={busy}
          onValueChange={(strategy) =>
            strategy &&
            void save({
              ...value,
              strategy,
              accountId:
                strategy === "single_account" ? value.accountId : undefined,
            })
          }
        >
          <SelectTrigger aria-label={`${name} routing strategy`}>
            <SelectValue>{routingStrategies[value.strategy]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {Object.entries(routingStrategies).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {value.strategy === "single_account" && (
          <Select
            value={value.accountId ?? null}
            disabled={busy}
            onValueChange={(accountId) =>
              accountId && void save({ ...value, accountId })
            }
          >
            <SelectTrigger
              aria-label={`${name} routing account`}
              aria-invalid={
                !!value.accountId && (!account || account.status === "paused")
              }
              className="max-w-64"
            >
              <SelectValue>
                {account ? (
                  <span className="truncate">
                    <PrivateText>{account.name}</PrivateText>
                  </span>
                ) : value.accountId ? (
                  "Unavailable account"
                ) : (
                  "Select account"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {accounts.map((a) => (
                  <SelectItem
                    key={a.id}
                    value={a.id}
                    disabled={a.status === "paused"}
                  >
                    <span className="truncate">
                      <PrivateText>{a.name}</PrivateText>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>
      {value.strategy === "relative_availability" && (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor={`${provider}-routing-power`}>
              Weight exponent
            </FieldLabel>
            <Input
              id={`${provider}-routing-power`}
              type="number"
              min="0.1"
              max="10"
              step="0.1"
              value={power}
              disabled={busy}
              onChange={(e) => setPower(e.target.value)}
              onBlur={() =>
                Number(power) !== value.power &&
                void save({ ...value, power: Number(power) })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${provider}-routing-top-k`}>
              Top accounts
            </FieldLabel>
            <Input
              id={`${provider}-routing-top-k`}
              type="number"
              min="1"
              max="50"
              step="1"
              value={topK}
              disabled={busy}
              onChange={(e) => setTopK(e.target.value)}
              onBlur={() =>
                Number(topK) !== value.topK &&
                void save({ ...value, topK: Number(topK) })
              }
            />
          </Field>
        </div>
      )}
      {value.strategy !== "single_account" && (
        <Field orientation="horizontal">
          <Checkbox
            id={`${provider}-sticky`}
            checked={value.stickySessions}
            disabled={busy}
            onCheckedChange={(stickySessions) =>
              void save({ ...value, stickySessions })
            }
          />
          <FieldLabel htmlFor={`${provider}-sticky`}>
            Keep sessions on one account
          </FieldLabel>
        </Field>
      )}
      {resetStrategies.includes(value.strategy) && (
        <Field orientation="horizontal">
          <Checkbox
            id={`${provider}-earlier-reset`}
            checked={value.preferEarlierReset}
            disabled={busy}
            onCheckedChange={(preferEarlierReset) =>
              void save({ ...value, preferEarlierReset })
            }
          />
          <FieldLabel htmlFor={`${provider}-earlier-reset`}>
            Prefer earlier reset
          </FieldLabel>
          <ToggleGroup
            aria-label={`${name} reset window`}
            variant="outline"
            size="sm"
            spacing={0}
            value={[value.resetWindow]}
            disabled={busy || !value.preferEarlierReset}
            onValueChange={([resetWindow]) =>
              resetWindow &&
              void save({
                ...value,
                resetWindow: resetWindow as Routing["resetWindow"],
              })
            }
          >
            <ToggleGroupItem value="primary">5h</ToggleGroupItem>
            <ToggleGroupItem value="secondary">Weekly</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}
    </FieldSet>
  );
}

export function DashboardSettings({
  settings,
  connections,
  origin,
  onSaved,
  onClose,
}: {
  settings?: Settings;
  connections: PublicConnection[];
  origin: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [auto, setAuto] = useState(settings?.autoUseResets ?? false);
  useEffect(
    () => setAuto(settings?.autoUseResets ?? false),
    [settings?.autoUseResets],
  );
  const hour12 = usePreferences((state) => state.hour12);
  const setHour12 = usePreferences((state) => state.setHour12);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Settings" onClose={onClose}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <FieldGroup>
        <Field>
          <FieldLabel>Use expiring banked resets</FieldLabel>
          <div className="flex items-start gap-3">
            <Checkbox
              id="auto-resets"
              checked={auto}
              disabled={busy}
              onCheckedChange={(checked) => {
                setAuto(checked);
                void run(async () => {
                  try {
                    await api("/settings", "PATCH", { autoUseResets: checked });
                  } catch (e) {
                    setAuto(!checked);
                    throw e;
                  }
                });
              }}
            />
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="auto-resets">
                Automatically redeem 5 minutes before expiry
              </FieldLabel>
            </div>
          </div>
        </Field>
        <Separator />
        {settings?.routing &&
          providers.map((provider) => (
            <RoutingSettings
              key={provider}
              provider={provider}
              routing={settings.routing![provider]}
              accounts={
                connections.find((c) => c.provider === provider)?.accounts ?? []
              }
              onSaved={onSaved}
            />
          ))}
        <Separator />
        <Field>
          <FieldLabel>Time format</FieldLabel>
          <div className="flex items-start gap-3">
            <Checkbox
              id="hour12"
              checked={hour12}
              onCheckedChange={setHour12}
            />
            <FieldLabel htmlFor="hour12">Use 12-hour time</FieldLabel>
          </div>
        </Field>
        <Separator />
        <Field>
          <FieldLabel>T3 Code usage hub</FieldLabel>

          <div className="flex gap-2">
            <Input aria-label="Hub URL" readOnly value={origin} />
            <CopyButton value={origin} />
          </div>
        </Field>
        <Field>
          <FieldLabel>Management key</FieldLabel>
          {key ? (
            <>
              <div className="flex gap-2">
                <Input
                  aria-label="Hub management key"
                  readOnly
                  type="password"
                  value={key}
                />
                <CopyButton value={key} />
              </div>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setKey(
                      (await api<{ token: string }>("/hub-token", "POST"))
                        .token,
                    );
                  })
                }
              >
                {settings?.hasHubKey ? "Replace hub key" : "Generate hub key"}
              </Button>
              {settings?.hasHubKey && (
                <FieldDescription>
                  Replacing the key disconnects existing usage hubs until you
                  update them.
                </FieldDescription>
              )}
            </>
          )}
        </Field>
      </FieldGroup>
    </Dialog>
  );
}
