import { HugeiconsIcon as Icon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Provider } from "../server/types.ts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProviderIcon({
  provider,
  small = false,
}: {
  provider: Provider;
  small?: boolean;
}) {
  const logo = provider === "zen" || provider === "go" ? "opencode" : provider;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        small ? "size-5" : "size-7",
      )}
    >
      {logo === "claude" ? (
        <img
          src="/providers/claude.svg"
          alt=""
          className="size-full object-contain"
        />
      ) : (
        <>
          <img
            src={`/providers/${logo}-light.svg`}
            alt=""
            className="size-full object-contain dark:hidden"
          />
          <img
            src={`/providers/${logo}-dark.svg`}
            alt=""
            className="hidden size-full object-contain dark:block"
          />
        </>
      )}
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  onError,
}: {
  value: string;
  label?: string;
  onError?: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      aria-label={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        } catch {
          onError?.(
            "Clipboard access failed. Select and copy the text instead.",
          );
        }
      }}
    >
      <Icon icon={copied ? Tick02Icon : Copy01Icon} data-icon="inline-start" />
      {copied ? "Copied" : label}
    </Button>
  );
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <Icon icon={AlertCircleIcon} />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function Dialog({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader className="pr-8">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </DialogRoot>
  );
}
