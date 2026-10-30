import { useEffect, useState, type ReactNode } from "react";
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
import { Dialog, CopyButton, ErrorMessage, ProviderIcon } from "./ui";
import { usePreferences } from "./preferences";
import { PrivateText } from "./privacy";
import { Button } from "@/components/ui/button";
import { FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
  const number = (
    field: "power" | "topK",
    label: string,
    description: string,
    text: string,
    setText: (text: string) => void,
    limits: { min: string; max: string; step: string },
  ) => (
    <Row
      id={`${provider}-routing-${field}`}
      label={label}
      description={description}
    >
      <Input
        id={`${provider}-routing-${field}`}
        type="number"
        {...limits}
        className="w-20 text-right tabular-nums"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onBlur={() =>
          Number(text) !== value[field] &&
          void save({ ...value, [field]: Number(text) })
        }
      />
    </Row>
  );
  return (
    <Section
      title={
        <>
          <ProviderIcon provider={provider} small />
          {name} routing
        </>
      }
    >
      {error && (
        <div className="p-4">
          <ErrorMessage>{error}</ErrorMessage>
        </div>
      )}
      <Row
        label="Strategy"
        description={`How requests choose a ${name} account.`}
      >
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
          <SelectTrigger size="sm" aria-label={`${name} routing strategy`}>
            <SelectValue>{routingStrategies[value.strategy]}</SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="end">
            <SelectGroup>
              {Object.entries(routingStrategies).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Row>
      {value.strategy === "single_account" && (
        <Row label="Account" description="Every request goes to this account.">
          <Select
            value={value.accountId ?? null}
            disabled={busy}
            onValueChange={(accountId) =>
              accountId && void save({ ...value, accountId })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label={`${name} routing account`}
              aria-invalid={
                !!value.accountId && (!account || account.status === "paused")
              }
              className="max-w-56"
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
            <SelectContent
              alignItemWithTrigger={false}
              align="end"
              className="w-max max-w-[min(24rem,var(--available-width))] min-w-(--anchor-width)"
            >
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
        </Row>
      )}
      {value.strategy === "relative_availability" && (
        <>
          {number(
            "power",
            "Weight exponent",
            "Higher values favor the accounts with the most quota left.",
            power,
            setPower,
            { min: "0.1", max: "10", step: "0.1" },
          )}
          {number(
            "topK",
            "Top accounts",
            "How many of the best accounts share the traffic.",
            topK,
            setTopK,
            { min: "1", max: "50", step: "1" },
          )}
        </>
      )}
      {value.strategy !== "single_account" && (
        <Row
          id={`${provider}-sticky`}
          label="Keep sessions on one account"
          description="Requests from the same session stay on the account they started on."
        >
          <Switch
            id={`${provider}-sticky`}
            checked={value.stickySessions}
            disabled={busy}
            onCheckedChange={(stickySessions) =>
              void save({ ...value, stickySessions })
            }
          />
        </Row>
      )}
      {resetStrategies.includes(value.strategy) && (
        <Row
          id={`${provider}-earlier-reset`}
          label="Prefer earlier reset"
          description="Uses accounts whose quota resets sooner first."
        >
          <div className="flex items-center gap-3">
            {value.preferEarlierReset && (
              <ToggleGroup
                aria-label={`${name} reset window`}
                variant="outline"
                size="sm"
                spacing={0}
                value={[value.resetWindow]}
                disabled={busy}
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
            )}
            <Switch
              id={`${provider}-earlier-reset`}
              checked={value.preferEarlierReset}
              disabled={busy}
              onCheckedChange={(preferEarlierReset) =>
                void save({ ...value, preferEarlierReset })
              }
            />
          </div>
        </Row>
      )}
    </Section>
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
      <div className="flex flex-col gap-5">
        <Section title="Resets">
          <Row
            id="auto-resets"
            label="Redeem expiring banked resets"
            description="Uses a banked reset 5 minutes before it expires, so it isn't lost."
          >
            <Switch
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
          </Row>
        </Section>
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
        <Section title="Display">
          <Row
            id="hour12"
            label="Use 12-hour clock"
            description={`Shows times as ${example(true)} instead of ${example(false)}. Saved in this browser.`}
          >
            <Switch id="hour12" checked={hour12} onCheckedChange={setHour12} />
          </Row>
        </Section>
        <Section title="Usage hub">
          <div className="flex flex-col gap-2 p-4">
            <FieldLabel htmlFor="hub-url">Hub URL</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="hub-url"
                aria-label="Hub URL"
                readOnly
                value={origin}
              />
              <CopyButton value={origin} />
            </div>
          </div>
          {key ? (
            <div className="flex flex-col gap-2 p-4">
              <FieldLabel htmlFor="hub-key">Management key</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="hub-key"
                  aria-label="Hub management key"
                  readOnly
                  type="password"
                  value={key}
                />
                <CopyButton value={key} />
              </div>
              <FieldDescription>
                Copy the key now. It isn't shown again.
              </FieldDescription>
            </div>
          ) : (
            <Row
              label="Management key"
              description={
                settings?.hasHubKey
                  ? "Replacing the key disconnects existing usage hubs until you update them."
                  : "Lets a usage hub, such as T3 Code's CLIProxyAPI hub, read usage from this dashboard."
              }
            >
              <Button
                variant="outline"
                size="sm"
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
            </Row>
          )}
        </Section>
      </div>
    </Dialog>
  );
}

const example = (hour12: boolean) =>
  new Date(2026, 0, 1, 14, 30).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: hour12 ? "h12" : "h23",
  });

function Section({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 px-1 text-sm font-medium">
        {title}
      </h3>
      <div className="flex flex-col divide-y rounded-2xl border">
        {children}
      </div>
    </section>
  );
}

function Row({
  id,
  label,
  description,
  children,
}: {
  id?: string;
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 p-4">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
        {id ? (
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
        ) : (
          <span className="text-sm font-medium">{label}</span>
        )}
        <FieldDescription>{description}</FieldDescription>
      </div>
      {children}
    </div>
  );
}
