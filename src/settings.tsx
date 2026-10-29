import { useEffect, useState } from "react";
import type { Settings } from "./types";
import { api } from "./api";
import { Dialog, CopyButton, ErrorMessage } from "./ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export function DashboardSettings({
  settings,
  origin,
  onSaved,
  onClose,
}: {
  settings?: Settings;
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
